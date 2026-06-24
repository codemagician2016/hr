'use strict';

/*
 * registers.controller.js — HTTP layer for the statutory registers surface
 * (Feature 32), mounted at /api/hr/registers.
 *
 * READ-ONLY over already-frozen data. Each handler:
 *   - is tenant-scoped (req.user.businessId) — :id lookups use findFirst({id,
 *     businessId}), never findUnique by id alone;
 *   - is India-gated (the entity must be countryCode 'IN');
 *   - applies the F1 data-scope (req.scope) so a Manager's register covers only
 *     their reporting sub-tree (withEmployeeScope in the routes);
 *   - NEVER recomputes — it reads the frozen sources (registers/sources.js) and
 *     folds them with the pure projector; a non-frozen source returns
 *     { frozen:false, reason } (HTTP 200 for preview, 409 for export).
 *
 * RBAC: read/export = canViewPayrollReports; definition management =
 * canManageStatutory (enforced in registers.routes.js).
 */

const crypto = require('crypto');
const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const { assertCountry } = require('../tenant/countryContext');
const { ROLES } = require('../../core/lib/roles');
const { effectivePermissions } = require('../../core/lib/rbac');
const projector = require('./projector');
const seed = require('./india.registers.seed');
const sources = require('./sources');
const exporters = require('./exporters');

// ── PII masking (Feature 32 §6) ───────────────────────────────────────────────
// The register read/export grant is canViewPayrollReports — a broad capability a
// tenant can hand to a line manager via a custom role. Statutory PII (PAN, UAN,
// ESIC IP, DOB, home address) must NOT be emitted in the clear to that standard
// holder; only an actor with the dedicated statutory grant (canManageStatutory —
// the same key that gates definition management) or an owner/super-admin sees it
// unmasked. We compute the maskable column keys off the resolved definition (any
// statutory-identity column + the employee register's DOB/address) and pass the
// set into the pure projector, which redacts the DISPLAY value only.

// Column keys that always carry statutory/identity PII in the seeded forms; plus
// any column flagged statutory:true with an identity-style transform is masked.
const PII_TRANSFORMS = new Set(['uan', 'pan', 'identity']);
const PII_COLUMN_KEYS = new Set(['uan', 'pan', 'esic', 'dob', 'addr']);

/** True when the actor may see statutory PII unmasked (higher key / owner). */
function canViewUnmaskedPii(user) {
  if (!user) return false;
  if (user.role === ROLES.SUPER_ADMIN || user.role === ROLES.BUSINESS_ADMIN) return true;
  const perms = effectivePermissions(user) || {};
  // The dedicated statutory grant is the "higher key" — the same permission that
  // owns the definitions (so a statutory admin already sees raw identifiers).
  return !!perms.canManageStatutory;
}

/**
 * resolveMaskFields(user, definition) → Set<columnKey> to redact for this actor.
 * Empty set when the actor holds the higher key. PURE given (user, definition).
 */
function resolveMaskFields(user, definition) {
  if (canViewUnmaskedPii(user)) return new Set();
  const cols = (definition && definition.columns) || [];
  const out = new Set();
  for (const c of cols) {
    if (!c || !c.key) continue;
    if (PII_COLUMN_KEYS.has(c.key)) { out.add(c.key); continue; }
    if (c.statutory && c.transform && PII_TRANSFORMS.has(c.transform)) out.add(c.key);
  }
  return out;
}

// ── error helpers (mirror compliance/reports controllers) ─────────────────────

function err(res, status, message, code) {
  const body = { message };
  if (code) body.code = code;
  return res.status(status).json(body);
}
function handleError(res, e) {
  const status = e && e.statusCode ? e.statusCode : 500;
  if (status === 500) {
    // eslint-disable-next-line no-console
    console.error('[registers.controller]', e && e.stack ? e.stack : e);
  }
  const body = { message: e && e.message ? e.message : 'Internal error' };
  if (e && e.code) body.code = e.code;
  return res.status(status).json(body);
}

// ── shared lookups (tenant-scoped) ────────────────────────────────────────────

/** Load the entity (tenant-scoped) + assert India. Throws 404/422. */
async function loadEntityOrThrow(businessId, entityId) {
  const entity = await sources.loadEntityHeader(businessId, entityId);
  if (!entity) {
    const e = new Error('Entity not found.');
    e.statusCode = 404;
    e.code = 'ENTITY_NOT_FOUND';
    throw e;
  }
  if (entity.countryCode !== 'IN') {
    const e = new Error('Statutory registers are India-only.');
    e.statusCode = 422;
    e.code = 'COUNTRY_NOT_SUPPORTED';
    throw e;
  }
  return entity;
}

/**
 * resolveDefinition — the active RegisterDefinition for (entity, kind, formCode,
 * stateCode, asOf), preferring an entity-scoped override over a tenant-default
 * row; falling back to the built-in seed layout when nothing is seeded yet (so the
 * feature works before any seed runs). Tenant-scoped.
 */
async function resolveDefinition(businessId, { entityId, kind, formCode, stateCode, asOf }) {
  const asOfDate = asOf ? new Date(asOf) : new Date();
  const rows = await prisma.registerDefinition.findMany({
    where: {
      businessId,
      isActive: true,
      kind,
      ...(formCode ? { formCode } : {}),
      OR: [{ entityId: entityId || undefined }, { entityId: null }],
    },
    orderBy: [{ effectiveFrom: 'desc' }],
  });
  // Effective-dated + state filter + entity-override preference.
  const eligible = rows.filter((r) => {
    if (r.effectiveFrom && new Date(r.effectiveFrom) > asOfDate) return false;
    if (r.effectiveTo && new Date(r.effectiveTo) < asOfDate) return false;
    if (stateCode) return r.stateCode == null || r.stateCode === stateCode;
    return true;
  });
  // Prefer entity-scoped, then state-specific, then central.
  eligible.sort((a, b) => {
    const aw = (a.entityId ? 2 : 0) + (a.stateCode ? 1 : 0);
    const bw = (b.entityId ? 2 : 0) + (b.stateCode ? 1 : 0);
    return bw - aw;
  });
  if (eligible.length) return eligible[0];

  // Fallback to a built-in seed layout for this kind/form (no DB row yet).
  const builtin = seed.defaultCatalog().find(
    (d) => d.kind === kind && (!formCode || d.formCode === formCode) && (d.stateCode == null || !stateCode || d.stateCode === stateCode)
  );
  if (builtin) return { ...builtin, id: null, _builtin: true };
  return null;
}

/** Active statutory registrations for an entity (applicability source). */
async function loadRegistrations(businessId, entityId) {
  return prisma.statutoryRegistration.findMany({
    where: { businessId, entityId, isActive: true },
    select: { kind: true, stateCode: true },
  });
}

// ── period label + scope helpers ──────────────────────────────────────────────

function periodLabelFor(cadence, period) {
  if (cadence === 'ANNUAL' || cadence === 'PAYRUN_ANNUAL') return `FY${period}`;
  if (cadence === 'HALF_YEARLY') {
    // Normalise to the canonical half-year label (H1-YYYY / H2-YYYY) so a month
    // token still prints the statutory 6-month period it belongs to.
    try { return sources.parseHalfYearPeriod(period).label; } catch (_e) { return String(period || ''); }
  }
  if (cadence === 'SNAPSHOT') return `as-of ${period || new Date().toISOString().slice(0, 10)}`;
  return period; // PERIOD → "YYYY-MM"
}

function periodBoundsFor(definition, period) {
  try {
    if (definition.source === 'PAYRUN_ANNUAL' || definition.cadence === 'ANNUAL') {
      const fy = sources.parseFyPeriod(period);
      return { start: fy.start, end: fy.end };
    }
    if (definition.cadence === 'HALF_YEARLY') {
      // The stored RegisterExport bounds span the FULL 6-month window, not a month.
      const hy = sources.parseHalfYearPeriod(period);
      return { start: hy.start, end: hy.end };
    }
    if (definition.cadence === 'SNAPSHOT') {
      const d = period ? new Date(period) : new Date();
      return { start: d, end: d };
    }
    const m = sources.parseMonthPeriod(period);
    return { start: m.start, end: m.end };
  } catch (_e) {
    const now = new Date();
    return { start: now, end: now };
  }
}

// ── GET /catalog — available registers for an entity/state/date ───────────────

async function catalog(req, res) {
  try {
    const { businessId } = req.user;
    const { entityId, stateCode, asOf } = req.query || {};
    if (!entityId) return err(res, 400, 'entityId is required', 'MISSING_ENTITY');
    const entity = await loadEntityOrThrow(businessId, entityId);
    const regs = await loadRegistrations(businessId, entityId);

    const kinds = new Set(regs.map((r) => r.kind));
    const seStates = new Set(regs.filter((r) => r.kind === 'SHOPS_ESTABLISHMENT' && r.stateCode).map((r) => r.stateCode));
    const effState = stateCode || entity.stateCode || null;

    // Seeded definitions for this tenant/entity (active, effective as-of).
    const asOfDate = asOf ? new Date(asOf) : new Date();
    const seeded = await prisma.registerDefinition.findMany({
      where: { businessId, isActive: true, OR: [{ entityId }, { entityId: null }] },
      select: { id: true, kind: true, formCode: true, formLabel: true, actLabel: true, stateCode: true, cadence: true, source: true, effectiveFrom: true, effectiveTo: true },
      orderBy: [{ kind: 'asc' }, { effectiveFrom: 'desc' }],
    });
    const seededActive = seeded.filter((r) => {
      if (r.effectiveFrom && new Date(r.effectiveFrom) > asOfDate) return false;
      if (r.effectiveTo && new Date(r.effectiveTo) < asOfDate) return false;
      return true;
    });

    // Built-in catalog (always-available fallback), filtered by applicability.
    const builtin = seed.defaultCatalog().filter((d) => {
      if (d.kind === 'PF_ANNUAL' && !kinds.has('EPF')) return false;
      if (d.kind === 'ESI_REGISTER' && !kinds.has('ESI')) return false;
      if (d.kind === 'MUSTER_WAGE_COMBINED' && d.stateCode && !seStates.has(d.stateCode)) return false;
      return true;
    });

    // Merge: a seeded row supersedes a built-in of the same (kind, formCode, stateCode).
    const key = (d) => `${d.kind}|${d.formCode}|${d.stateCode || ''}`;
    const map = new Map();
    for (const d of builtin) map.set(key(d), { ...d, source: d.source, id: null, builtin: true, applicable: true });
    for (const r of seededActive) map.set(key(r), { ...r, builtin: false, applicable: true });

    const items = [...map.values()].map((d) => ({
      id: d.id || null,
      kind: d.kind,
      formCode: d.formCode,
      formLabel: d.formLabel,
      actLabel: d.actLabel,
      stateCode: d.stateCode || null,
      cadence: d.cadence,
      source: d.source,
      builtin: !!d.builtin,
      group: groupForKind(d.kind),
    }));
    // Sort: group then form label.
    items.sort((a, b) => (a.group === b.group ? a.formLabel.localeCompare(b.formLabel) : a.group.localeCompare(b.group)));

    return res.json({
      entity: { id: entity.id, code: entity.code, name: entity.tradeName || entity.legalName, stateCode: entity.stateCode || null },
      stateCode: effState,
      items,
    });
  } catch (e) {
    return handleError(res, e);
  }
}

function groupForKind(kind) {
  if (kind === 'MUSTER_ROLL' || kind === 'OVERTIME_REGISTER') return 'Attendance';
  if (kind === 'WAGE_REGISTER' || kind === 'MUSTER_WAGE_COMBINED' || kind === 'FINES_REGISTER') return 'Wages';
  if (kind === 'LEAVE_REGISTER') return 'Leave';
  if (kind === 'PF_ANNUAL' || kind === 'ESI_REGISTER') return 'Annual';
  if (kind === 'EMPLOYEE_REGISTER') return 'Employees';
  return 'Other';
}

// ── build a register (shared by preview + export) ─────────────────────────────

async function buildRegisterFor(req, { entityId, kind, formCode, stateCode, period, asOf }) {
  const businessId = req.user.businessId;
  const entity = await loadEntityOrThrow(businessId, entityId);
  const definition = await resolveDefinition(businessId, { entityId, kind, formCode, stateCode: stateCode || entity.stateCode, asOf });
  if (!definition) {
    const e = new Error(`No register definition found for ${kind}/${formCode || '*'}.`);
    e.statusCode = 404;
    e.code = 'NO_DEFINITION';
    throw e;
  }
  // Resolve the period for SNAPSHOT/ANNUAL cadences (period may be a date/FY).
  const bundle = await sources.loadBundleForSource(definition.source, {
    businessId, entityId, period, scope: req.scope, cadence: definition.cadence,
  });
  const periodObj = bundle.period || resolvePeriodObj(definition, period);
  // Derive the PII mask set from the actor's permissions and redact in the pure
  // projector (an exporter never emits a field the actor can't read — §6).
  const maskFields = resolveMaskFields(req.user, definition);
  const reg = projector.buildRegister(definition, bundle, { period: periodObj, window: bundle.window, maskFields });
  // Attach period label + bounds for the title block + export log.
  const bounds = periodBoundsFor(definition, period);
  if (reg.frozen !== false) {
    reg.meta = reg.meta || {};
    reg.meta.periodLabel = periodLabelFor(definition.cadence, period);
  }
  return { entity, definition, bundle, reg, bounds, periodLabel: periodLabelFor(definition.cadence, period) };
}

function resolvePeriodObj(definition, period) {
  if (definition.cadence === 'PERIOD' && /^\d{4}-\d{2}$/.test(String(period || ''))) {
    const m = sources.parseMonthPeriod(period);
    return { year: m.year, month: m.month };
  }
  return null;
}

// ── GET /preview — projector JSON for on-screen render (paginated) ────────────

async function preview(req, res) {
  try {
    const { businessId } = req.user;
    const { entityId, kind, formCode, stateCode, period, asOf } = req.query || {};
    if (!entityId || !kind) return err(res, 400, 'entityId and kind are required', 'MISSING_PARAMS');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(500, Math.max(10, parseInt(req.query.pageSize, 10) || 100));

    const built = await buildRegisterFor(req, { entityId, kind, formCode, stateCode, period, asOf });
    const reg = built.reg;
    void businessId;

    if (reg.frozen === false) {
      // Typed NOT_FROZEN — HTTP 200 with the flag so the UI renders the empty state.
      return res.json({
        frozen: false,
        code: reg.code,
        reason: reg.reason,
        meta: reg.meta,
        definition: definitionSummary(built.definition),
      });
    }

    const total = reg.rows.length;
    const start = (page - 1) * pageSize;
    const pageRows = reg.rows.slice(start, start + pageSize);
    return res.json({
      frozen: true,
      definition: definitionSummary(built.definition),
      entity: { id: built.entity.id, code: built.entity.code, name: built.entity.tradeName || built.entity.legalName },
      title: titleHeader(built.entity),
      columns: reg.columns,
      rows: pageRows,
      totals: reg.totals.byColumn,
      meta: reg.meta,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (e) {
    return handleError(res, e);
  }
}

function definitionSummary(d) {
  return {
    id: d.id || null,
    kind: d.kind,
    formCode: d.formCode,
    formLabel: d.formLabel,
    actLabel: d.actLabel,
    stateCode: d.stateCode || null,
    cadence: d.cadence,
    source: d.source,
    builtin: !!d._builtin,
  };
}

function titleHeader(entity) {
  return {
    legalName: entity.legalName,
    tradeName: entity.tradeName,
    addressLine1: entity.addressLine1,
    addressLine2: entity.addressLine2,
    city: entity.city,
    stateCode: entity.stateCode,
    postalCode: entity.postalCode,
    pan: entity.pan,
    tan: entity.tan,
  };
}

// ── GET /export — generate + stream the register; write a RegisterExport row ──

async function exportRegister(req, res) {
  try {
    const { businessId } = req.user;
    const { entityId, kind, formCode, stateCode, period, asOf } = req.query || {};
    const format = String(req.query.format || 'PDF').toUpperCase();
    if (!entityId || !kind) return err(res, 400, 'entityId and kind are required', 'MISSING_PARAMS');
    if (!exporters.FORMATS.includes(format)) return err(res, 400, `Unsupported format "${format}"`, 'BAD_FORMAT');

    const built = await buildRegisterFor(req, { entityId, kind, formCode, stateCode, period, asOf });
    const reg = built.reg;

    if (reg.frozen === false) {
      // Cannot export an unfrozen register — typed 409 (never a recomputed file).
      return err(res, 409, reg.reason || 'Source not frozen — freeze the run / close attendance first.', reg.code || 'NOT_FROZEN');
    }

    const header = titleHeader(built.entity);
    const generatedAt = new Date().toISOString();
    const fileBase = `${kind}_${built.definition.formCode}_${built.periodLabel || period || ''}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    const out = await exporters.exportRegister(format, reg, { header, fileBase, generatedAt });

    const bytes = Buffer.isBuffer(out.content) ? out.content : Buffer.from(out.content, 'utf8');
    const fileHash = crypto.createHash('sha256').update(bytes).digest('hex');

    // Persist the artefact log (audit + tamper evidence + reproducibility). Money
    // control totals printed in paise-exact rupees.
    const controlTotals = {};
    for (const [k, t] of Object.entries(reg.totals.byColumn || {})) {
      if (t && t.money) controlTotals[k] = t.value;
    }
    const sourceRefs = built.bundle.sourceRefs || {};
    let exportRow = null;
    try {
      exportRow = await prisma.registerExport.create({
        data: {
          businessId,
          definitionId: built.definition.id || null,
          entityId,
          kind,
          formCode: built.definition.formCode,
          stateCode: built.definition.stateCode || null,
          periodStart: built.bounds.start,
          periodEnd: built.bounds.end,
          periodLabel: built.periodLabel || String(period || ''),
          format,
          sourceRefs,
          rowCount: reg.rowCount,
          controlTotals,
          fileHash,
          generatedByUserId: req.user.id,
        },
        select: { id: true },
      });
    } catch (_e) { /* non-fatal — the download still proceeds */ }

    await writeAudit({
      businessId,
      actorId: req.user.id,
      action: 'registers.export',
      entityType: 'RegisterExport',
      entityId: exportRow ? exportRow.id : entityId,
      meta: { kind, formCode: built.definition.formCode, period: built.periodLabel, format, rowCount: reg.rowCount, fileHash },
    });

    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
    res.setHeader('Content-Length', bytes.length);
    res.setHeader('X-Register-File-Hash', fileHash);
    return res.status(200).send(bytes);
  } catch (e) {
    return handleError(res, e);
  }
}

// ── GET /exports — history of generated registers ─────────────────────────────

async function listExports(req, res) {
  try {
    const { businessId } = req.user;
    const { entityId, kind, from, to } = req.query || {};
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize, 10) || 50));
    const where = { businessId };
    if (entityId) where.entityId = entityId;
    if (kind) where.kind = kind;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }
    const [items, total] = await Promise.all([
      prisma.registerExport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, entityId: true, kind: true, formCode: true, stateCode: true,
          periodLabel: true, format: true, rowCount: true, controlTotals: true,
          fileHash: true, fileUrl: true, generatedByUserId: true, createdAt: true,
        },
      }),
      prisma.registerExport.count({ where }),
    ]);
    return res.json({ items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  } catch (e) {
    return handleError(res, e);
  }
}

// ── GET /definitions — list the tenant's register definitions ─────────────────

async function listDefinitions(req, res) {
  try {
    const { businessId } = req.user;
    const { entityId } = req.query || {};
    const where = { businessId };
    if (entityId) where.OR = [{ entityId }, { entityId: null }];
    const items = await prisma.registerDefinition.findMany({
      where,
      orderBy: [{ kind: 'asc' }, { effectiveFrom: 'desc' }],
    });
    return res.json({ items });
  } catch (e) {
    return handleError(res, e);
  }
}

// ── POST /definitions — add/override a per-state form ─────────────────────────

const VALID_KINDS = ['MUSTER_ROLL', 'WAGE_REGISTER', 'MUSTER_WAGE_COMBINED', 'OVERTIME_REGISTER', 'LEAVE_REGISTER', 'FINES_REGISTER', 'EMPLOYEE_REGISTER', 'PF_ANNUAL', 'ESI_REGISTER'];
const VALID_CADENCES = ['PERIOD', 'HALF_YEARLY', 'ANNUAL', 'SNAPSHOT'];
const VALID_SOURCES_ENUM = ['ATTENDANCE', 'PAYRUN', 'LEAVE', 'EMPLOYEE', 'PAYRUN_ANNUAL'];

async function createDefinition(req, res) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    if (!VALID_KINDS.includes(b.kind)) return err(res, 422, `Invalid kind "${b.kind}"`, 'BAD_KIND');
    if (!VALID_CADENCES.includes(b.cadence)) return err(res, 422, `Invalid cadence "${b.cadence}"`, 'BAD_CADENCE');
    if (!VALID_SOURCES_ENUM.includes(b.source)) return err(res, 422, `Invalid source "${b.source}"`, 'BAD_SOURCE');
    if (!b.formCode || !b.formLabel || !b.actLabel) return err(res, 422, 'formCode, formLabel, actLabel are required', 'MISSING_FIELDS');
    try { projector.assertColumns(b.columns); } catch (e) { return err(res, 422, e.message, e.code || 'BAD_COLUMNS'); }

    if (b.entityId) {
      const entity = await prisma.entity.findFirst({ where: { id: b.entityId, businessId }, select: { id: true } });
      if (!entity) return err(res, 404, 'Entity not found', 'ENTITY_NOT_FOUND');
    }

    const created = await prisma.registerDefinition.create({
      data: {
        businessId,
        entityId: b.entityId || null,
        kind: b.kind,
        formCode: b.formCode,
        formLabel: b.formLabel,
        actLabel: b.actLabel,
        stateCode: b.stateCode || null,
        cadence: b.cadence,
        source: b.source,
        columns: b.columns,
        effectiveFrom: b.effectiveFrom ? new Date(b.effectiveFrom) : new Date(),
        effectiveTo: b.effectiveTo ? new Date(b.effectiveTo) : null,
        isActive: b.isActive !== false,
        meta: b.meta || null,
      },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'registers.definition.create', entityType: 'RegisterDefinition', entityId: created.id, meta: { kind: b.kind, formCode: b.formCode, stateCode: b.stateCode || null } });
    return res.status(201).json(created);
  } catch (e) {
    if (e && e.code === 'P2002') return err(res, 409, 'A definition with this key already exists.', 'DUPLICATE');
    return handleError(res, e);
  }
}

// ── PATCH /definitions/:id — edit columns / toggle / effective dates ──────────

async function updateDefinition(req, res) {
  try {
    const { businessId } = req.user;
    const row = await prisma.registerDefinition.findFirst({ where: { id: req.params.id, businessId } });
    if (!row) return err(res, 404, 'Definition not found', 'NOT_FOUND');
    const b = req.body || {};
    const data = {};
    if (b.columns !== undefined) {
      try { projector.assertColumns(b.columns); } catch (e) { return err(res, 422, e.message, e.code || 'BAD_COLUMNS'); }
      data.columns = b.columns;
    }
    if (b.formLabel !== undefined) data.formLabel = b.formLabel;
    if (b.actLabel !== undefined) data.actLabel = b.actLabel;
    if (b.isActive !== undefined) data.isActive = !!b.isActive;
    if (b.effectiveFrom !== undefined) data.effectiveFrom = new Date(b.effectiveFrom);
    if (b.effectiveTo !== undefined) data.effectiveTo = b.effectiveTo ? new Date(b.effectiveTo) : null;
    if (b.meta !== undefined) data.meta = b.meta;
    if (Object.keys(data).length === 0) return err(res, 422, 'No editable fields supplied', 'NOOP');
    data.version = { increment: 1 };
    const updated = await prisma.registerDefinition.update({ where: { id: row.id }, data });
    await writeAudit({ businessId, actorId: req.user.id, action: 'registers.definition.update', entityType: 'RegisterDefinition', entityId: row.id, meta: { changed: Object.keys(data) } });
    return res.json(updated);
  } catch (e) {
    return handleError(res, e);
  }
}

// ── POST /definitions/seed — (re)derive the default IN definitions ────────────

async function seedDefinitions(req, res) {
  try {
    const { businessId } = req.user;
    const entityId = (req.body && req.body.entityId) || (req.query && req.query.entityId);
    if (!entityId) return err(res, 400, 'entityId is required', 'MISSING_ENTITY');
    await loadEntityOrThrow(businessId, entityId);
    const regs = await loadRegistrations(businessId, entityId);
    const defs = seed.buildRegisterDefinitionsForRegistrations(regs, { effectiveFrom: req.body && req.body.effectiveFrom });

    let created = 0;
    let skipped = 0;
    for (const d of defs) {
      // Idempotent upsert on the @@unique key (businessId, entityId, kind, formCode,
      // stateCode, effectiveFrom). We seed entity-scoped rows so an entity owns its
      // forms; entityId is part of the key so re-seeding is safe.
      const existing = await prisma.registerDefinition.findFirst({
        where: { businessId, entityId, kind: d.kind, formCode: d.formCode, stateCode: d.stateCode, effectiveFrom: new Date(d.effectiveFrom) },
        select: { id: true },
      });
      if (existing) { skipped += 1; continue; }
      try {
        await prisma.registerDefinition.create({
          data: {
            businessId, entityId,
            kind: d.kind, formCode: d.formCode, formLabel: d.formLabel, actLabel: d.actLabel,
            stateCode: d.stateCode || null, cadence: d.cadence, source: d.source,
            columns: d.columns, effectiveFrom: new Date(d.effectiveFrom), effectiveTo: d.effectiveTo ? new Date(d.effectiveTo) : null,
            isActive: d.isActive !== false, meta: d.meta || null,
          },
        });
        created += 1;
      } catch (e) {
        if (e && e.code === 'P2002') { skipped += 1; continue; }
        throw e;
      }
    }
    await writeAudit({ businessId, actorId: req.user.id, action: 'registers.definition.seed', entityType: 'Entity', entityId, meta: { created, skipped, total: defs.length } });
    return res.json({ entityId, created, skipped, total: defs.length });
  } catch (e) {
    return handleError(res, e);
  }
}

module.exports = {
  catalog,
  preview,
  exportRegister,
  listExports,
  listDefinitions,
  createDefinition,
  updateDefinition,
  seedDefinitions,
  // exposed for tests
  resolveDefinition,
  loadEntityOrThrow,
  resolveMaskFields,
  canViewUnmaskedPii,
};
