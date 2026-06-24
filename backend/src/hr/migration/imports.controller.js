'use strict';

/**
 * imports.controller.js — thin operator surface for the Feature 18 import
 * subsystem. All logic lives in imports.service.js / autogen.service.js. Every
 * handler is tenant-scoped by req.user.businessId and admin-gated by
 * canManageImports (the routes attach the gate); the payroll-autogen side-effect
 * additionally requires canRunPayroll (the route enforces it).
 */

const service = require('./imports.service');
const autogen = require('./autogen.service');
const templates = require('./templates');

function actor(req) { return { businessId: req.user.businessId, actorId: req.user.id }; }

function handle(res, next, p) {
  return p.then((data) => res.json(data)).catch((e) => {
    if (e && e.statusCode) return res.status(e.statusCode).json({ message: e.message, code: e.code });
    return next(e);
  });
}

// GET /imports/templates/:kind  → download the CSV template + data dictionary
async function getTemplate(req, res, next) {
  try {
    const kind = String(req.params.kind || '').toUpperCase();
    if (!templates.KINDS.includes(kind)) return res.status(404).json({ message: `unknown kind "${kind}"` });
    const csvText = templates.buildTemplateCsv(kind);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="drifthr-import-${kind.toLowerCase()}.csv"`);
    return res.send(csvText);
  } catch (e) { return next(e); }
}

// POST /imports  (JSON: { kind, entityId?, fileName, contentBase64, mimeType?, options? })
function upload(req, res, next) {
  const { businessId, actorId } = actor(req);
  const { kind, entityId, fileName, contentBase64, mimeType, options } = req.body || {};
  return handle(res, next, service.createJob({ businessId, actorId, kind: String(kind || '').toUpperCase(), entityId, fileName, contentBase64, mimeType, options }));
}

// GET /imports
function list(req, res, next) {
  const { businessId } = actor(req);
  return handle(res, next, service.listJobs({ businessId, kind: req.query.kind, status: req.query.status, page: req.query.page, pageSize: req.query.pageSize }));
}

// GET /imports/:id
function get(req, res, next) {
  const { businessId } = actor(req);
  return handle(res, next, service.getJob({ businessId, jobId: req.params.id }));
}

// PATCH /imports/:id/mapping  ({ mapping })
function patchMapping(req, res, next) {
  const { businessId, actorId } = actor(req);
  return handle(res, next, service.updateMapping({ businessId, actorId, jobId: req.params.id, mapping: req.body && req.body.mapping }));
}

// POST /imports/:id/validate
function validate(req, res, next) {
  const { businessId, actorId } = actor(req);
  return handle(res, next, service.validate({ businessId, actorId, jobId: req.params.id }));
}

// POST /imports/:id/dry-run
function dryRun(req, res, next) {
  const { businessId, actorId } = actor(req);
  return handle(res, next, service.dryRun({ businessId, actorId, jobId: req.params.id }));
}

// POST /imports/:id/commit  ({ autoGenerate? })
function commit(req, res, next) {
  const { businessId, actorId } = actor(req);
  const autoGenerate = req.body && req.body.autoGenerate === false ? false : true;
  return handle(res, next, service.commit({ businessId, actorId, jobId: req.params.id, autoGenerate }));
}

// POST /imports/:id/autogen   (requires canRunPayroll — enforced by the route)
function runAutogen(req, res, next) {
  const { businessId, actorId } = actor(req);
  return handle(res, next, autogen.runPayrollAutogen({ businessId, actorId, jobId: req.params.id }));
}

// GET /imports/:id/rows?status=ERROR
function listRows(req, res, next) {
  const { businessId } = actor(req);
  return handle(res, next, service.listRows({ businessId, jobId: req.params.id, status: req.query.status, page: req.query.page, pageSize: req.query.pageSize }));
}

// GET /imports/:id/report  → annotated CSV
async function report(req, res, next) {
  try {
    const { businessId } = actor(req);
    const { fileName, csv } = await service.buildReportCsv({ businessId, jobId: req.params.id });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(csv);
  } catch (e) {
    if (e && e.statusCode) return res.status(e.statusCode).json({ message: e.message, code: e.code });
    return next(e);
  }
}

// POST /imports/:id/cancel
function cancel(req, res, next) {
  const { businessId, actorId } = actor(req);
  return handle(res, next, service.cancel({ businessId, actorId, jobId: req.params.id }));
}

module.exports = { getTemplate, upload, list, get, patchMapping, validate, dryRun, commit, runAutogen, listRows, report, cancel };
