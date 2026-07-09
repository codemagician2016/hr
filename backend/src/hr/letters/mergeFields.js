'use strict';

/**
 * mergeFields.js — PURE merge-field catalog + resolver for letter templates.
 * No DB, no network: the caller resolves the employee / business / comp / entity
 * rows and hands them in; this module flattens them into the §7 placeholder
 * namespaces, formats dates / numbers / currency by locale, masks compensation
 * unless permitted, and substitutes ONLY declared {{namespace.field}} tokens.
 *
 *   resolveMergeData({ employee, business, comp, entity, locale, now, refNo,
 *                      authority, perms }) -> { values, missingRequired[], masked[] }
 *   renderMerge(bodyMarkdown, values) -> { text, unknownTokens[] }
 *
 * Catalog namespaces (docs/features/09 §7):
 *   employee.*  comp.*  company.*  date.*  letter.*  authority.*
 *
 * SECURITY:
 *   - comp.* resolves to "••••" unless perms.canViewCompensation (F5 masking
 *     posture) and is flagged in `masked[]` so the wizard can surface a notice.
 *   - renderMerge substitutes ONLY tokens present in `values` (the resolved
 *     allow-list). Unknown / undeclared {{...}} tokens are flagged in
 *     `unknownTokens[]` and STRIPPED — never echoed raw (XSS-safe; the renderer
 *     never sees attacker-controlled token text).
 */

const MASK = '••••';

// Locale presets: date format is dd/MM/yyyy for both IN and NZ; currency symbol
// + grouping differ (₹ + Indian grouping for en-IN; NZ$ + en-NZ grouping).
const LOCALES = {
  'en-IN': { dateLocale: 'en-IN', numberLocale: 'en-IN', currency: 'INR', currencySymbol: '₹' },
  'en-NZ': { dateLocale: 'en-NZ', numberLocale: 'en-NZ', currency: 'NZD', currencySymbol: 'NZ$' },
  'en-US': { dateLocale: 'en-US', numberLocale: 'en-US', currency: 'USD', currencySymbol: '$' },
};
const DEFAULT_LOCALE = 'en-IN';

// ── catalog (the declared allow-list / palette per §7) ───────────────────────
// type drives formatting; `required` flags a field whose absence => missingRequired
// (only flagged when the field is actually requested by the template, see below);
// `gatedBy` names a perm that gates the value (comp.* => canViewCompensation).
// `country` restricts a field to one market's statutory namespace.
const CATALOG = {
  // employee namespace
  'employee.name': { type: 'string', ns: 'employee' },
  'employee.firstName': { type: 'string', ns: 'employee' },
  'employee.lastName': { type: 'string', ns: 'employee' },
  'employee.code': { type: 'string', ns: 'employee' },
  'employee.designation': { type: 'string', ns: 'employee' },
  'employee.department': { type: 'string', ns: 'employee' },
  'employee.dateOfJoining': { type: 'date', ns: 'employee' },
  'employee.lastWorkingDay': { type: 'date', ns: 'employee' },
  'employee.tenureYears': { type: 'number', ns: 'employee' },
  'employee.employmentType': { type: 'string', ns: 'employee' },
  'employee.workLocation': { type: 'string', ns: 'employee' },
  'employee.email': { type: 'string', ns: 'employee' },
  'employee.phone': { type: 'string', ns: 'employee' },
  // IN statutory ids
  'employee.pan': { type: 'string', ns: 'employee', country: 'IN' },
  'employee.uan': { type: 'string', ns: 'employee', country: 'IN' },
  'employee.pfNumber': { type: 'string', ns: 'employee', country: 'IN' },
  'employee.esiNumber': { type: 'string', ns: 'employee', country: 'IN' },
  // NZ statutory ids
  'employee.irdNumber': { type: 'string', ns: 'employee', country: 'NZ' },
  'employee.taxCode': { type: 'string', ns: 'employee', country: 'NZ' },
  'employee.kiwiSaverRate': { type: 'string', ns: 'employee', country: 'NZ' },
  // bank (always masked tail-4 regardless of comp perm)
  'employee.bankName': { type: 'string', ns: 'employee' },
  'employee.bankAccountMasked': { type: 'string', ns: 'employee' },
  'employee.ifsc': { type: 'string', ns: 'employee', country: 'IN' },
  'employee.bankBranch': { type: 'string', ns: 'employee' },

  // comp namespace — ALL gated by canViewCompensation
  'comp.ctcAnnual': { type: 'money', ns: 'comp', gatedBy: 'canViewCompensation' },
  'comp.basic': { type: 'money', ns: 'comp', gatedBy: 'canViewCompensation' },
  'comp.hra': { type: 'money', ns: 'comp', gatedBy: 'canViewCompensation', country: 'IN' },
  'comp.grossMonthly': { type: 'money', ns: 'comp', gatedBy: 'canViewCompensation' },
  'comp.netMonthly': { type: 'money', ns: 'comp', gatedBy: 'canViewCompensation' },
  'comp.da': { type: 'money', ns: 'comp', gatedBy: 'canViewCompensation', country: 'IN' },
  'comp.specialAllowance': { type: 'money', ns: 'comp', gatedBy: 'canViewCompensation' },

  // company namespace
  'company.legalName': { type: 'string', ns: 'company' },
  'company.tradeName': { type: 'string', ns: 'company' },
  'company.addressBlock': { type: 'string', ns: 'company' },
  'company.registeredAddress': { type: 'string', ns: 'company' },
  'company.cin': { type: 'string', ns: 'company', country: 'IN' },
  'company.gstin': { type: 'string', ns: 'company', country: 'IN' },
  'company.nzbn': { type: 'string', ns: 'company', country: 'NZ' },
  'company.logoUrl': { type: 'string', ns: 'company' },
  'company.signatoryName': { type: 'string', ns: 'company' },
  'company.signatoryDesignation': { type: 'string', ns: 'company' },

  // date namespace
  'date.today': { type: 'date', ns: 'date' },
  'date.issueDate': { type: 'date', ns: 'date' },
  'date.effectiveDate': { type: 'date', ns: 'date' },

  // letter namespace
  'letter.refNo': { type: 'string', ns: 'letter' },
  'letter.subject': { type: 'string', ns: 'letter' },
  'letter.purpose': { type: 'string', ns: 'letter' },
  'letter.addressee': { type: 'string', ns: 'letter' },

  // authority namespace (pre-signature line)
  'authority.name': { type: 'string', ns: 'authority' },
  'authority.designation': { type: 'string', ns: 'authority' },

  // course namespace (Feature 37 — LMS completion certificate). Additive; only the
  // LMS_CERTIFICATE template references these tokens, fed via issueLetter overrides.course.
  'course.title': { type: 'string', ns: 'course' },
  'course.code': { type: 'string', ns: 'course' },
  'course.category': { type: 'string', ns: 'course' },
  'course.completedOn': { type: 'date', ns: 'course' },
  'course.scorePct': { type: 'number', ns: 'course' },
  'course.cycle': { type: 'string', ns: 'course' },
};

// ── formatters ───────────────────────────────────────────────────────────────
function localeMeta(locale) {
  return LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
}

/** Format a Date | ISO string | ms as dd/MM/yyyy in the given locale. */
function formatDate(value, locale) {
  const d = toDate(value);
  if (!d) return '';
  // Force dd/MM/yyyy with zero-padding (en-IN / en-NZ both use this order).
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getUTCFullYear());
  void locale; // both target markets share dd/MM/yyyy; kept for forward-compat
  return `${dd}/${mm}/${yyyy}`;
}

/** Format a money amount (major-unit number/string) with symbol + grouping. */
function formatMoney(value, locale) {
  const meta = localeMeta(locale);
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const grouped = Math.abs(n).toLocaleString(meta.numberLocale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? '-' : ''}${meta.currencySymbol}${grouped}`;
}

/** Format a plain number with locale grouping (no currency). */
function formatNumber(value, locale) {
  const meta = localeMeta(locale);
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString(meta.numberLocale);
}

function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  // ISO "YYYY-MM-DD" → treat as UTC midnight to avoid TZ drift in the dd/mm/yyyy.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Whole/partial years of service between a joining date and an end date, rounded
 * to one decimal (e.g. 4.3). Returns null when either bound is unparseable or the
 * span is negative — the field then resolves to '' (and, if marked required for an
 * EXPERIENCE letter, surfaces in missingRequired so the wizard blocks the issue
 * rather than rendering "a tenure of  year(s)").
 */
function computeTenureYears(doj, end) {
  const a = toDate(doj);
  const b = toDate(end);
  if (!a || !b) return null;
  const years = (b.getTime() - a.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(years) || years < 0) return null;
  return Math.round(years * 10) / 10;
}

// ── source flatteners ─────────────────────────────────────────────────────────
function rel(v) {
  // a relation field may be a string or { name|title|label|code }
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.name || v.title || v.label || v.code || '';
  return String(v);
}
function str(v) {
  return v == null ? '' : String(v);
}

/** Build the RAW (pre-format, pre-mask) source map for every catalog key. */
function buildRawSources({ employee, business, comp, entity, now, refNo, authority, course }) {
  const e = employee || {};
  const b = business || {};
  const c = comp || {};
  const en = entity || {};
  const crs = course || {};
  const brand = b.brand || en.brand || {};
  const nm =
    [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ').trim() ||
    e.name || e.preferredName || e.displayName || e.fullName || '';

  const issueDate = now instanceof Date ? now : (now ? toDate(now) : new Date());

  // Tenure / last-working-day for service letters (EXPERIENCE / Statement of
  // Service). For an ACTIVE employee there's no termination date, so the service
  // period runs joining → issue date — defaulting lastWorkingDay to the issue
  // date keeps "...from {{doj}} to {{lwd}}..." reading as proper English instead
  // of a trailing blank. tenureYears is computed (one decimal) from the joining
  // date to that end date when the caller didn't supply an explicit figure.
  const dojRaw = e.dateOfJoining || e.joinedAt || e.doj || null;
  const lwdRaw = e.lastWorkingDay || e.lwd || (dojRaw ? issueDate : null);
  const tenureYears = (e.tenureYears != null && e.tenureYears !== '')
    ? e.tenureYears
    : computeTenureYears(dojRaw, lwdRaw);

  return {
    // employee
    'employee.name': nm,
    'employee.firstName': str(e.firstName),
    'employee.lastName': str(e.lastName),
    'employee.code': str(e.code),
    'employee.designation': rel(e.designation) || rel(e.jobTitle),
    'employee.department': rel(e.department),
    'employee.dateOfJoining': dojRaw,
    'employee.lastWorkingDay': lwdRaw,
    'employee.tenureYears': tenureYears,
    'employee.employmentType': str(e.employmentType),
    'employee.workLocation': rel(e.workLocation) || rel(e.location),
    'employee.email': str(e.email || e.workEmail),
    'employee.phone': str(e.phone || e.mobile),
    'employee.pan': str(e.pan),
    'employee.uan': str(e.uan),
    'employee.pfNumber': str(e.pfNumber),
    'employee.esiNumber': str(e.esiNumber),
    'employee.irdNumber': str(e.irdNumber),
    'employee.taxCode': str(e.taxCode),
    'employee.kiwiSaverRate': str(e.kiwiSaverRate),
    'employee.bankName': str(e.bankName),
    'employee.bankAccountMasked': maskAccount(e.bankAccountMasked || e.bankAccount),
    'employee.ifsc': str(e.ifsc),
    'employee.bankBranch': str(e.bankBranch),

    // comp (raw — masking applied later)
    'comp.ctcAnnual': c.ctcAnnual,
    'comp.basic': c.basic,
    'comp.hra': c.hra,
    'comp.grossMonthly': c.grossMonthly,
    'comp.netMonthly': c.netMonthly,
    'comp.da': c.da,
    'comp.specialAllowance': c.specialAllowance,

    // company / brand / entity
    'company.legalName': str(b.legalName || b.name || en.legalName),
    'company.tradeName': str(b.tradeName || b.tradingName || brand.tradeName),
    'company.addressBlock': str(b.addressBlock || en.addressBlock || brand.addressBlock),
    'company.registeredAddress': str(b.registeredAddress || en.registeredAddress),
    'company.cin': str(b.cin || en.cin),
    'company.gstin': str(b.gstin || en.gstin),
    'company.nzbn': str(b.nzbn || en.nzbn),
    'company.logoUrl': str(brand.logoUrl || b.logoUrl),
    'company.signatoryName': str(b.signatoryName || brand.signatoryName),
    'company.signatoryDesignation': str(b.signatoryDesignation || brand.signatoryDesignation),

    // date
    'date.today': issueDate,
    'date.issueDate': issueDate,
    'date.effectiveDate': (employee && (employee.effectiveDate)) || issueDate,

    // letter
    'letter.refNo': str(refNo),
    'letter.subject': str((authority && authority.subject)) ,
    'letter.purpose': str((authority && authority.purpose)),
    'letter.addressee': str((authority && authority.addressee)),

    // authority (pre-signature)
    'authority.name': str(authority && (authority.name)),
    'authority.designation': str(authority && (authority.designation)),

    // course (Feature 37 — LMS certificate facts)
    'course.title': str(crs.title),
    'course.code': str(crs.code),
    'course.category': str(crs.category),
    'course.completedOn': crs.completedOn || null,
    'course.scorePct': (crs.scorePct == null || crs.scorePct === '') ? '' : crs.scorePct,
    'course.cycle': str(crs.cycle),
  };
}

/** Mask a bank account to its last 4 (always masked, never gated). */
function maskAccount(v) {
  const s = str(v).replace(/\s+/g, '');
  if (!s) return '';
  if (/[•*]/.test(s)) return s; // already masked upstream
  const tail = s.slice(-4);
  return `${'•'.repeat(Math.max(0, s.length - 4))}${tail}`;
}

// ── resolveMergeData ──────────────────────────────────────────────────────────
/**
 * @param {Object} args
 * @param {Object} args.employee
 * @param {Object} args.business
 * @param {Object} args.comp        compensation snapshot (gated by canViewCompensation)
 * @param {Object} args.entity      legal entity (for country / statutory namespace)
 * @param {string} args.locale      BCP-47 ("en-IN" | "en-NZ")
 * @param {Date|string} args.now    issue date
 * @param {string} args.refNo
 * @param {Object} args.authority   { name, designation, subject, purpose, addressee }
 * @param {Object} args.perms       { canViewCompensation: bool }
 * @param {string[]} [args.required] catalog keys the template marks required
 * @returns {{ values: Object, missingRequired: string[], masked: string[] }}
 */
function resolveMergeData({
  employee, business, comp, entity, locale, now, refNo, authority, perms, required, course,
  manual, manualFields,
} = {}) {
  const loc = LOCALES[locale] ? locale : DEFAULT_LOCALE;
  const canViewComp = !!(perms && perms.canViewCompensation);
  const raw = buildRawSources({ employee, business, comp, entity, now, refNo, authority, course });

  const values = {};
  const masked = [];

  for (const [key, spec] of Object.entries(CATALOG)) {
    const rawVal = raw[key];

    // gated comp.* → mask unless permitted; flag for the "salary hidden" notice.
    if (spec.gatedBy === 'canViewCompensation' && !canViewComp) {
      values[key] = MASK;
      masked.push(key);
      continue;
    }

    let out;
    switch (spec.type) {
      case 'date':
        out = formatDate(rawVal, loc);
        break;
      case 'money':
        out = formatMoney(rawVal, loc);
        break;
      case 'number':
        out = rawVal == null || rawVal === '' ? '' : formatNumber(rawVal, loc);
        break;
      default:
        out = str(rawVal);
    }
    values[key] = out;
  }

  // Manual (at-issue) fields — template-declared, filled by the issuer in the
  // wizard. Outside the fixed CATALOG; resolved from `manual` with per-field type
  // formatting so {{manual.<key>}} substitutes like any other token.
  const manualVals = manual && typeof manual === 'object' ? manual : {};
  const manualDefs = Array.isArray(manualFields) ? manualFields : [];
  for (const def of manualDefs) {
    if (!def || !def.key) continue;
    const rawVal = manualVals[def.key];
    let out;
    switch (def.type) {
      case 'date': out = rawVal ? formatDate(rawVal, loc) : ''; break;
      case 'currency':
      case 'money': out = (rawVal == null || rawVal === '') ? '' : formatMoney(rawVal, loc); break;
      case 'number': out = (rawVal == null || rawVal === '') ? '' : formatNumber(rawVal, loc); break;
      default: out = str(rawVal);
    }
    values[`manual.${def.key}`] = out;
  }

  // missingRequired: only the explicitly-required catalog keys whose resolved
  // value is empty (masked comp counts as PRESENT — the figure is hidden by
  // policy, not missing). Unknown required keys are reported as missing too.
  const missingRequired = [];
  const reqList = Array.isArray(required) ? required : [];
  for (const key of reqList) {
    if (!(key in CATALOG)) { missingRequired.push(key); continue; }
    const v = values[key];
    if (v === undefined || v === null || v === '') missingRequired.push(key);
  }
  // required manual fields left blank are missing too.
  for (const def of manualDefs) {
    if (def && def.required) {
      const v = values[`manual.${def.key}`];
      if (v === undefined || v === null || v === '') missingRequired.push(`manual.${def.key}`);
    }
  }

  return { values, missingRequired, masked };
}

// ── renderMerge ───────────────────────────────────────────────────────────────
// Token grammar: {{ namespace.field }} — letters, dots, optional whitespace.
// We deliberately match only this shape; anything else is left as-is text. A
// well-formed token that is NOT in `values` is flagged AND removed (never echoed
// raw → no attacker-controlled string ever reaches drawText).
const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

/**
 * @param {string} bodyMarkdown  template body with {{namespace.field}} tokens
 * @param {Object} values        resolved allow-list (from resolveMergeData)
 * @returns {{ text: string, unknownTokens: string[] }}
 */
function renderMerge(bodyMarkdown, values) {
  const src = String(bodyMarkdown == null ? '' : bodyMarkdown);
  const vals = values && typeof values === 'object' ? values : {};
  const unknown = new Set();

  const text = src.replace(TOKEN_RE, (_m, key) => {
    if (Object.prototype.hasOwnProperty.call(vals, key)) {
      const v = vals[key];
      return v == null ? '' : String(v);
    }
    // undeclared / unknown token → flag, strip (do NOT echo the raw token)
    unknown.add(key);
    return '';
  });

  return { text, unknownTokens: Array.from(unknown) };
}

// ── catalog palette (for the UI inserter / GET /merge-fields) ─────────────────
/** Return the catalog filtered by category-less country (IN / NZ / null=all). */
function mergeFieldCatalog({ country } = {}) {
  const out = {};
  for (const [key, spec] of Object.entries(CATALOG)) {
    if (country && spec.country && spec.country !== country) continue;
    out[key] = {
      type: spec.type,
      namespace: spec.ns,
      gatedBy: spec.gatedBy || null,
      country: spec.country || null,
    };
  }
  return out;
}

module.exports = {
  resolveMergeData,
  renderMerge,
  mergeFieldCatalog,
  CATALOG,
  MASK,
  _internals: { formatDate, formatMoney, formatNumber, maskAccount, buildRawSources, computeTenureYears, TOKEN_RE },
};
