'use strict';

/**
 * letters/templates/seed.js — default SYSTEM LetterTemplate library for the two
 * markets (Feature 9 §4.5, §7, slice 9D).
 *
 * Seeds IN + NZ variants for EXPERIENCE / BONAFIDE / EMPLOYMENT_PROOF /
 * SALARY_PROOF / BANK / CONTRACT, plus one market-agnostic CUSTOM scaffold —
 * every body authored with the §7 merge tokens ({{namespace.field}}) from
 * mergeFields.js's catalog, and the correct statutory wording per market:
 *   IN — "To Whomsoever It May Concern", CTC / PF / UAN / PAN references, the
 *        India bonafide/experience idiom.
 *   NZ — IRD number / KiwiSaver / Holidays-Act entitlement references, NZ$
 *        annual remuneration idiom, no HRA/PF split.
 *
 * IDEMPOTENT: each template is upserted by its stable tenant-unique `code`
 * (e.g. EXP-STD-IN). `isSystem:true` marks them non-deletable (the controller
 * refuses DELETE on isSystem; they are archived, not removed). Re-running the
 * seeder converges every system row back to the blueprint below. Operator-edited
 * fields are intentionally overwritten on reseed (system rows are canonical);
 * tenants who want a divergent body clone to a CUSTOM (non-system) template.
 *
 * The blueprint builders are exported for unit tests; `seedLetterTemplates`
 * is the only DB-touching export. Accepts the live prisma client OR a
 * `$transaction` tx handle.
 */

// Every token used below MUST exist in mergeFields.CATALOG. The mergeFieldsJson
// allow-list per template is derived from the body via extractTokens() so the
// editor palette + the renderer agree and validation never rejects a system row.
const { CATALOG } = require('../mergeFields');

const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

/** Pull the distinct {{namespace.field}} tokens referenced by a body/subject. */
function extractTokens(...texts) {
  const set = new Set();
  for (const t of texts) {
    if (!t) continue;
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(String(t))) !== null) set.add(m[1]);
  }
  return [...set];
}

// Critical merge tokens per category — when one of these is referenced by a
// template body it is marked { required:true } in the allow-list, so an issue
// with the field empty trips missingRequired ⇒ the wizard surfaces the gap and
// the service returns 422 instead of rendering a letter with a blank where the
// employee's name / code / salary should be. A MASKED comp value counts as
// PRESENT (hidden by policy, not missing), so requiring comp.* never false-blocks
// an issuer who lacks canViewCompensation — it only blocks a genuinely empty CTC.
// Tokens not in a body are simply not declared, so the require-set is a superset.
const ALWAYS_REQUIRED = ['employee.name', 'employee.code'];
const REQUIRED_BY_CATEGORY = {
  EXPERIENCE: [...ALWAYS_REQUIRED, 'employee.dateOfJoining', 'employee.lastWorkingDay'],
  BONAFIDE: [...ALWAYS_REQUIRED],
  EMPLOYMENT_PROOF: [...ALWAYS_REQUIRED, 'employee.designation', 'employee.dateOfJoining'],
  SALARY_PROOF: [...ALWAYS_REQUIRED, 'comp.ctcAnnual', 'comp.grossMonthly'],
  BANK: [...ALWAYS_REQUIRED, 'employee.bankName'],
  CONTRACT: [...ALWAYS_REQUIRED, 'employee.designation', 'employee.dateOfJoining'],
  CUSTOM: [],
  // Feature 37 — LMS certificate needs the learner + the course title to be a valid
  // proof of record (the LMS always supplies these on the COMPLETED transition).
  LMS_CERTIFICATE: [...ALWAYS_REQUIRED, 'course.title'],
};

/**
 * Build the mergeFieldsJson allow-list for a body: { token: {type,gatedBy,required?} }.
 * `category` selects the required-token set (above); only tokens actually present
 * in the body are declared, so requiring a field the body doesn't reference is a
 * no-op.
 */
function mergeFieldsFor(texts, { category } = {}) {
  const out = {};
  const requiredSet = new Set(REQUIRED_BY_CATEGORY[category] || []);
  const bodyTexts = Array.isArray(texts) ? texts : [texts];
  for (const token of extractTokens(...bodyTexts)) {
    const spec = CATALOG[token];
    // Only declare tokens the catalog actually knows (defensive — all seeds use
    // catalog tokens, so this never drops a real field).
    if (!spec) continue;
    out[token] = { type: spec.type };
    if (spec.gatedBy) out[token].gatedBy = spec.gatedBy;
    if (spec.country) out[token].country = spec.country;
    if (requiredSet.has(token)) out[token].required = true;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// IN bodies — statutory idiom: "To Whomsoever It May Concern", CTC/PF/UAN/PAN.
// NZ bodies — IRD/KiwiSaver/Holidays-Act, NZ$ annual remuneration.
// Bodies are PLAIN TEXT with {{tokens}} — no HTML (renderer draws text; §9 XSS).
// ─────────────────────────────────────────────────────────────────────────────

const IN_BODIES = {
  EXPERIENCE: {
    code: 'EXP-STD-IN',
    name: 'Experience / Service Certificate (India)',
    subject: 'Experience Certificate — {{employee.name}}',
    body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

TO WHOMSOEVER IT MAY CONCERN

This is to certify that {{employee.name}} (Employee Code: {{employee.code}}) was employed with {{company.legalName}} as {{employee.designation}} in the {{employee.department}} department.

{{employee.name}} served the organisation from {{employee.dateOfJoining}} to {{employee.lastWorkingDay}}, a tenure of {{employee.tenureYears}} year(s).

During the period of employment, we found {{employee.name}} to be sincere, hardworking and professional in conduct. We wish {{employee.name}} all success in future endeavours.

This certificate is issued upon request for whatever purpose it may serve.

For {{company.legalName}}

{{authority.name}}
{{authority.designation}}`,
  },
  BONAFIDE: {
    code: 'BONA-STD-IN',
    name: 'Bonafide Certificate (India)',
    subject: 'Bonafide Certificate — {{employee.name}}',
    body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

TO WHOMSOEVER IT MAY CONCERN

This is to certify that {{employee.name}} (Employee Code: {{employee.code}}) is a bonafide employee of {{company.legalName}}, presently working as {{employee.designation}} in the {{employee.department}} department since {{employee.dateOfJoining}}.

This certificate is issued at the request of {{employee.name}} for {{letter.purpose}}.

For {{company.legalName}}

{{authority.name}}
{{authority.designation}}`,
  },
  EMPLOYMENT_PROOF: {
    code: 'EMP-PROOF-IN',
    name: 'Proof of Employment (India)',
    subject: 'Proof of Employment — {{employee.name}}',
    body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

To,
{{letter.addressee}}

Subject: Confirmation of Employment — {{employee.name}}

Dear Sir / Madam,

This letter confirms that {{employee.name}} (Employee Code: {{employee.code}}, PAN: {{employee.pan}}) is employed with {{company.legalName}} as {{employee.designation}} in the {{employee.department}} department, on a {{employee.employmentType}} basis, since {{employee.dateOfJoining}}.

{{employee.name}} is based at our {{employee.workLocation}} office. This letter is issued for the purpose of {{letter.purpose}} and may be relied upon by the addressee.

Should you require any further verification, please contact us at the address below.

For {{company.legalName}}
CIN: {{company.cin}}  |  GSTIN: {{company.gstin}}

{{authority.name}}
{{authority.designation}}`,
  },
  SALARY_PROOF: {
    code: 'SAL-PROOF-IN',
    name: 'Salary Certificate (India)',
    subject: 'Salary Certificate — {{employee.name}}',
    body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

TO WHOMSOEVER IT MAY CONCERN

This is to certify that {{employee.name}} (Employee Code: {{employee.code}}, PAN: {{employee.pan}}, UAN: {{employee.uan}}) is employed with {{company.legalName}} as {{employee.designation}} since {{employee.dateOfJoining}}.

The current annual cost-to-company (CTC) of {{employee.name}} is {{comp.ctcAnnual}}, with a monthly gross of {{comp.grossMonthly}} and a monthly net of {{comp.netMonthly}}. The salary structure comprises a Basic component of {{comp.basic}} and House Rent Allowance of {{comp.hra}} per annum.

This certificate is issued at the request of the employee for {{letter.purpose}}.

For {{company.legalName}}

{{authority.name}}
{{authority.designation}}`,
  },
  BANK: {
    code: 'BANK-STD-IN',
    name: 'Bank Account / Salary Routing Confirmation (India)',
    subject: 'Salary Account Confirmation — {{employee.name}}',
    body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

To,
The Branch Manager
{{employee.bankName}}
{{employee.bankBranch}}

Subject: Confirmation of Salary Account — {{employee.name}}

Dear Sir / Madam,

This is to confirm that {{employee.name}} (Employee Code: {{employee.code}}) is employed with {{company.legalName}} as {{employee.designation}} and that the monthly salary of the employee is credited to the following account held with your branch:

  Account Holder : {{employee.name}}
  Bank           : {{employee.bankName}}
  Account No.    : {{employee.bankAccountMasked}}
  IFSC           : {{employee.ifsc}}

This letter is issued for the employee's banking / KYC requirements.

For {{company.legalName}}

{{authority.name}}
{{authority.designation}}`,
  },
  CONTRACT: {
    code: 'CONTRACT-STD-IN',
    name: 'Appointment Letter / Employment Agreement (India)',
    subject: 'Letter of Appointment — {{employee.name}}',
    body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

Dear {{employee.firstName}},

LETTER OF APPOINTMENT

We are pleased to offer you employment with {{company.legalName}} on the following terms.

  Designation     : {{employee.designation}}
  Department      : {{employee.department}}
  Place of Work   : {{employee.workLocation}}
  Date of Joining : {{employee.dateOfJoining}}
  Employment Type : {{employee.employmentType}}

Remuneration: Your annual cost-to-company (CTC) will be {{comp.ctcAnnual}}, structured with a Basic of {{comp.basic}} and House Rent Allowance of {{comp.hra}} per annum. Statutory deductions including Provident Fund (PF) shall apply as per the Employees' Provident Funds and Miscellaneous Provisions Act, 1952, and your Universal Account Number (UAN) will be maintained accordingly.

This appointment is governed by the Standing Orders / HR policy of the Company and the applicable laws of India. Please sign and return a copy of this letter in token of your acceptance.

For {{company.legalName}}

{{authority.name}}
{{authority.designation}}

Accepted by: {{employee.name}}`,
    requiresSignature: true,
  },
};

const NZ_BODIES = {
  EXPERIENCE: {
    code: 'EXP-STD-NZ',
    name: 'Statement of Service (New Zealand)',
    subject: 'Statement of Service — {{employee.name}}',
    body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

STATEMENT OF SERVICE

This statement confirms that {{employee.name}} (Employee No.: {{employee.code}}) was employed by {{company.legalName}} as {{employee.designation}} in the {{employee.department}} team.

{{employee.name}} was employed from {{employee.dateOfJoining}} to {{employee.lastWorkingDay}}, a period of {{employee.tenureYears}} year(s), on a {{employee.employmentType}} basis. All entitlements under the Holidays Act 2003 were provided during employment.

{{employee.name}} carried out their duties capably and professionally. We wish {{employee.name}} well in their future career.

For {{company.legalName}}
NZBN: {{company.nzbn}}

{{authority.name}}
{{authority.designation}}`,
  },
  BONAFIDE: {
    code: 'BONA-STD-NZ',
    name: 'Confirmation of Employment (New Zealand)',
    subject: 'Confirmation of Employment — {{employee.name}}',
    body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

TO WHOM IT MAY CONCERN

This letter confirms that {{employee.name}} (Employee No.: {{employee.code}}) is a current employee of {{company.legalName}}, employed as {{employee.designation}} in the {{employee.department}} team since {{employee.dateOfJoining}}.

This confirmation is provided at the employee's request for {{letter.purpose}}.

For {{company.legalName}}
NZBN: {{company.nzbn}}

{{authority.name}}
{{authority.designation}}`,
  },
  EMPLOYMENT_PROOF: {
    code: 'EMP-PROOF-NZ',
    name: 'Proof of Employment (New Zealand)',
    subject: 'Proof of Employment — {{employee.name}}',
    body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

To,
{{letter.addressee}}

Subject: Confirmation of Employment — {{employee.name}}

Dear Sir / Madam,

This letter confirms that {{employee.name}} (Employee No.: {{employee.code}}, IRD No.: {{employee.irdNumber}}) is employed by {{company.legalName}} as {{employee.designation}} in the {{employee.department}} team, on a {{employee.employmentType}} basis, since {{employee.dateOfJoining}}.

PAYE is deducted under tax code {{employee.taxCode}} and the employee contributes to KiwiSaver at {{employee.kiwiSaverRate}}. {{employee.name}} is based at our {{employee.workLocation}} location.

This letter is issued for the purpose of {{letter.purpose}} and may be relied upon by the addressee.

For {{company.legalName}}
NZBN: {{company.nzbn}}

{{authority.name}}
{{authority.designation}}`,
  },
  SALARY_PROOF: {
    code: 'SAL-PROOF-NZ',
    name: 'Remuneration Confirmation (New Zealand)',
    subject: 'Remuneration Confirmation — {{employee.name}}',
    body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

TO WHOM IT MAY CONCERN

This letter confirms that {{employee.name}} (Employee No.: {{employee.code}}, IRD No.: {{employee.irdNumber}}) is employed by {{company.legalName}} as {{employee.designation}} since {{employee.dateOfJoining}}.

The employee's current gross annual remuneration is {{comp.ctcAnnual}} (NZ$), paid as a monthly gross of {{comp.grossMonthly}}. PAYE is deducted under tax code {{employee.taxCode}}, and KiwiSaver employee contributions are made at {{employee.kiwiSaverRate}}. Annual holiday entitlements are provided in accordance with the Holidays Act 2003.

This confirmation is provided at the employee's request for {{letter.purpose}}.

For {{company.legalName}}
NZBN: {{company.nzbn}}

{{authority.name}}
{{authority.designation}}`,
  },
  BANK: {
    code: 'BANK-STD-NZ',
    name: 'Bank Account / Salary Routing Confirmation (New Zealand)',
    subject: 'Salary Account Confirmation — {{employee.name}}',
    body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

To,
{{employee.bankName}}

Subject: Confirmation of Salary Account — {{employee.name}}

Dear Sir / Madam,

This is to confirm that {{employee.name}} (Employee No.: {{employee.code}}) is employed by {{company.legalName}} as {{employee.designation}} and that the employee's wages are paid to the following account:

  Account Holder : {{employee.name}}
  Bank           : {{employee.bankName}}
  Account No.    : {{employee.bankAccountMasked}}

This letter is issued for the employee's banking requirements.

For {{company.legalName}}
NZBN: {{company.nzbn}}

{{authority.name}}
{{authority.designation}}`,
  },
  CONTRACT: {
    code: 'CONTRACT-STD-NZ',
    name: 'Individual Employment Agreement (New Zealand)',
    subject: 'Employment Agreement — {{employee.name}}',
    body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

Dear {{employee.firstName}},

INDIVIDUAL EMPLOYMENT AGREEMENT

{{company.legalName}} (NZBN: {{company.nzbn}}) is pleased to offer you employment on the following terms, in accordance with the Employment Relations Act 2000.

  Position       : {{employee.designation}}
  Team           : {{employee.department}}
  Place of Work  : {{employee.workLocation}}
  Start Date     : {{employee.dateOfJoining}}
  Employment Type: {{employee.employmentType}}

Remuneration: Your gross annual remuneration will be {{comp.ctcAnnual}} (NZ$), paid as a monthly gross of {{comp.grossMonthly}}. PAYE will be deducted under tax code {{employee.taxCode}}. You will be enrolled in KiwiSaver at {{employee.kiwiSaverRate}} unless you elect otherwise. Annual holidays, public holidays, sick leave and bereavement leave are provided in accordance with the Holidays Act 2003.

You are entitled to seek independent advice on this agreement before signing. Please sign and return a copy to confirm your acceptance.

For {{company.legalName}}

{{authority.name}}
{{authority.designation}}

Accepted by: {{employee.name}}`,
    requiresSignature: true,
  },
};

// Market-agnostic CUSTOM scaffold (countryCode null). A blank-ish starting point
// HR clones / edits; system + published so it shows in the library immediately.
const CUSTOM_SCAFFOLD = {
  code: 'CUSTOM-SCAFFOLD',
  name: 'Custom Letter (scaffold)',
  category: 'CUSTOM',
  countryCode: null,
  subject: '{{letter.subject}}',
  body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

To,
{{letter.addressee}}

Dear Sir / Madam,

This letter concerns {{employee.name}} (Employee Code: {{employee.code}}), {{employee.designation}} at {{company.legalName}}.

[Replace this paragraph with your letter content. Insert merge fields such as {{employee.name}}, {{employee.designation}}, {{date.issueDate}} or {{company.legalName}} from the field palette.]

For {{company.legalName}}

{{authority.name}}
{{authority.designation}}`,
};

// Feature 37 — LMS course-completion certificate (market-agnostic). HR can brand/edit
// the copy with NO deploy (it's a LetterTemplate); the LMS feeds course.* merge facts
// via issueLetter overrides.course. Used as the tenant default when a course doesn't
// pin its own certificateTemplateId.
const LMS_CERTIFICATE_TEMPLATE = {
  code: 'LMS-CERT-STD',
  name: 'Course Completion Certificate',
  category: 'LMS_CERTIFICATE',
  countryCode: null,
  subject: 'Certificate of Completion — {{course.title}}',
  body: `Ref: {{letter.refNo}}
Date: {{date.issueDate}}

CERTIFICATE OF COMPLETION

This is to certify that {{employee.name}} (Employee Code: {{employee.code}}), {{employee.designation}}, has successfully completed the training course "{{course.title}}" ({{course.code}}) on {{course.completedOn}}.

This certificate is issued as a record of training and serves as proof of completion.

For {{company.legalName}}

{{authority.name}}
{{authority.designation}}`,
};

/**
 * Build the full system-template descriptor list (12 country variants + 1 CUSTOM
 * scaffold). Each descriptor carries its derived mergeFieldsJson allow-list.
 * Exported for unit tests (pure — no DB).
 */
function systemTemplateDescriptors() {
  const descriptors = [];
  const markets = [
    { cc: 'IN', locale: 'en-IN', bodies: IN_BODIES },
    { cc: 'NZ', locale: 'en-NZ', bodies: NZ_BODIES },
  ];
  for (const { cc, locale, bodies } of markets) {
    for (const category of ['EXPERIENCE', 'BONAFIDE', 'EMPLOYMENT_PROOF', 'SALARY_PROOF', 'BANK', 'CONTRACT']) {
      const b = bodies[category];
      descriptors.push({
        code: b.code,
        name: b.name,
        category,
        countryCode: cc,
        subject: b.subject || null,
        bodyMarkdown: b.body,
        mergeFieldsJson: mergeFieldsFor([b.body, b.subject], { category }),
        requiresSignature: !!b.requiresSignature,
        locale,
        refNoPrefix: null,
        isSystem: true,
        isActive: true,
      });
    }
  }
  // CUSTOM scaffold (market-agnostic).
  descriptors.push({
    code: CUSTOM_SCAFFOLD.code,
    name: CUSTOM_SCAFFOLD.name,
    category: CUSTOM_SCAFFOLD.category,
    countryCode: CUSTOM_SCAFFOLD.countryCode,
    subject: CUSTOM_SCAFFOLD.subject,
    bodyMarkdown: CUSTOM_SCAFFOLD.body,
    mergeFieldsJson: mergeFieldsFor([CUSTOM_SCAFFOLD.body, CUSTOM_SCAFFOLD.subject], { category: CUSTOM_SCAFFOLD.category }),
    requiresSignature: false,
    locale: null,
    refNoPrefix: null,
    isSystem: true,
    isActive: true,
  });
  // Feature 37 — LMS course-completion certificate (market-agnostic system template).
  const cert = LMS_CERTIFICATE_TEMPLATE;
  descriptors.push({
    code: cert.code,
    name: cert.name,
    category: cert.category,
    countryCode: cert.countryCode,
    subject: cert.subject,
    bodyMarkdown: cert.body,
    mergeFieldsJson: mergeFieldsFor([cert.body, cert.subject], { category: cert.category }),
    requiresSignature: false,
    locale: null,
    refNoPrefix: 'CERT',
    isSystem: true,
    isActive: true,
  });
  return descriptors;
}

/**
 * seedLetterTemplates(prisma, businessId, { entityId } = {}) — idempotent.
 * Upserts the IN + NZ system LetterTemplate library for one tenant, keyed by the
 * stable tenant-unique `code`. Re-running converges every system row back to the
 * blueprint. Returns the upserted templates.
 *
 * Accepts a prisma-like client (the live client or a `$transaction` tx handle).
 * `version` is preserved (not reset) across reseeds so issued-letter version pins
 * stay meaningful — but the body/wording is reconciled to canonical.
 */
async function seedLetterTemplates(prisma, businessId, { entityId = null } = {}) {
  if (!prisma || !businessId) throw new Error('seedLetterTemplates requires (prisma, businessId)');
  const out = [];
  for (const desc of systemTemplateDescriptors()) {
    const row = await prisma.letterTemplate.upsert({
      where: { businessId_code: { businessId, code: desc.code } },
      create: { businessId, entityId, ...desc },
      // On reseed, reconcile canonical fields but DON'T clobber the version
      // counter (issued letters pin it) nor flip isSystem off.
      update: {
        name: desc.name,
        category: desc.category,
        countryCode: desc.countryCode,
        subject: desc.subject,
        bodyMarkdown: desc.bodyMarkdown,
        mergeFieldsJson: desc.mergeFieldsJson,
        requiresSignature: desc.requiresSignature,
        locale: desc.locale,
        isSystem: true,
        // re-activate a system row if it was archived (keeps the library complete)
        isActive: true,
        deletedAt: null,
      },
    });
    out.push(row);
  }
  return out;
}

module.exports = {
  seedLetterTemplates,
  systemTemplateDescriptors,
  // exported for tests
  _internals: { extractTokens, mergeFieldsFor, IN_BODIES, NZ_BODIES, CUSTOM_SCAFFOLD },
};
