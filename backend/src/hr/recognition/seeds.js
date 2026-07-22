'use strict';

/**
 * seeds.js — Feature 35 idempotent R&R defaults for one tenant: the India-first
 * company-value set, a starter badge set, a starter (inactive-priced-sanely)
 * rewards catalog, and the AWARD certificate LetterTemplate (an F9 template using
 * ONLY existing merge namespaces + template-declared manual fields — no letters
 * engine changes).
 *
 * Invocation (documented): seedRecognitionDefaults runs
 *   (a) explicitly via POST /api/hr/recognition/seed-defaults (canManageRecognition), and
 *   (b) lazily on first use — ensureSeeded() is called by the values/catalog list
 *       paths when a tenant has zero RecognitionValue rows (fail-soft, never throws).
 * Every write is an upsert keyed on the tenant-unique name/code, so re-running
 * converges to the blueprint without duplicating or clobbering admin edits beyond
 * the seeded names.
 */

const prismaDefault = require('../../core/lib/prisma');

// India-first default values (spec §1 / slice 35a).
const DEFAULT_VALUES = Object.freeze([
  { name: 'Customer First', icon: '🤝', colorHex: '#2563EB', description: 'Went above and beyond for a customer' },
  { name: 'Ownership', icon: '🚀', colorHex: '#D97706', description: 'Took charge and saw it through' },
  { name: 'Team Player', icon: '🧩', colorHex: '#059669', description: 'Lifted the team, not just the task' },
  { name: 'Innovation', icon: '💡', colorHex: '#7C3AED', description: 'Found a smarter way' },
  { name: 'Integrity', icon: '🛡️', colorHex: '#DC2626', description: 'Did the right thing, always' },
]);

// Starter badges — value-linked where natural, with suggested default points.
const DEFAULT_BADGES = Object.freeze([
  { name: 'Above & Beyond', icon: '🌟', defaultPoints: 50, valueName: 'Customer First' },
  { name: 'Team Player', icon: '🤗', defaultPoints: 20, valueName: 'Team Player' },
  { name: 'Problem Solver', icon: '🧠', defaultPoints: 30, valueName: 'Innovation' },
  { name: 'Rising Star', icon: '✨', defaultPoints: 25, valueName: null },
  { name: 'Thank You', icon: '🙏', defaultPoints: 10, valueName: null },
]);

// Starter catalog — perks-over-cash (India framing §1): comp-off / WFH / vouchers /
// charity. Voucher ₹-values tagged taxable-perk so Finance can watch the ₹5k/yr line.
const DEFAULT_CATALOG = Object.freeze([
  { name: '1 Comp-Off Day', category: 'COMP_OFF', pointsCost: 500, inrValue: null, fulfilmentType: 'COMP_OFF_GRANT', isTaxablePerk: false, description: 'One compensatory-off day credited to your leave balance' },
  { name: 'Work-From-Home Day', category: 'WFH', pointsCost: 200, inrValue: null, fulfilmentType: 'MANUAL', isTaxablePerk: false, description: 'One approved WFH day (coordinate with your manager)' },
  { name: '₹250 Amazon Voucher', category: 'VOUCHER', pointsCost: 250, inrValue: 250, fulfilmentType: 'VOUCHER_CODE', isTaxablePerk: true, description: 'Amazon.in e-gift voucher' },
  { name: '₹500 Flipkart Voucher', category: 'VOUCHER', pointsCost: 500, inrValue: 500, fulfilmentType: 'VOUCHER_CODE', isTaxablePerk: true, description: 'Flipkart e-gift voucher' },
  { name: 'Team Lunch Voucher', category: 'PERK', pointsCost: 400, inrValue: 400, fulfilmentType: 'MANUAL', isTaxablePerk: true, description: 'Lunch on the company for you and a teammate' },
  { name: 'Charity Donation (₹500)', category: 'CHARITY', pointsCost: 500, inrValue: 500, fulfilmentType: 'MANUAL', isTaxablePerk: false, description: 'We donate ₹500 to a cause in your name' },
]);

// The F9 award-certificate template. Category CUSTOM (no LetterCategory enum churn);
// resolved strictly by this tenant-unique code. Award facts arrive as template-
// declared MANUAL fields ({{manual.*}} — the F9 Phase-3 mechanism), so NO change to
// the letters merge-field catalog is needed.
const AWARD_CERT_CODE = 'RNR-AWARD-CERT';

const AWARD_CERT_TEMPLATE = Object.freeze({
  code: AWARD_CERT_CODE,
  name: 'Award Certificate (R&R)',
  category: 'CUSTOM',
  countryCode: null,
  subject: 'Award Certificate — {{manual.awardName}}',
  bodyMarkdown: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

CERTIFICATE OF ACHIEVEMENT

This is to certify that {{employee.name}} (Employee Code: {{employee.code}}), {{employee.designation}}, has been awarded

{{manual.awardName}} {{manual.periodLabel}}

in recognition of their outstanding contribution at {{company.legalName}}.

{{manual.citation}}

For {{company.legalName}}

{{authority.name}}
{{authority.designation}}`,
  manualFieldsJson: [
    { key: 'awardName', label: 'Award name', type: 'text', required: true },
    { key: 'periodLabel', label: 'Period (e.g. Jun 2026)', type: 'text', required: false },
    { key: 'citation', label: 'Citation', type: 'text', required: false },
  ],
  requiresSignature: false,
  refNoPrefix: 'AWD',
});

/** Idempotent per-tenant seed. Returns per-family counts. */
async function seedRecognitionDefaults(businessId, { tx } = {}) {
  const db = tx || prismaDefault;
  if (!businessId) throw new Error('seedRecognitionDefaults requires businessId');
  const out = { values: 0, badges: 0, catalog: 0, template: 0 };

  const valueIdByName = new Map();
  for (let i = 0; i < DEFAULT_VALUES.length; i += 1) {
    const v = DEFAULT_VALUES[i];
    const row = await db.recognitionValue.upsert({
      where: { businessId_name: { businessId, name: v.name } },
      create: { businessId, name: v.name, description: v.description, icon: v.icon, colorHex: v.colorHex, sortOrder: i },
      update: {}, // keep admin edits; the seed only guarantees existence
    });
    valueIdByName.set(v.name, row.id);
    out.values += 1;
  }

  for (let i = 0; i < DEFAULT_BADGES.length; i += 1) {
    const b = DEFAULT_BADGES[i];
    await db.recognitionBadge.upsert({
      where: { businessId_name: { businessId, name: b.name } },
      create: {
        businessId,
        name: b.name,
        icon: b.icon,
        defaultPoints: b.defaultPoints,
        valueId: b.valueName ? valueIdByName.get(b.valueName) || null : null,
        sortOrder: i,
      },
      update: {},
    });
    out.badges += 1;
  }

  for (let i = 0; i < DEFAULT_CATALOG.length; i += 1) {
    const c = DEFAULT_CATALOG[i];
    const existing = await db.catalogItem.findFirst({ where: { businessId, name: c.name }, select: { id: true } });
    if (!existing) {
      await db.catalogItem.create({
        data: {
          businessId,
          name: c.name,
          description: c.description,
          category: c.category,
          pointsCost: c.pointsCost,
          inrValue: c.inrValue,
          stock: null,
          fulfilmentType: c.fulfilmentType,
          isTaxablePerk: c.isTaxablePerk,
          sortOrder: i,
        },
      });
    }
    out.catalog += 1;
  }

  // Award certificate template (best-effort — a letters hiccup must not block R&R).
  try {
    const t = AWARD_CERT_TEMPLATE;
    await db.letterTemplate.upsert({
      where: { businessId_code: { businessId, code: t.code } },
      create: {
        businessId,
        code: t.code,
        name: t.name,
        category: t.category,
        countryCode: t.countryCode,
        subject: t.subject,
        bodyMarkdown: t.bodyMarkdown,
        manualFieldsJson: t.manualFieldsJson,
        requiresSignature: t.requiresSignature,
        refNoPrefix: t.refNoPrefix,
        isSystem: true,
        isActive: true,
      },
      update: {
        // Reconcile canonical copy but keep tenant customisations of authority/signature.
        name: t.name,
        manualFieldsJson: t.manualFieldsJson,
        isActive: true,
        deletedAt: null,
      },
    });
    out.template = 1;
  } catch (e) {
    console.error('[recognition seed] award-certificate template upsert failed:', e.message);
  }

  return out;
}

/**
 * Lazy first-use seeding — called from the values/catalog list paths. A tenant with
 * ANY RecognitionValue rows is considered seeded (cheap count guard). Never throws.
 */
async function ensureSeeded(businessId) {
  try {
    const count = await prismaDefault.recognitionValue.count({ where: { businessId } });
    if (count > 0) return false;
    await seedRecognitionDefaults(businessId);
    return true;
  } catch (e) {
    console.error('[recognition seed] ensureSeeded failed:', e.message);
    return false;
  }
}

module.exports = {
  seedRecognitionDefaults,
  ensureSeeded,
  AWARD_CERT_CODE,
  _internals: { DEFAULT_VALUES, DEFAULT_BADGES, DEFAULT_CATALOG, AWARD_CERT_TEMPLATE },
};
