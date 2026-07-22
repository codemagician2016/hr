'use strict';

/**
 * reportBuilder.controller.js — HTTP layer for the Reports Platform builder:
 * dataset registry metadata, saved ReportDefinition CRUD + run/export, ad-hoc
 * preview runs, and ReportSchedule CRUD + run-now.
 *
 * Mounted under /api/hr/reports (see reports.routes.js). RBAC:
 *   - canViewReports      → datasets / definitions read+run+export / run-adhoc
 *   - canScheduleReports  → schedules CRUD + run-now
 * Every query is tenant-walled (req.user.businessId) AND F1-scoped: the
 * dataset fetches AND scopeWhere(req.scope) into their where-clauses, so a
 * TEAM-band manager's report covers only their reporting sub-tree (NONE scope
 * → empty, fail-closed).
 *
 * Definition visibility: isShared=true → every report viewer; false → creator
 * only. Mutations (PATCH/DELETE) are creator-only.
 */

const prisma = require('../../core/lib/prisma');
const { datasetsMeta } = require('./datasets');
const builder = require('./builder.service');
const { deliverSchedule } = require('./reportScheduleRunner');
const { FORMATS } = require('./export/tabular');

function handleError(res, err) {
  const status = err && err.statusCode ? err.statusCode : (err && err.code === 'NOT_FOUND' ? 404 : 500);
  if (status === 500) {
    // eslint-disable-next-line no-console
    console.error('[reportBuilder.controller]', err && err.stack ? err.stack : err);
  }
  return res.status(status).json({ message: err && err.message ? err.message : 'Internal error' });
}

function httpError(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}

function sendFile(res, out) {
  const bytes = Buffer.isBuffer(out.content) ? out.content : Buffer.from(out.content, 'utf8');
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.fileName}"`);
  res.setHeader('Content-Length', bytes.length);
  return res.end(bytes);
}

function normFormat(raw) {
  const f = String(raw || 'CSV').toUpperCase();
  if (!FORMATS.includes(f)) throw httpError(400, `Unsupported format "${raw}" (allowed: ${FORMATS.join(', ')})`);
  return f;
}

/** The definition-shaped body pulled off a request (create/patch/adhoc). */
function defFromBody(body = {}) {
  return {
    datasetKey: body.datasetKey,
    columns: body.columns,
    filters: body.filters,
    groupBy: body.groupBy,
    sort: body.sort,
    name: body.name,
  };
}

function serializeDefinition(d, userId) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    datasetKey: d.datasetKey,
    columns: d.columnsJson,
    filters: d.filtersJson,
    groupBy: d.groupBy,
    sort: d.sortJson,
    isShared: d.isShared,
    isMine: d.createdByUserId === userId,
    createdByUserId: d.createdByUserId,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/** Load a definition visible to the actor (shared or their own), or 404. */
async function loadVisibleDefinition(req, id) {
  const def = await prisma.reportDefinition.findFirst({
    where: {
      id,
      businessId: req.user.businessId,
      deletedAt: null,
      OR: [{ isShared: true }, { createdByUserId: req.user.id }],
    },
  });
  if (!def) throw httpError(404, 'Report definition not found.');
  return def;
}

// ── datasets ─────────────────────────────────────────────────────────────────

async function getDatasets(req, res) {
  try {
    res.json({ items: datasetsMeta(), formats: FORMATS });
  } catch (err) { handleError(res, err); }
}

// ── definitions CRUD ─────────────────────────────────────────────────────────

async function createDefinition(req, res) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'name is required.');
    const v = builder.validateDefinition(defFromBody(body)); // 400s with the allowed list
    const def = await prisma.reportDefinition.create({
      data: {
        businessId,
        name,
        description: body.description ? String(body.description) : null,
        datasetKey: v.dataset.key,
        columnsJson: v.columnKeys,
        filtersJson: v.filters,
        groupBy: v.groupBy,
        sortJson: v.sort,
        isShared: body.isShared === true,
        createdByUserId: req.user.id,
      },
    });
    res.status(201).json(serializeDefinition(def, req.user.id));
  } catch (err) { handleError(res, err); }
}

async function listDefinitions(req, res) {
  try {
    const { businessId } = req.user;
    const items = await prisma.reportDefinition.findMany({
      where: {
        businessId,
        deletedAt: null,
        OR: [{ isShared: true }, { createdByUserId: req.user.id }],
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 500,
    });
    res.json({ items: items.map((d) => serializeDefinition(d, req.user.id)) });
  } catch (err) { handleError(res, err); }
}

async function getDefinition(req, res) {
  try {
    const def = await loadVisibleDefinition(req, req.params.id);
    res.json(serializeDefinition(def, req.user.id));
  } catch (err) { handleError(res, err); }
}

async function updateDefinition(req, res) {
  try {
    const def = await loadVisibleDefinition(req, req.params.id);
    if (def.createdByUserId !== req.user.id) throw httpError(403, 'Only the creator can edit this report.');
    const body = req.body || {};

    // Merge: any omitted piece keeps its stored value; the merged definition is
    // re-validated whole so a partial patch can never leave an invalid state.
    const merged = {
      datasetKey: body.datasetKey !== undefined ? body.datasetKey : def.datasetKey,
      columns: body.columns !== undefined ? body.columns : def.columnsJson,
      filters: body.filters !== undefined ? body.filters : def.filtersJson,
      groupBy: body.groupBy !== undefined ? body.groupBy : def.groupBy,
      sort: body.sort !== undefined ? body.sort : def.sortJson,
    };
    const v = builder.validateDefinition(merged);

    const data = {
      datasetKey: v.dataset.key,
      columnsJson: v.columnKeys,
      filtersJson: v.filters,
      groupBy: v.groupBy,
      sortJson: v.sort,
    };
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) throw httpError(400, 'name cannot be empty.');
      data.name = name;
    }
    if (body.description !== undefined) data.description = body.description ? String(body.description) : null;
    if (body.isShared !== undefined) data.isShared = body.isShared === true;

    const updated = await prisma.reportDefinition.update({ where: { id: def.id }, data });
    res.json(serializeDefinition(updated, req.user.id));
  } catch (err) { handleError(res, err); }
}

async function deleteDefinition(req, res) {
  try {
    const def = await loadVisibleDefinition(req, req.params.id);
    if (def.createdByUserId !== req.user.id) throw httpError(403, 'Only the creator can delete this report.');
    await prisma.$transaction([
      prisma.reportDefinition.update({ where: { id: def.id }, data: { deletedAt: new Date() } }),
      // Schedules of a deleted definition stop firing (and stop cluttering the runner).
      prisma.reportSchedule.updateMany({
        where: { businessId: def.businessId, reportDefinitionId: def.id },
        data: { isActive: false },
      }),
    ]);
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
}

// ── run / export ─────────────────────────────────────────────────────────────

async function runDefinition(req, res) {
  try {
    const def = await loadVisibleDefinition(req, req.params.id);
    const { page, pageSize } = req.body || {};
    const result = await builder.runDefinition(
      { datasetKey: def.datasetKey, columns: def.columnsJson, filters: def.filtersJson, groupBy: def.groupBy, sort: def.sortJson },
      { businessId: req.user.businessId, scope: req.scope, page, pageSize },
    );
    res.json(result);
  } catch (err) { handleError(res, err); }
}

async function exportDefinition(req, res) {
  try {
    const format = normFormat(req.query && req.query.format);
    const def = await loadVisibleDefinition(req, req.params.id);
    const out = await builder.renderExport(
      { datasetKey: def.datasetKey, columns: def.columnsJson, filters: def.filtersJson, groupBy: def.groupBy, sort: def.sortJson },
      format,
      { businessId: req.user.businessId, scope: req.scope, title: def.name },
    );
    sendFile(res, out);
  } catch (err) { handleError(res, err); }
}

// Ad-hoc run — an UNSAVED definition body, for the builder's live preview.
async function runAdhoc(req, res) {
  try {
    const body = req.body || {};
    const result = await builder.runDefinition(defFromBody(body), {
      businessId: req.user.businessId,
      scope: req.scope,
      page: body.page,
      pageSize: body.pageSize,
    });
    res.json(result);
  } catch (err) { handleError(res, err); }
}

// ── schedules CRUD ───────────────────────────────────────────────────────────

const CRON_PRESETS = ['DAILY', 'WEEKLY', 'MONTHLY'];

function validateScheduleBody(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.cronPreset !== undefined) {
    const preset = String(body.cronPreset || '').toUpperCase();
    if (!CRON_PRESETS.includes(preset)) throw httpError(400, `cronPreset must be one of ${CRON_PRESETS.join(', ')}.`);
    out.cronPreset = preset;
  }
  if (!partial || body.hourUtc !== undefined) {
    const hour = Number(body.hourUtc);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw httpError(400, 'hourUtc must be an integer 0-23.');
    out.hourUtc = hour;
  }
  if (body.anchor !== undefined) {
    if (body.anchor === null) {
      out.anchor = null;
    } else {
      const anchor = Number(body.anchor);
      if (!Number.isInteger(anchor)) throw httpError(400, 'anchor must be an integer (WEEKLY: 0-6 Sun-Sat, MONTHLY: 1-31).');
      out.anchor = anchor;
    }
  }
  if (!partial || body.format !== undefined) {
    out.format = normFormat(body.format);
  }
  if (!partial || body.recipients !== undefined) {
    const raw = Array.isArray(body.recipients) ? body.recipients : null;
    if (!raw || !raw.length) throw httpError(400, 'recipients must be a non-empty array of email addresses.');
    const emails = raw.map((r) => String(r || '').trim());
    const bad = emails.filter((r) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));
    if (bad.length) throw httpError(400, `Invalid recipient email(s): ${bad.join(', ')}`);
    out.recipientsJson = emails;
  }
  if (body.isActive !== undefined) out.isActive = body.isActive === true;
  return out;
}

/** Cross-field anchor check against the (possibly merged) preset. */
function assertAnchorForPreset(preset, anchor) {
  if (preset === 'WEEKLY') {
    const a = anchor == null ? 1 : anchor;
    if (a < 0 || a > 6) throw httpError(400, 'WEEKLY anchor must be a day-of-week 0-6 (Sunday=0).');
  } else if (preset === 'MONTHLY') {
    const a = anchor == null ? 1 : anchor;
    if (a < 1 || a > 31) throw httpError(400, 'MONTHLY anchor must be a day-of-month 1-31.');
  }
}

function serializeSchedule(s) {
  return {
    id: s.id,
    reportDefinitionId: s.reportDefinitionId,
    reportName: s.reportDefinition ? s.reportDefinition.name : undefined,
    cronPreset: s.cronPreset,
    anchor: s.anchor,
    hourUtc: s.hourUtc,
    format: s.format,
    recipients: s.recipientsJson,
    isActive: s.isActive,
    lastRunAt: s.lastRunAt,
    lastStatus: s.lastStatus,
    createdByUserId: s.createdByUserId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function loadSchedule(req, id) {
  const s = await prisma.reportSchedule.findFirst({
    where: { id, businessId: req.user.businessId },
    include: { reportDefinition: true },
  });
  if (!s) throw httpError(404, 'Report schedule not found.');
  return s;
}

async function createSchedule(req, res) {
  try {
    const body = req.body || {};
    const defId = String(body.reportDefinitionId || '');
    if (!defId) throw httpError(400, 'reportDefinitionId is required.');
    const def = await loadVisibleDefinition(req, defId); // same-tenant + visible to the actor
    const data = validateScheduleBody(body);
    assertAnchorForPreset(data.cronPreset, data.anchor != null ? data.anchor : null);
    const created = await prisma.reportSchedule.create({
      data: {
        businessId: req.user.businessId,
        reportDefinitionId: def.id,
        cronPreset: data.cronPreset,
        anchor: data.anchor != null ? data.anchor : null,
        hourUtc: data.hourUtc,
        format: data.format,
        recipientsJson: data.recipientsJson,
        isActive: data.isActive !== undefined ? data.isActive : true,
        createdByUserId: req.user.id,
      },
      include: { reportDefinition: true },
    });
    res.status(201).json(serializeSchedule(created));
  } catch (err) { handleError(res, err); }
}

async function listSchedules(req, res) {
  try {
    const items = await prisma.reportSchedule.findMany({
      where: { businessId: req.user.businessId },
      orderBy: [{ createdAt: 'desc' }],
      take: 500,
      include: { reportDefinition: { select: { id: true, name: true, datasetKey: true, deletedAt: true } } },
    });
    res.json({ items: items.map(serializeSchedule) });
  } catch (err) { handleError(res, err); }
}

async function getSchedule(req, res) {
  try {
    const s = await loadSchedule(req, req.params.id);
    res.json(serializeSchedule(s));
  } catch (err) { handleError(res, err); }
}

async function updateSchedule(req, res) {
  try {
    const s = await loadSchedule(req, req.params.id);
    const body = req.body || {};
    const data = validateScheduleBody(body, { partial: true });
    if (body.reportDefinitionId !== undefined) {
      const def = await loadVisibleDefinition(req, String(body.reportDefinitionId));
      data.reportDefinitionId = def.id;
    }
    const preset = data.cronPreset || s.cronPreset;
    const anchor = data.anchor !== undefined ? data.anchor : s.anchor;
    assertAnchorForPreset(preset, anchor);
    const updated = await prisma.reportSchedule.update({
      where: { id: s.id },
      data,
      include: { reportDefinition: true },
    });
    res.json(serializeSchedule(updated));
  } catch (err) { handleError(res, err); }
}

async function deleteSchedule(req, res) {
  try {
    const s = await loadSchedule(req, req.params.id);
    await prisma.reportSchedule.delete({ where: { id: s.id } });
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
}

// Run a schedule immediately (out-of-window manual trigger). Delivers with the
// SAME creator-scope semantics as the cron path and stamps lastRunAt/lastStatus.
async function runScheduleNow(req, res) {
  try {
    const s = await loadSchedule(req, req.params.id);
    const asOf = new Date();
    let result;
    try {
      result = await deliverSchedule(s, { asOf });
    } catch (err) {
      result = { status: `FAILED: ${err && err.message ? err.message : err}`.slice(0, 500), sent: 0 };
    }
    await prisma.reportSchedule.update({
      where: { id: s.id },
      data: { lastRunAt: asOf, lastStatus: result.status },
    });
    res.json({ ok: result.sent > 0, status: result.status, sent: result.sent });
  } catch (err) { handleError(res, err); }
}

module.exports = {
  getDatasets,
  createDefinition,
  listDefinitions,
  getDefinition,
  updateDefinition,
  deleteDefinition,
  runDefinition,
  exportDefinition,
  runAdhoc,
  createSchedule,
  listSchedules,
  getSchedule,
  updateSchedule,
  deleteSchedule,
  runScheduleNow,
};
