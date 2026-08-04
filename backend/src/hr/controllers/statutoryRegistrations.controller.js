'use strict';

/**
 * statutoryRegistrations.controller.js — Entity → Registrations CRUD.
 *
 * Closes a real product gap, not a nice-to-have: StatutoryRegistration was already
 * READ by calendarRunner.seedObligationsForEntity (it is the applicability gate for
 * every compliance obligation) and by registers.controller.js, and
 * app/payroll/compliance already tells operators to "add your EPFO / ESIC / PT / TAN
 * registrations under Entity → Registrations" — a screen that did not exist, behind
 * an API that did not exist. Without this, three setup steps
 * (statutory_registrations, compliance_calendar, statutory_registers) can never turn
 * green and the filing calendar stays permanently empty.
 *
 * Tenant-scoped on every path: the entity is re-verified against
 * req.user.businessId before any write, and :id lookups use findFirst({ id,
 * businessId }) so a foreign-tenant id 404s rather than 403s (no existence oracle).
 *
 * The natural key is (businessId, entityId, kind, stateCode). The DB constraint is
 * only HALF of it — Postgres treats NULLs as distinct, so the index does not stop a
 * second entity-wide EPF/ESI/TAN row — hence the explicit pre-check in create().
 * Either way a duplicate comes back as a readable 409, never a raw Prisma error.
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');

// RegistrationKind, split by the country it belongs to. PT and LWF are levied per
// state, so they carry a stateCode; the rest are entity-wide.
const KINDS_BY_COUNTRY = Object.freeze({
  IN: ['EPF', 'ESI', 'PT_STATE', 'TAN', 'LWF', 'SHOPS_ESTABLISHMENT'],
  NZ: ['IRD_PAYE', 'ACC'],
});
const ALL_KINDS = Object.freeze([...KINDS_BY_COUNTRY.IN, ...KINDS_BY_COUNTRY.NZ]);
const STATE_SCOPED_KINDS = Object.freeze(new Set(['PT_STATE', 'LWF']));

const MAX_NUMBER_LEN = 64;

function cleanNumber(v) {
  return String(v == null ? '' : v).trim().slice(0, MAX_NUMBER_LEN);
}

// Accept a plain YYYY-MM-DD (the @db.Date columns) or a full ISO timestamp.
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? undefined : d; // undefined = unparseable
}

// Resolve an entity that belongs to THIS tenant. Returns null for anything else,
// including a live entity in someone else's business.
function findTenantEntity(businessId, entityId) {
  return prisma.entity.findFirst({
    where: { id: String(entityId || ''), businessId, deletedAt: null },
    select: { id: true, code: true, legalName: true, countryCode: true },
  });
}

const PUBLIC = [
  'id', 'entityId', 'kind', 'number', 'stateCode',
  'effectiveFrom', 'effectiveTo', 'isActive', 'meta', 'createdAt', 'updatedAt',
];
function publicRow(row) {
  const out = {};
  for (const f of PUBLIC) if (row[f] !== undefined) out[f] = row[f];
  if (row.entity) out.entity = { id: row.entity.id, code: row.entity.code, legalName: row.entity.legalName };
  return out;
}

// GET /?entityId= — tenant-scoped list, active first, then newest.
async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId };
    if (req.query.entityId) {
      const entity = await findTenantEntity(businessId, req.query.entityId);
      if (!entity) return res.status(404).json({ message: 'Company not found' });
      where.entityId = entity.id;
    }
    const rows = await prisma.statutoryRegistration.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { kind: 'asc' }, { effectiveFrom: 'desc' }],
      include: { entity: { select: { id: true, code: true, legalName: true } } },
    });
    res.json({ items: rows.map(publicRow), kinds: ALL_KINDS });
  } catch (e) { next(e); }
}

// POST / — { entityId, kind, number, stateCode?, effectiveFrom, effectiveTo?, meta? }
async function create(req, res, next) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};

    const entity = await findTenantEntity(businessId, body.entityId);
    if (!entity) return res.status(404).json({ message: 'Company not found' });

    const kind = String(body.kind || '');
    if (!ALL_KINDS.includes(kind)) {
      return res.status(422).json({ message: `Unknown registration type: ${kind || '(none)'}` });
    }
    // A tenant is single-country, so an ACC registration on an India entity is a
    // data error we should refuse rather than silently store and never use.
    const allowed = KINDS_BY_COUNTRY[entity.countryCode] || [];
    if (!allowed.includes(kind)) {
      return res.status(422).json({ message: `${kind} does not apply to a ${entity.countryCode} company.` });
    }

    const number = cleanNumber(body.number);
    if (!number) return res.status(422).json({ message: 'A registration number is required.' });

    // PT and LWF are state levies — the compliance calendar matches obligations on
    // (kind, stateCode), so a stateless PT row would never fire a reminder.
    const stateCode = body.stateCode ? String(body.stateCode).trim().toUpperCase().slice(0, 8) : null;
    if (STATE_SCOPED_KINDS.has(kind) && !stateCode) {
      return res.status(422).json({ message: `${kind} is levied per state — a state is required.` });
    }

    const effectiveFrom = parseDate(body.effectiveFrom);
    if (effectiveFrom === undefined) return res.status(422).json({ message: 'Effective-from is not a valid date.' });
    if (!effectiveFrom) return res.status(422).json({ message: 'An effective-from date is required.' });
    const effectiveTo = parseDate(body.effectiveTo);
    if (effectiveTo === undefined) return res.status(422).json({ message: 'Effective-to is not a valid date.' });
    if (effectiveTo && effectiveTo < effectiveFrom) {
      return res.status(422).json({ message: 'Effective-to cannot be before effective-from.' });
    }

    const finalState = STATE_SCOPED_KINDS.has(kind) ? stateCode : (stateCode || null);

    // Explicit duplicate check, because the DB constraint cannot do it alone: in
    // Postgres a UNIQUE index treats NULLs as distinct, so
    // @@unique([businessId, entityId, kind, stateCode]) silently permits a SECOND
    // EPF/ESI/TAN row (stateCode NULL) for the same company. Two active rows of one
    // kind is a live hazard — calendarRunner.isApplicable resolves applicability
    // with a findFirst, so which registration number reaches a filing would be
    // arbitrary. Editing or reactivating the existing row is the correct workflow.
    const clash = await prisma.statutoryRegistration.findFirst({
      where: { businessId, entityId: entity.id, kind, stateCode: finalState },
      select: { id: true, isActive: true },
    });
    if (clash) {
      return res.status(409).json({
        message: `This company already has ${kind}${finalState ? ` for ${finalState}` : ''} registered. `
          + `${clash.isActive ? 'Edit that registration' : 'Reactivate it'} instead of adding a second one.`,
        existingId: clash.id,
      });
    }

    let row;
    try {
      row = await prisma.statutoryRegistration.create({
        data: {
          businessId,
          entityId: entity.id,
          kind,
          number,
          stateCode: finalState,
          effectiveFrom,
          effectiveTo: effectiveTo || null,
          meta: (body.meta && typeof body.meta === 'object') ? body.meta : undefined,
        },
      });
    } catch (err) {
      // Race backstop: two concurrent creates of a STATE-scoped kind still land on
      // the DB constraint.
      if (err && err.code === 'P2002') {
        return res.status(409).json({
          message: `This company already has ${kind}${stateCode ? ` for ${stateCode}` : ''} registered.`,
        });
      }
      throw err;
    }

    await writeAudit({
      businessId, actorId: req.user.id,
      action: 'statutory.registration.create', entityType: 'StatutoryRegistration', entityId: row.id,
      meta: { entityId: entity.id, kind, stateCode: row.stateCode },
    });
    res.status(201).json(publicRow(row));
  } catch (e) { next(e); }
}

// PATCH /:id — number / state / effective window / meta / reactivate. The natural
// key (entityId, kind) is immutable: retire the row and add the right one instead.
async function update(req, res, next) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};
    const existing = await prisma.statutoryRegistration.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Registration not found' });

    const data = {};
    if (body.number !== undefined) {
      const number = cleanNumber(body.number);
      if (!number) return res.status(422).json({ message: 'A registration number is required.' });
      data.number = number;
    }
    if (body.stateCode !== undefined) {
      const stateCode = body.stateCode ? String(body.stateCode).trim().toUpperCase().slice(0, 8) : null;
      if (STATE_SCOPED_KINDS.has(existing.kind) && !stateCode) {
        return res.status(422).json({ message: `${existing.kind} is levied per state — a state is required.` });
      }
      data.stateCode = stateCode;
    }
    if (body.effectiveFrom !== undefined) {
      const d = parseDate(body.effectiveFrom);
      if (!d) return res.status(422).json({ message: 'Effective-from is not a valid date.' });
      data.effectiveFrom = d;
    }
    if (body.effectiveTo !== undefined) {
      const d = parseDate(body.effectiveTo);
      if (d === undefined) return res.status(422).json({ message: 'Effective-to is not a valid date.' });
      data.effectiveTo = d;
    }
    if (body.meta !== undefined) data.meta = (body.meta && typeof body.meta === 'object') ? body.meta : null;
    if (body.isActive !== undefined) data.isActive = !!body.isActive;

    const from = data.effectiveFrom || existing.effectiveFrom;
    const to = data.effectiveTo !== undefined ? data.effectiveTo : existing.effectiveTo;
    if (to && from && to < from) {
      return res.status(422).json({ message: 'Effective-to cannot be before effective-from.' });
    }

    if (Object.keys(data).length === 0) return res.json(publicRow(existing));

    let row;
    try {
      row = await prisma.statutoryRegistration.update({ where: { id: existing.id }, data });
    } catch (err) {
      if (err && err.code === 'P2002') {
        return res.status(409).json({ message: 'Another registration of this type already covers that state.' });
      }
      throw err;
    }

    await writeAudit({
      businessId, actorId: req.user.id,
      action: 'statutory.registration.update', entityType: 'StatutoryRegistration', entityId: row.id,
      meta: { changed: Object.keys(data), kind: row.kind },
    });
    res.json(publicRow(row));
  } catch (e) { next(e); }
}

// DELETE /:id — SOFT (isActive=false). The row is the historical applicability
// record behind already-generated obligations and filed registers; hard-deleting it
// would orphan them.
async function remove(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.statutoryRegistration.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Registration not found' });

    const row = await prisma.statutoryRegistration.update({
      where: { id: existing.id },
      data: { isActive: false },
    });
    await writeAudit({
      businessId, actorId: req.user.id,
      action: 'statutory.registration.deactivate', entityType: 'StatutoryRegistration', entityId: row.id,
      meta: { kind: row.kind, stateCode: row.stateCode },
    });
    res.json({ message: 'Registration deactivated', item: publicRow(row) });
  } catch (e) { next(e); }
}

module.exports = { list, create, update, remove, KINDS_BY_COUNTRY, ALL_KINDS };
