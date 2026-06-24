'use strict';

/**
 * compliance.controller.js — HTTP layer for the Statutory Compliance Calendar
 * (Feature 23), mounted at /api/hr/compliance. Thin: validates the request shape,
 * calls the runner / prisma, translates errors. Every query is businessId-scoped
 * from req.user.businessId; :id lookups use findFirst({ id, businessId }) so
 * cross-tenant access 404s.
 *
 * RBAC (enforced by the router):
 *   read (calendar/detail/obligations-list) → canViewPayrollReports
 *   mutations (mark-filed/proof/waive/obligations/seed/sweep) → canManageStatutory
 */

const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');
const runner = require('./calendarRunner');
const cal = require('./india.calendar');

// ── upload guards (challan/proof: ≤10 MB, PDF/PNG/JPG) — reused from documents ──
const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const ALLOWED_PROOF_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);

function validateProofDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return { ok: false, status: 400, message: 'A proof file (base64 data URL) is required' };
  const m = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(dataUrl);
  if (!m || !m[2]) return { ok: false, status: 422, message: 'Only base64 data URLs are supported' };
  const mime = m[1].toLowerCase();
  if (!ALLOWED_PROOF_MIME.has(mime)) return { ok: false, status: 422, message: `Unsupported proof type: ${mime}. Allowed: PDF, PNG, JPG.` };
  const b64 = m[3] || '';
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const approxBytes = Math.floor((b64.length * 3) / 4) - padding;
  if (approxBytes > MAX_PROOF_BYTES) return { ok: false, status: 413, message: `File exceeds the ${MAX_PROOF_BYTES / (1024 * 1024)} MB upload limit` };
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length > MAX_PROOF_BYTES) return { ok: false, status: 413, message: `File exceeds the ${MAX_PROOF_BYTES / (1024 * 1024)} MB upload limit` };
  return { ok: true, mime, buffer, bytes: buffer.length };
}

function err(res, status, message, code) {
  const body = { message };
  if (code) body.code = code;
  return res.status(status).json(body);
}
function fail(res, e) {
  const status = e && (e.status || e.statusCode) ? (e.status || e.statusCode) : 500;
  if (status === 500) console.error('[compliance.controller]', e && e.stack ? e.stack : e);
  return res.status(status).json({ message: (e && e.message) || 'Internal error', ...(e && e.code ? { code: e.code } : {}) });
}

function toUtc(d) {
  if (!d) return null;
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

// Derive the UI status label from the persisted status + dueDate + reminder window.
// Persisted enum is PENDING/DUE/FILED/PAID/OVERDUE/WAIVED; the UI label maps PENDING
// outside the window to "UPCOMING" and inside to "DUE_SOON".
function deriveDisplayStatus(row, reminderDays, asOf) {
  const now = toUtc(asOf || new Date());
  const due = toUtc(row.dueDate);
  if (row.status === 'FILED') return 'FILED';
  if (row.status === 'PAID') return 'FILED';
  if (row.status === 'WAIVED') return 'WAIVED';
  if (row.status === 'OVERDUE') return 'OVERDUE';
  if (due && due.getTime() < now.getTime()) return 'OVERDUE'; // not yet swept
  const window = Math.max(...((Array.isArray(reminderDays) && reminderDays.length) ? reminderDays : [7, 3, 1, 0]));
  const windowStart = due ? new Date(due.getTime() - window * 24 * 3600 * 1000) : null;
  if (due && now.getTime() === due.getTime()) return 'DUE_TODAY';
  if (windowStart && now.getTime() >= windowStart.getTime()) return 'DUE_SOON';
  return 'UPCOMING';
}

function daysLeft(dueDate, asOf) {
  const due = toUtc(dueDate);
  const now = toUtc(asOf || new Date());
  return Math.round((due.getTime() - now.getTime()) / (24 * 3600 * 1000));
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /compliance/calendar — the feed (persisted instances + on-the-fly future
//   stubs so the UI is complete even before the cron runs). Filters: from/to/
//   entityId/kind/status. Paginated.
// ─────────────────────────────────────────────────────────────────────────────
async function getCalendar(req, res) {
  try {
    const businessId = req.user.businessId;
    const { entityId, kind, status } = req.query || {};
    const from = req.query.from ? toUtc(req.query.from) : toUtc(new Date());
    const to = req.query.to ? toUtc(req.query.to) : new Date(toUtc(new Date()).getTime() + 120 * 24 * 3600 * 1000);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));

    // 1) Persisted instances in range.
    const where = {
      businessId,
      dueDate: { gte: from, lte: to },
      ...(entityId ? { entityId } : {}),
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
    };
    const persisted = await prisma.statutoryRemittance.findMany({
      where, orderBy: { dueDate: 'asc' }, take: 5000,
      include: { obligation: { select: { id: true, reminderDays: true, cadence: true, stateCode: true, meta: true, supersededBy: true } } },
    });

    // 2) On-the-fly future stubs for obligations that have not yet been generated in
    //    this window (so a freshly-seeded tenant sees its calendar before the cron).
    const obligations = await prisma.complianceObligation.findMany({
      where: { businessId, isActive: true, autoGenerate: true, ...(entityId ? { entityId } : {}), ...(kind ? { kind } : {}) },
    });
    const haveKey = new Set(persisted.map((r) => `${r.entityId}|${r.kind}|${r.taxPeriod}|${r.stateCode || ''}`));
    const virtual = [];
    for (const ob of obligations) {
      if (ob.cadence === 'EVENT') continue;
      let periods = [];
      try {
        periods = cal.periodsBetween(
          { kind: ob.kind, cadence: ob.cadence, dueDom: ob.dueDom, dueMonths: ob.dueMonths, offsetMonths: ob.offsetMonths, specialRules: ob.specialRules || undefined, effectiveFrom: ob.effectiveFrom, effectiveTo: ob.effectiveTo },
          from, to,
        );
      } catch (_e) { periods = []; }
      for (const p of periods) {
        const k = `${ob.entityId}|${p.kind}|${p.taxPeriod}|${ob.stateCode || ''}`;
        if (haveKey.has(k)) continue;
        if (status && status !== 'PENDING') continue; // virtual rows are always UPCOMING/PENDING
        haveKey.add(k);
        virtual.push({
          id: null, virtual: true, businessId, entityId: ob.entityId,
          kind: p.kind, taxPeriod: p.taxPeriod, stateCode: ob.stateCode || null,
          amount: '0', currencyCode: 'INR', dueDate: p.dueDate, status: 'PENDING',
          obligationId: ob.id, obligation: { id: ob.id, reminderDays: ob.reminderDays, cadence: ob.cadence, stateCode: ob.stateCode, meta: ob.meta, supersededBy: ob.supersededBy },
          challanRef: null, proofUrl: null, filedDate: null, paidDate: null,
        });
      }
    }

    const all = [...persisted, ...virtual].sort((a, b) => toUtc(a.dueDate) - toUtc(b.dueDate));
    const shaped = all.map((r) => shapeRow(r, req.query.asOf));
    const total = shaped.length;
    const start = (page - 1) * pageSize;
    const items = shaped.slice(start, start + pageSize);

    // banner counts
    const counts = { dueThisWeek: 0, overdue: 0, upcoming: 0, filed: 0 };
    const weekEnd = new Date(toUtc(req.query.asOf || new Date()).getTime() + 7 * 24 * 3600 * 1000);
    for (const r of shaped) {
      if (r.displayStatus === 'OVERDUE') counts.overdue += 1;
      else if (r.displayStatus === 'FILED' || r.displayStatus === 'WAIVED') counts.filed += 1;
      else {
        counts.upcoming += 1;
        if (toUtc(r.dueDate).getTime() <= weekEnd.getTime()) counts.dueThisWeek += 1;
      }
    }

    res.json({ items, page, pageSize, total, totalPages: Math.ceil(total / pageSize), counts });
  } catch (e) { fail(res, e); }
}

function shapeRow(r, asOf) {
  const reminderDays = r.obligation && r.obligation.reminderDays;
  const meta = (r.obligation && r.obligation.meta) || r.meta || {};
  return {
    id: r.id,
    virtual: !!r.virtual,
    entityId: r.entityId,
    kind: r.kind,
    taxPeriod: r.taxPeriod,
    stateCode: r.stateCode || null,
    amount: r.amount != null ? r.amount.toString() : '0',
    currencyCode: r.currencyCode || 'INR',
    dueDate: toUtc(r.dueDate),
    status: r.status,
    displayStatus: deriveDisplayStatus(r, reminderDays, asOf),
    daysLeft: daysLeft(r.dueDate, asOf),
    challanRef: r.challanRef || null,
    filedDate: r.filedDate || null,
    paidDate: r.paidDate || null,
    hasProof: !!r.proofUrl,
    obligationId: r.obligationId || null,
    cadence: r.obligation && r.obligation.cadence,
    label: (meta && meta.label) || runner._internals.labelForKind(r.kind),
    penaltyHint: (meta && meta.penaltyHint) || null,
    govtPortalUrl: (meta && meta.govtPortalUrl) || null,
    supersededBy: (r.obligation && r.obligation.supersededBy) || null,
  };
}

// ── GET /compliance/calendar/:remittanceId — detail (incl. proof + audit) ──
async function getRemittanceDetail(req, res) {
  try {
    const businessId = req.user.businessId;
    const row = await prisma.statutoryRemittance.findFirst({
      where: { id: req.params.remittanceId, businessId },
      include: { obligation: true, payRun: { select: { id: true, code: true } } },
    });
    if (!row) return err(res, 404, 'Compliance item not found', 'NOT_FOUND');
    const audit = await prisma.auditLog.findMany({
      where: { businessId, entityType: 'StatutoryRemittance', entityId: row.id },
      orderBy: { createdAt: 'desc' }, take: 50,
    }).catch(() => []);
    res.json({
      ...shapeRow(row, req.query.asOf),
      proofUrl: row.proofUrl || null,
      proofUploadedAt: row.proofUploadedAt || null,
      filedByUserId: row.filedByUserId || null,
      waivedReason: row.waivedReason || null,
      remindersSent: row.remindersSent,
      reminderStage: row.reminderStage || null,
      payRun: row.payRun || null,
      meta: row.meta || null,
      obligation: row.obligation ? {
        id: row.obligation.id, cadence: row.obligation.cadence, reminderDays: row.obligation.reminderDays,
        effectiveFrom: row.obligation.effectiveFrom, effectiveTo: row.obligation.effectiveTo,
        supersededBy: row.obligation.supersededBy, meta: row.obligation.meta,
      } : null,
      audit: audit.map((a) => ({ action: a.action, actorId: a.actorId, at: a.createdAt, meta: a.meta })),
    });
  } catch (e) { fail(res, e); }
}

// ── POST /compliance/remittances/:id/mark-filed ──
async function markFiled(req, res) {
  try {
    const businessId = req.user.businessId;
    const actorId = req.user.id;
    const { challanRef, filedDate, paidDate } = req.body || {};
    const row = await prisma.statutoryRemittance.findFirst({ where: { id: req.params.id, businessId } });
    if (!row) return err(res, 404, 'Compliance item not found', 'NOT_FOUND');
    if (['WAIVED'].includes(row.status)) return err(res, 409, `Cannot mark a ${row.status} item as filed`, 'BAD_STATE');

    const newStatus = paidDate ? 'PAID' : 'FILED';
    const flip = await prisma.statutoryRemittance.updateMany({
      where: { id: row.id, businessId, version: row.version },
      data: {
        status: newStatus,
        challanRef: challanRef || row.challanRef || null,
        filedDate: filedDate ? new Date(filedDate) : new Date(),
        paidDate: paidDate ? new Date(paidDate) : row.paidDate,
        filedByUserId: actorId,
        version: { increment: 1 },
      },
    });
    if (flip.count === 0) return err(res, 409, 'Item was modified concurrently — refresh and retry', 'CONCURRENCY');
    await writeAudit({ businessId, actorId, action: 'compliance.mark_filed', entityType: 'StatutoryRemittance', entityId: row.id, meta: { kind: row.kind, taxPeriod: row.taxPeriod, status: newStatus, challanRef: challanRef || null } });
    const updated = await prisma.statutoryRemittance.findFirst({ where: { id: row.id, businessId }, include: { obligation: { select: { reminderDays: true, cadence: true, meta: true, supersededBy: true } } } });
    res.json(shapeRow(updated, req.query.asOf));
  } catch (e) { fail(res, e); }
}

// ── POST /compliance/remittances/:id/proof — upload challan/receipt ──
async function uploadProof(req, res) {
  try {
    const businessId = req.user.businessId;
    const actorId = req.user.id;
    const row = await prisma.statutoryRemittance.findFirst({ where: { id: req.params.id, businessId } });
    if (!row) return err(res, 404, 'Compliance item not found', 'NOT_FOUND');

    const dataUrl = (req.body && (req.body.fileBase64 || req.body.proofBase64 || req.body.dataUrl)) || null;
    const check = validateProofDataUrl(dataUrl);
    if (!check.ok) return err(res, check.status, check.message, 'UPLOAD_REJECTED');

    let proofUrl = null;
    const s3 = require('../../../core/lib/s3');
    if (s3.isConfigured && s3.isConfigured()) {
      const up = await s3.uploadDataUrl({ dataUrl, businessId, scope: 'compliance-proof' });
      proofUrl = up.url;
    } else {
      // Fallback: store the validated data URL inline (mirrors the lifecycle docs
      // fallback when S3 is unconfigured — the MIME/size were validated above).
      proofUrl = dataUrl;
    }

    const flip = await prisma.statutoryRemittance.updateMany({
      where: { id: row.id, businessId, version: row.version },
      data: { proofUrl, proofUploadedAt: new Date(), version: { increment: 1 } },
    });
    if (flip.count === 0) return err(res, 409, 'Item was modified concurrently — refresh and retry', 'CONCURRENCY');
    await writeAudit({ businessId, actorId, action: 'compliance.proof_upload', entityType: 'StatutoryRemittance', entityId: row.id, meta: { kind: row.kind, taxPeriod: row.taxPeriod, mime: check.mime, bytes: check.bytes } });
    res.json({ ok: true, hasProof: true, proofUploadedAt: new Date() });
  } catch (e) { fail(res, e); }
}

// ── POST /compliance/remittances/:id/waive ──
async function waive(req, res) {
  try {
    const businessId = req.user.businessId;
    const actorId = req.user.id;
    const { reason } = req.body || {};
    if (!reason || typeof reason !== 'string' || !reason.trim()) return err(res, 400, 'A waiver reason is required', 'REASON_REQUIRED');
    const row = await prisma.statutoryRemittance.findFirst({ where: { id: req.params.id, businessId } });
    if (!row) return err(res, 404, 'Compliance item not found', 'NOT_FOUND');
    if (['FILED', 'PAID'].includes(row.status)) return err(res, 409, `Cannot waive a ${row.status} item`, 'BAD_STATE');
    const flip = await prisma.statutoryRemittance.updateMany({
      where: { id: row.id, businessId, version: row.version },
      data: { status: 'WAIVED', waivedReason: reason.trim(), filedByUserId: actorId, version: { increment: 1 } },
    });
    if (flip.count === 0) return err(res, 409, 'Item was modified concurrently — refresh and retry', 'CONCURRENCY');
    await writeAudit({ businessId, actorId, action: 'compliance.waive', entityType: 'StatutoryRemittance', entityId: row.id, meta: { kind: row.kind, taxPeriod: row.taxPeriod, reason: reason.trim() } });
    const updated = await prisma.statutoryRemittance.findFirst({ where: { id: row.id, businessId }, include: { obligation: { select: { reminderDays: true, cadence: true, meta: true, supersededBy: true } } } });
    res.json(shapeRow(updated, req.query.asOf));
  } catch (e) { fail(res, e); }
}

// ── GET /compliance/obligations?entityId= — list the rule schedule ──
async function listObligations(req, res) {
  try {
    const businessId = req.user.businessId;
    const { entityId } = req.query || {};
    const items = await prisma.complianceObligation.findMany({
      where: { businessId, ...(entityId ? { entityId } : {}) },
      orderBy: [{ entityId: 'asc' }, { kind: 'asc' }, { stateCode: 'asc' }],
    });
    res.json({ items });
  } catch (e) { fail(res, e); }
}

// ── POST /compliance/obligations — create a per-state PT/LWF rule (or ad-hoc) ──
async function createObligation(req, res) {
  try {
    const businessId = req.user.businessId;
    const actorId = req.user.id;
    const b = req.body || {};
    if (!b.entityId || !b.kind || !b.cadence || !b.effectiveFrom) return err(res, 400, 'entityId, kind, cadence, effectiveFrom are required', 'VALIDATION');
    // tenant-scope the entity
    const ent = await prisma.entity.findFirst({ where: { id: b.entityId, businessId }, select: { id: true } });
    if (!ent) return err(res, 404, 'Entity not found', 'NOT_FOUND');
    const created = await prisma.complianceObligation.create({
      data: {
        businessId, entityId: b.entityId, kind: b.kind, stateCode: b.stateCode || null,
        cadence: b.cadence, dueDom: b.dueDom ?? null,
        dueMonths: Array.isArray(b.dueMonths) ? b.dueMonths : [],
        offsetMonths: Number.isInteger(b.offsetMonths) ? b.offsetMonths : 1,
        specialRules: b.specialRules || null,
        effectiveFrom: new Date(b.effectiveFrom), effectiveTo: b.effectiveTo ? new Date(b.effectiveTo) : null,
        supersededBy: b.supersededBy || null,
        isActive: b.isActive !== false, autoGenerate: b.autoGenerate !== false,
        reminderDays: Array.isArray(b.reminderDays) ? b.reminderDays : [7, 3, 1, 0],
        meta: b.meta || null,
      },
    });
    await writeAudit({ businessId, actorId, action: 'compliance.obligation.create', entityType: 'ComplianceObligation', entityId: created.id, meta: { kind: created.kind, stateCode: created.stateCode } });
    res.status(201).json(created);
  } catch (e) {
    if (/unique|P2002/i.test(e.message || e.code || '')) return err(res, 409, 'An obligation with this (kind, state, effectiveFrom) already exists', 'DUPLICATE');
    fail(res, e);
  }
}

// ── PATCH /compliance/obligations/:id — toggle isActive / edit reminderDays / rule ──
async function updateObligation(req, res) {
  try {
    const businessId = req.user.businessId;
    const actorId = req.user.id;
    const existing = await prisma.complianceObligation.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return err(res, 404, 'Obligation not found', 'NOT_FOUND');
    const b = req.body || {};
    const data = { version: { increment: 1 } };
    for (const f of ['dueDom', 'offsetMonths', 'supersededBy']) if (f in b) data[f] = b[f];
    if ('cadence' in b) data.cadence = b.cadence;
    if ('dueMonths' in b) data.dueMonths = Array.isArray(b.dueMonths) ? b.dueMonths : [];
    if ('reminderDays' in b) data.reminderDays = Array.isArray(b.reminderDays) ? b.reminderDays : existing.reminderDays;
    if ('specialRules' in b) data.specialRules = b.specialRules || null;
    if ('isActive' in b) data.isActive = !!b.isActive;
    if ('autoGenerate' in b) data.autoGenerate = !!b.autoGenerate;
    if ('effectiveTo' in b) data.effectiveTo = b.effectiveTo ? new Date(b.effectiveTo) : null;
    if ('meta' in b) data.meta = b.meta || null;
    const flip = await prisma.complianceObligation.updateMany({ where: { id: existing.id, businessId, version: existing.version }, data });
    if (flip.count === 0) return err(res, 409, 'Obligation was modified concurrently', 'CONCURRENCY');
    await writeAudit({ businessId, actorId, action: 'compliance.obligation.update', entityType: 'ComplianceObligation', entityId: existing.id, meta: { changed: Object.keys(b) } });
    const updated = await prisma.complianceObligation.findFirst({ where: { id: existing.id, businessId } });
    res.json(updated);
  } catch (e) { fail(res, e); }
}

// ── POST /compliance/obligations/seed — (re)derive from registrations ──
async function seedObligations(req, res) {
  try {
    const businessId = req.user.businessId;
    const actorId = req.user.id;
    const { entityId } = req.body || {};
    if (!entityId) return err(res, 400, 'entityId is required', 'VALIDATION');
    const ent = await prisma.entity.findFirst({ where: { id: entityId, businessId }, select: { id: true } });
    if (!ent) return err(res, 404, 'Entity not found', 'NOT_FOUND');
    const out = await runner.seedObligationsForEntity({ businessId, entityId, actorId });
    res.json(out);
  } catch (e) { fail(res, e); }
}

// ── POST /compliance/sweep — manual generate+sweep+remind for THIS tenant ──
async function manualSweep(req, res) {
  try {
    const businessId = req.user.businessId;
    const dryRun = !!(req.body && req.body.dryRun);
    const g = await runner.generateUpcomingObligations({ businessId, asOf: new Date(), dryRun });
    const s = await runner.sweepComplianceStatus({ businessId, asOf: new Date(), dryRun });
    const n = await runner.sendComplianceReminders({ businessId, asOf: new Date(), dryRun });
    res.json({ dryRun, generate: g, sweep: s, remind: n });
  } catch (e) { fail(res, e); }
}

module.exports = {
  getCalendar,
  getRemittanceDetail,
  markFiled,
  uploadProof,
  waive,
  listObligations,
  createObligation,
  updateObligation,
  seedObligations,
  manualSweep,
  _internals: { deriveDisplayStatus, validateProofDataUrl, shapeRow },
};
