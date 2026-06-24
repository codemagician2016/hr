'use strict';

/**
 * meDirectory.controller.js — Cycle 1 ESS COMPANY DIRECTORY, mounted at
 * /api/hr/me/directory (CUSTOMER session). A searchable, paginated, tenant-wide
 * colleague directory so an employee can find anyone in their company.
 *
 * HOW THIS DIFFERS FROM /me/team (Feature 13 MSS):
 *   - /me/team/directory is SCOPE-restricted to the caller's reporting sub-tree.
 *   - /me/directory is TENANT-WIDE: every ACTIVE colleague in the same business.
 *     We use resolveCustomerActor ONLY to (a) isolate to the caller's tenant and
 *     (b) get the caller's own employee row (so we can render "you" and drive the
 *     opt-out). We DO NOT band-restrict the listing — a company directory is, by
 *     definition, everyone. Tenant isolation is the wall; the F1 band is not.
 *
 * PRIVACY IS MANDATORY (the whole point of this surface):
 *   - The Prisma `select` IS the allowlist. We project ONLY work/professional fields:
 *     name (first/middle/last/preferred), photo, designation, department, work email,
 *     work (office) phone, entity/location, and the reporting manager. Personal email,
 *     personal/home phone, address, DOB, gender, marital status, blood group, religion,
 *     salary/compensation, statutory ids — NONE are ever selected, so they cannot leak
 *     even by accident (a future projection change can't accidentally widen them; they
 *     simply aren't in the row we read).
 *   - F13 FIELD GOVERNANCE is honoured: every field we expose is asserted to be a
 *     SAFE directory field by DIRECTORY_FIELDS below; each maps to a fieldPolicy() that
 *     is NOT a personal/PII-sensitive field. workEmail is read-only (the login
 *     identity, safe to show); officePhone is the one OPTIONAL shareable field and is
 *     additionally gated by the per-employee opt-out.
 *   - PER-EMPLOYEE OPT-OUT: Employee.directoryHidePhone=true suppresses the office
 *     phone for that person (they stay listed/findable; only the optional field hides).
 *
 * READ-ONLY: no writes to other employees. The only write is the SELF opt-out toggle
 * (PATCH /me/directory/preferences), which edits the caller's OWN row only.
 */

const prisma = require('../../core/lib/prisma');
const { resolveCustomerActor } = require('../lib/customerScope');
const { fieldPolicy } = require('./profileFieldPolicy');
const { isEssVisibleStatus, essOrgPolicy, ESS_ACTIVE_STATUSES } = require('../lib/orgVisibility');

// The EXHAUSTIVE allowlist of fields this surface may expose, each annotated with the
// F13 fieldKey it derives from. Asserted at boot (assertSafe) so a field can never be
// added here without passing the governance gate. This is the single source of truth for
// "what is a safe directory field".
//   identity:true  → directory-public identity (name/designation/dept) — shown on every
//                    HRMS directory; the F13 `sensitive` flag on names is about OPERATOR
//                    masking, not the colleague directory, so identity fields are vetted
//                    here as directory-public.
//   shareable:true → an OPTIONAL field subject to the per-employee directory opt-out.
const DIRECTORY_FIELDS = Object.freeze([
  { out: 'name',        fieldKey: 'firstName',                identity: true }, // composed name; directory-public
  { out: 'designation', fieldKey: 'employment.designation',   identity: true },
  { out: 'department',  fieldKey: 'employment.department',    identity: true },
  { out: 'workEmail',   fieldKey: 'workEmail' },              // read-only login identity (official email)
  { out: 'officePhone', fieldKey: 'officePhone', shareable: true }, // OPTIONAL — opt-out-gated work phone
  { out: 'entity',      fieldKey: 'employment.location',      identity: true }, // org placement, not PII
  { out: 'location',    fieldKey: 'employment.location',      identity: true },
  { out: 'manager',     fieldKey: 'manager' },                // reporting manager (read-only)
]);

// The DENY list — F13 fieldKeys (or wildcards) that must NEVER reach the directory,
// regardless of any future change to DIRECTORY_FIELDS. These are the truly-private
// categories: personal contact, money, statutory ids, address, and the @pii:sensitive
// personal attributes (religion/community/blood group) that F13 returns ONLY on a SELF
// read. A directory field resolving to any of these aborts boot (fail-closed).
const DENY_FIELDKEYS = Object.freeze(new Set([
  'personalEmail', 'phone', 'homePhone',                       // personal contact
  'dateOfBirth', 'gender', 'maritalStatus',                    // personal attributes
  'religion', 'community', 'bloodGroup',                       // @pii:sensitive personal
  'bank.*', 'statutory.*', 'address.*', 'family.*', 'emergency.*', // money / statutory / address / family
]));

// Boot-time governance gate (fail-closed). Every exposed field must:
//   (1) NOT be in DENY_FIELDKEYS (exact or wildcard), and
//   (2) if it carries the F13 `sensitive` flag, be an explicitly-vetted `identity:true`
//       field (name/designation/dept) — anything else `sensitive` is rejected.
function denied(fieldKey) {
  if (DENY_FIELDKEYS.has(fieldKey)) return true;
  const dot = fieldKey.indexOf('.');
  if (dot > 0 && DENY_FIELDKEYS.has(`${fieldKey.slice(0, dot)}.*`)) return true;
  return false;
}
(function assertSafe() {
  for (const f of DIRECTORY_FIELDS) {
    if (denied(f.fieldKey)) {
      throw new Error(`meDirectory: refusing to expose DENY-listed field "${f.fieldKey}" in the company directory`);
    }
    const p = fieldPolicy(f.fieldKey);
    if (p && p.sensitive && !f.identity) {
      throw new Error(`meDirectory: refusing to expose @pii:sensitive field "${f.fieldKey}" in the company directory`);
    }
  }
})();

const PAGE_MAX = 100;        // hard cap so a client cannot demand the whole tenant in one page
const PAGE_DEFAULT = 24;     // a comfortable card grid page

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function fullName(e) {
  return e.preferredName || [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ') || e.code;
}

// The Prisma select for a directory row. This IS the privacy boundary: ONLY work fields.
// `directoryHidePhone` is selected so we can honour the opt-out; it is never returned.
const ROW_SELECT = {
  id: true, code: true,
  firstName: true, middleName: true, lastName: true, preferredName: true,
  photoUrl: true, workEmail: true, officePhone: true, directoryHidePhone: true,
  status: true, managerEmployeeId: true,
  manager: { select: { id: true, firstName: true, middleName: true, lastName: true, preferredName: true, code: true } },
  employmentRecords: {
    where: { isCurrent: true }, take: 1, orderBy: { effectiveFrom: 'desc' },
    select: {
      designation: { select: { title: true } },
      department: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
      // Entity carries a registered legalName + an optional tradeName (no `name`); the
      // directory shows the friendly tradeName when present, else the legal name.
      entity: { select: { id: true, tradeName: true, legalName: true } },
    },
  },
};

// Shape a DB row → the SAFE directory DTO. Office phone is suppressed when the colleague
// has opted out (or has no number). Manager is rendered as a safe name+id reference.
function toCard(e) {
  const rec = (e.employmentRecords && e.employmentRecords[0]) || null;
  const dept = rec && rec.department ? rec.department : null;
  const loc = rec && rec.location ? rec.location : null;
  const ent = rec && rec.entity ? rec.entity : null;
  return {
    id: e.id,
    code: e.code,
    name: fullName(e),
    photoUrl: e.photoUrl || null,
    designation: rec && rec.designation ? rec.designation.title : null,
    department: dept ? dept.name : null,
    departmentId: dept ? dept.id : null,
    workEmail: e.workEmail || null,
    // OPTIONAL shareable field — honour the per-employee opt-out (and absence).
    workPhone: e.directoryHidePhone ? null : (e.officePhone || null),
    workPhoneShared: !e.directoryHidePhone,
    entity: ent ? (ent.tradeName || ent.legalName) : null,
    entityId: ent ? ent.id : null,
    location: loc ? loc.name : null,
    locationId: loc ? loc.id : null,
    manager: e.manager ? { id: e.manager.id, name: fullName(e.manager), code: e.manager.code } : null,
  };
}

// Resolve { businessId, selfId } for the caller. selfId may be null when the customer
// has no linked Employee (rare); the listing still works (tenant-scoped), self just
// isn't flagged/excludable.
async function callerContext(req) {
  const businessId = req.customer && req.customer.businessId;
  const { employee } = await resolveCustomerActor(req.customer);
  return { businessId, selfId: employee ? employee.id : null };
}

// Build the tenant-scoped, active-only WHERE for a directory listing. Search spans
// name / designation / department / (work) email — all SAFE fields. Tenant wall +
// active-status whitelist are ALWAYS ANDed in (never overridable by the client).
function buildWhere(businessId, policy, { q, departmentId, entityId, locationId }) {
  const where = { businessId, deletedAt: null };
  // Active-only: the ESS visible-status whitelist (TERMINATED/PRE_HIRE/RETIRED hidden).
  if (!policy.showInactive) where.status = { in: [...ESS_ACTIVE_STATUSES] };

  // Filters (department / entity / location) are pushed onto the CURRENT employment
  // record so the grid filter bar narrows the tenant-wide list.
  const recordWhere = { isCurrent: true };
  let useRecord = false;
  if (departmentId) { recordWhere.departmentId = departmentId; useRecord = true; }
  if (entityId)     { recordWhere.entityId = entityId; useRecord = true; }
  if (locationId)   { recordWhere.locationId = locationId; useRecord = true; }
  if (useRecord) where.employmentRecords = { some: recordWhere };

  const term = (q || '').trim();
  if (term) {
    const like = { contains: term, mode: 'insensitive' };
    where.OR = [
      { firstName: like },
      { lastName: like },
      { middleName: like },
      { preferredName: like },
      { code: like },
      { workEmail: like },                       // SAFE: work email only (personalEmail never searched)
      { employmentRecords: { some: { isCurrent: true, designation: { title: like } } } },
      { employmentRecords: { some: { isCurrent: true, department: { name: like } } } },
    ];
  }
  return where;
}

// ── GET /me/directory — searchable, paginated, tenant-wide colleague list ──────────
async function list(req, res, next) {
  try {
    const { businessId, selfId } = await callerContext(req);
    if (!businessId) return res.status(401).json({ message: 'Not authenticated' });
    const policy = essOrgPolicy(businessId);

    const page = clampInt(req.query.page, 1, 1, 1e9);
    const pageSize = clampInt(req.query.pageSize, PAGE_DEFAULT, 1, PAGE_MAX);
    const includeSelf = String(req.query.includeSelf || '') === 'true';

    const where = buildWhere(businessId, policy, {
      q: req.query.q,
      departmentId: req.query.departmentId,
      entityId: req.query.entityId,
      locationId: req.query.locationId,
    });
    // Exclude self by default (a colleague directory is "everyone else").
    if (selfId && !includeSelf) where.id = { not: selfId };

    const [total, rows] = await Promise.all([
      prisma.employee.count({ where }),
      prisma.employee.findMany({
        where,
        select: ROW_SELECT,
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    // Defensive backstop: re-filter visible status post-read (the WHERE already does it).
    const items = rows
      .filter((e) => isEssVisibleStatus(e.status, policy))
      .map(toCard);
    res.json({ items, total, page, pageSize });
  } catch (e) { next(e); }
}

// ── GET /me/directory/filters — distinct departments + entities for the filter bar ──
// Only org-placement facets (never PII). Scoped to the tenant's active population.
async function filters(req, res, next) {
  try {
    const { businessId } = await callerContext(req);
    if (!businessId) return res.status(401).json({ message: 'Not authenticated' });
    const policy = essOrgPolicy(businessId);
    const statusIn = policy.showInactive ? undefined : [...ESS_ACTIVE_STATUSES];
    const recWhere = {
      isCurrent: true, businessId,
      employee: { deletedAt: null, ...(statusIn ? { status: { in: statusIn } } : {}) },
    };
    const records = await prisma.employmentRecord.findMany({
      where: recWhere,
      select: {
        department: { select: { id: true, name: true } },
        // Entity has no `name` — show tradeName||legalName as the facet label.
        entity: { select: { id: true, tradeName: true, legalName: true } },
        location: { select: { id: true, name: true } },
      },
      take: 5000,
    });
    const dedupe = (arr) => {
      const m = new Map();
      for (const x of arr) if (x && x.id && !m.has(x.id)) m.set(x.id, { id: x.id, name: x.name });
      return [...m.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    };
    res.json({
      departments: dedupe(records.map((r) => r.department)),
      entities: dedupe(records.map((r) => r.entity ? { id: r.entity.id, name: r.entity.tradeName || r.entity.legalName } : null)),
      locations: dedupe(records.map((r) => r.location)),
    });
  } catch (e) { next(e); }
}

// ── GET /me/directory/preferences — the caller's OWN directory opt-out state ─────────
async function getPreferences(req, res, next) {
  try {
    const { businessId, selfId } = await callerContext(req);
    if (!businessId) return res.status(401).json({ message: 'Not authenticated' });
    if (!selfId) return res.json({ hideWorkPhone: false, hasWorkPhone: false, linked: false });
    const me = await prisma.employee.findFirst({
      where: { id: selfId, businessId }, select: { directoryHidePhone: true, officePhone: true },
    });
    res.json({
      hideWorkPhone: !!(me && me.directoryHidePhone),
      hasWorkPhone: !!(me && me.officePhone),
      linked: true,
    });
  } catch (e) { next(e); }
}

// ── PATCH /me/directory/preferences — toggle the caller's OWN work-phone opt-out ─────
// SELF-ONLY write: the subject is the session employee; no employeeId is accepted. This
// is the ONLY write on the directory surface, and it touches the caller's own row only.
async function updatePreferences(req, res, next) {
  try {
    const { businessId, selfId } = await callerContext(req);
    if (!businessId) return res.status(401).json({ message: 'Not authenticated' });
    if (!selfId) return res.status(409).json({ message: 'No employee is linked to this account.' });
    const raw = req.body && req.body.hideWorkPhone;
    if (typeof raw !== 'boolean') return res.status(400).json({ message: 'hideWorkPhone must be a boolean' });
    // updateMany with the tenant wall ANDed in (defence-in-depth IDOR guard).
    const r = await prisma.employee.updateMany({
      where: { id: selfId, businessId, deletedAt: null },
      data: { directoryHidePhone: raw },
    });
    if (r.count === 0) return res.status(404).json({ message: 'Not found' });
    res.json({ hideWorkPhone: raw });
  } catch (e) { next(e); }
}

// ── GET /me/directory/:id — a colleague's SAFE work profile (same allowlist) ─────────
// :id names a COLLEAGUE to VIEW (read-only), re-scoped to the tenant + active whitelist
// (out-of-tenant / inactive → 404). Same safe-field rule as the list; no compensation,
// no PII. Carries a link hint to the F19 org chart rooted at that person.
async function detail(req, res, next) {
  try {
    const { businessId } = await callerContext(req);
    if (!businessId) return res.status(401).json({ message: 'Not authenticated' });
    const policy = essOrgPolicy(businessId);
    const row = await prisma.employee.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      select: ROW_SELECT,
    });
    if (!row || !isEssVisibleStatus(row.status, policy)) return res.status(404).json({ message: 'Not found' });
    const card = toCard(row);
    // Direct reports count + the "in <department>" line are safe org context. Count only
    // the visible (active) direct reports so a leaver doesn't inflate the number.
    const reportsCount = await prisma.employee.count({
      where: {
        businessId, deletedAt: null, managerEmployeeId: row.id,
        ...(policy.showInactive ? {} : { status: { in: [...ESS_ACTIVE_STATUSES] } }),
      },
    });
    res.json({
      ...card,
      reportsCount,
      // F19 org-chart deep link rooted at this person (the ESS lazy org endpoints live
      // under /me/team/org; the client can re-root the chart on this node).
      orgChart: { rootEmployeeId: row.id, href: '/team?tab=org' },
    });
  } catch (e) { next(e); }
}

module.exports = {
  list, filters, detail, getPreferences, updatePreferences,
  // exported for tests
  DIRECTORY_FIELDS, ROW_SELECT, toCard, buildWhere,
};
