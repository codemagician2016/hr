'use strict';

/**
 * onboarding.service.js — transactional glue between the recruitment offer flow
 * and the (pure) journey engine (Feature 4 §4.1, §8 slice 4a).
 *
 * `seedOnboardingJourney(offer, tx)` is invoked INSIDE the `acceptOffer`
 * transaction (recruitment.controller.acceptOffer). It mints a NOT_STARTED
 * onboarding LifecycleJourney from the tenant's default IN/NZ onboarding
 * template, snapshots the template's task defs into LifecycleTasks (via the pure
 * `journeyEngine.seedJourneyTasks`), stamps the anchors (offerAcceptedAt +
 * joinDate = offer.joiningDate), and allocates the journey code from
 * NumberSequence(ONBOARD).
 *
 * IDEMPOTENT: a journey already exists for this offer → return it (no-op). The
 * partial unique `onb_one_active_per_offer` is the DB backstop; we also pre-check
 * to avoid a wasted insert/abort cycle.
 */

const { seedJourneyTasks, advanceJourney } = require('./journeyEngine');
const { getDefaultOnboardingTemplate, seedOnboardingTemplates } = require('./templates/seed');
const { allocateCode } = require('./lib/codes');
// Feature 14: onboarding template selection follows the TENANT country (single
// source of truth), not `job.countryCode || 'IN'`.
const { tenantCountry } = require('../tenant/countryContext');

/**
 * seedOnboardingJourney(offer, tx, { hydratedOffer? } = {}) -> { journey, created }
 *   offer       — the accepted Offer row (must carry id, businessId, applicationId, joiningDate)
 *   tx          — a prisma `$transaction` client (REQUIRED — the journey + code + tasks commit together)
 * Returns the journey and whether it was newly created (false = idempotent no-op).
 */
async function seedOnboardingJourney(offer, tx, opts = {}) {
  if (!offer || !offer.id || !offer.businessId) {
    throw new Error('seedOnboardingJourney requires an offer with { id, businessId }');
  }
  if (!tx || typeof tx.lifecycleJourney === 'undefined') {
    throw new Error('seedOnboardingJourney requires a prisma transaction client');
  }
  const { id: offerId, businessId } = offer;

  // Idempotency: an active onboarding journey already seeded from this offer → no-op.
  const existing = await tx.lifecycleJourney.findFirst({
    where: { businessId, offerId, direction: 'ONBOARDING', deletedAt: null },
  });
  if (existing) return { journey: existing, created: false };

  // Resolve the hiring context off the application → job (countryCode/manager/entity).
  const application = await tx.application.findFirst({
    where: { id: offer.applicationId, businessId },
    include: { job: true },
  });
  const job = application && application.job ? application.job : null;
  // Feature 14 — the tenant country drives the onboarding template, not the job.
  const countryCode = await tenantCountry(businessId);
  const entityId = job && job.entityId ? job.entityId : null;

  // Resolve the hiring manager's Employee id (owner of MANAGER-owned tasks).
  let managerEmployeeId = null;
  if (job && job.hiringManagerId) {
    const mgr = await tx.employee.findFirst({
      where: { id: job.hiringManagerId, businessId, deletedAt: null },
      select: { id: true },
    });
    managerEmployeeId = mgr ? mgr.id : null;
  }

  // Pull the default onboarding template + task defs for the market.
  let bundle = await getDefaultOnboardingTemplate(tx, businessId, countryCode);
  if (!bundle) {
    // A brand-new tenant has NO lifecycle templates at all: seedOnboardingTemplates
    // is only reachable through the manual POST /templates/seed-defaults button, and
    // nothing calls it at signup. Skipping silently here meant the first hire of
    // every new tenant "worked" — offer ACCEPTED, application HIRED — while
    // onboarding simply did not exist: no tasks, no pre-join magic link for the
    // new starter, and no signal to anyone that it was missing. The config gap only
    // ever surfaced as "we hired them and nothing happened".
    //
    // So seed the defaults on demand. Only when the tenant has NO onboarding
    // template whatsoever: seedOnboardingTemplates reconciles task defs with a
    // deleteMany + createMany, so running it against a tenant that HAS templates
    // would silently discard their customised tasks. If templates exist but none is
    // default+active, that is a deliberate admin state we must not overwrite — say
    // so loudly instead of guessing.
    const anyTemplate = await tx.lifecycleTemplate.findFirst({
      where: { businessId, direction: 'ONBOARDING', deletedAt: null },
      select: { id: true },
    });
    if (anyTemplate) {
      console.warn(`[onboarding] business ${businessId} has onboarding templates but none is default+active — offer ${offerId} accepted with NO journey. Mark one template as default to fix.`);
      return { journey: null, created: false };
    }
    try {
      await seedOnboardingTemplates(tx, businessId, { entityId });
      bundle = await getDefaultOnboardingTemplate(tx, businessId, countryCode);
      if (bundle) console.log(`[onboarding] seeded default lifecycle templates for business ${businessId} on first hire`);
    } catch (e) {
      // Non-fatal by design: a missing template must never roll back an accepted
      // offer. The hire stands; onboarding can be seeded and started by hand.
      console.error(`[onboarding] could not seed default templates for business ${businessId}: ${e.message}`);
    }
    if (!bundle) {
      console.error(`[onboarding] offer ${offerId} accepted for business ${businessId} with NO onboarding journey (no usable template).`);
      return { journey: null, created: false };
    }
  }
  const { template, taskDefs } = bundle;

  const offerAcceptedAt = new Date();
  const joinDate = offer.joiningDate || null;

  // Mint the human code inside the same tx (NumberSequence increment, §3.3).
  const code = await allocateCode(tx, { businessId, entityId, scope: 'ONBOARD' });

  // Mint the pre-join magic-link token (no portal account yet → the candidate
  // self-onboards via this expiring link). The mint helper ALWAYS sets an expiry
  // (joinDate + 7d), so a token is never non-expiring; the raw token is returned
  // for the invite email (caller/notifier) and only the hash is persisted.
  const { mintPreJoinToken } = require('./controllers/meOnboarding.controller');
  const preJoin = mintPreJoinToken({ joinDate });

  // Owner resolution: NEW_HIRE/EMPLOYEE have no Employee yet (provisioned later),
  // so their tasks stay unassigned until provisioning; MANAGER resolves now.
  const ctx = {
    businessId,
    offerAcceptedAt,
    joinDate,
    ownerResolution: {
      MANAGER: managerEmployeeId ? { employeeId: managerEmployeeId } : {},
    },
  };
  const taskPayloads = seedJourneyTasks(template, taskDefs, ctx);

  const journey = await tx.lifecycleJourney.create({
    data: {
      businessId,
      entityId,
      code,
      direction: 'ONBOARDING',
      templateId: template.id,
      offerId,
      offerAcceptedAt,
      joinDate,
      currentStage: 'PRE_JOIN',
      status: 'NOT_STARTED',
      preJoinTokenHash: preJoin.tokenHash,
      preJoinTokenExpiresAt: preJoin.expiresAt,
      tasks: {
        create: taskPayloads.map((t) => ({
          businessId: t.businessId,
          taskDefId: t.taskDefId,
          stageKey: t.stageKey,
          taskKey: t.taskKey,
          title: t.title,
          ownerRole: t.ownerRole,
          assigneeEmployeeId: t.assigneeEmployeeId,
          assigneeUserId: t.assigneeUserId,
          dueDate: t.dueDate,
          isBlocking: t.isBlocking,
          isMandatory: t.isMandatory,
          status: t.status,
        })),
      },
    },
    include: { tasks: true },
  });

  // Return the raw pre-join token so the caller (notifier) can email the link.
  // It is NOT persisted anywhere (only the hash is); callers that don't need it
  // can ignore it.
  return { journey, created: true, preJoinRawToken: preJoin.rawToken };
}

module.exports = { seedOnboardingJourney, advanceJourney };
