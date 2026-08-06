// ═════════════════════════════════════════════════════════════════════════════
// Scorecard template resolution
// ─────────────────────────────────────────────────────────────────────────────
// Attaching a scorecard template is OPTIONAL when scheduling an interview, but
// everything downstream treats it as mandatory:
//
//   * myScorecard() hydrates the rateable skills from the interview's template.
//     No template → `skills: []` → the panellist is shown nothing to rate.
//   * saveMyScorecard() only accepts ratings whose skillId belongs to that
//     template (a deliberate server-side allowlist, so a panellist cannot forge
//     a skill or its weight). No template → the allowlist is empty → every
//     rating is rejected 422 "Unknown skillId for this scorecard".
//   * submitMyScorecard() refuses a card with zero ratings, 422 "Rate at least
//     one skill before submitting".
//
// So an interview scheduled without a template can NEVER be scored: the
// interviewer hits a 422 that blames them for a choice the recruiter made
// upstream, interviewScore never computes, and the candidate sits in the merit
// list's "pending" bucket for good.
//
// The allowlist is correct and stays. The bug is the missing template, so this
// resolves one instead: the interview's own → any active template with skills →
// a seeded built-in. It seeds REAL rows rather than synthetic ids because the
// allowlist, the (scorecardId, skillId) unique key and the weight snapshots all
// key off genuine ScorecardSkill records.
// ═════════════════════════════════════════════════════════════════════════════

const prisma = require('../../../core/lib/prisma');

const BUILT_IN_NAME = 'General Interview';

// Role-agnostic and deliberately short — this is the floor that keeps the funnel
// moving, not a substitute for a considered per-role template. Equal weights: we
// have no basis to rank these for an unknown role.
const BUILT_IN_SKILLS = [
  { name: 'Communication', description: 'Clarity, listening, and structuring an answer.', sortOrder: 0 },
  { name: 'Role knowledge', description: 'Depth in the craft the role actually calls for.', sortOrder: 1 },
  { name: 'Problem solving', description: 'Breaking down an unfamiliar problem and reasoning to an answer.', sortOrder: 2 },
  { name: 'Ownership', description: 'Follow-through, and how they handle work going wrong.', sortOrder: 3 },
  { name: 'Values fit', description: 'How they work with others, against this org\'s stated values.', sortOrder: 4 },
];

// Any active template that actually HAS skills. A template with none is as dead
// an end as no template at all, so it does not count as a resolution.
async function firstUsableTemplate(db, businessId) {
  const tpl = await db.scorecardTemplate.findFirst({
    where: { businessId, isActive: true, deletedAt: null, skills: { some: {} } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return tpl ? tpl.id : null;
}

async function seedBuiltIn(db, businessId) {
  // Re-check by name first: two panellists opening their cards at the same moment
  // would otherwise each seed a copy.
  const existing = await db.scorecardTemplate.findFirst({
    where: { businessId, name: BUILT_IN_NAME, deletedAt: null },
    select: { id: true },
  });
  if (existing) return existing.id;

  const tpl = await db.scorecardTemplate.create({
    data: {
      businessId,
      name: BUILT_IN_NAME,
      description: 'Created automatically so interviews scheduled without a template can still be scored. Edit it, or attach your own template when scheduling.',
      skills: { create: BUILT_IN_SKILLS.map((s) => ({ businessId, ...s })) },
    },
    select: { id: true },
  });
  return tpl.id;
}

// Returns a templateId that is guaranteed to have rateable skills, or null if
// even seeding failed (callers must stay non-fatal — a scorecard template is
// never worth failing an interview booking over).
async function resolveScorecardTemplateId(db, businessId, preferredId) {
  try {
    if (preferredId) {
      const ok = await db.scorecardTemplate.findFirst({
        where: { id: preferredId, businessId, deletedAt: null },
        select: { id: true },
      });
      if (ok) return ok.id;
    }
    const usable = await firstUsableTemplate(db, businessId);
    if (usable) return usable;
    return await seedBuiltIn(db, businessId);
  } catch (e) {
    console.error(`[scorecard] could not resolve a template for business ${businessId}: ${e.message}`);
    return null;
  }
}

module.exports = {
  resolveScorecardTemplateId,
  _internals: { BUILT_IN_NAME, BUILT_IN_SKILLS, firstUsableTemplate, seedBuiltIn },
};
