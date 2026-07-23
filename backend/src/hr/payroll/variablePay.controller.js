'use strict';

/**
 * variablePay.controller.js — thin HTTP layer over variablePay.service.js
 * (Feature 46, Phase 4). Tenant-scoped by req.user.businessId. Controllers carry
 * NO variable-pay logic — they validate the request shape, call the service, and
 * translate a VariablePayError into an HTTP status.
 */

const svc = require('./variablePay.service');

function handleError(res, err) {
  const status = err && (err.status || err.statusCode) ? (err.status || err.statusCode) : 500;
  const body = { message: err && err.message ? err.message : 'Internal error' };
  if (err && err.code) body.code = err.code;
  if (status === 500) {
    // eslint-disable-next-line no-console
    console.error('[variablePay.controller]', err && err.stack ? err.stack : err);
  }
  return res.status(status).json(body);
}

// ── schemes ──
async function createScheme(req, res) {
  try {
    const out = await svc.createScheme({ businessId: req.user.businessId, actorId: req.user.id, ...(req.body || {}) });
    res.status(201).json(out);
  } catch (err) { handleError(res, err); }
}
async function listSchemes(req, res) {
  try {
    const out = await svc.listSchemes({ businessId: req.user.businessId, isActive: req.query && req.query.isActive });
    res.json(out);
  } catch (err) { handleError(res, err); }
}
async function getScheme(req, res) {
  try {
    const out = await svc.getScheme({ businessId: req.user.businessId, schemeId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}
async function updateScheme(req, res) {
  try {
    const out = await svc.updateScheme({ businessId: req.user.businessId, actorId: req.user.id, schemeId: req.params.id, ...(req.body || {}) });
    res.json(out);
  } catch (err) { handleError(res, err); }
}
async function deleteScheme(req, res) {
  try {
    const out = await svc.deleteScheme({ businessId: req.user.businessId, actorId: req.user.id, schemeId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// ── cycles ──
async function createCycle(req, res) {
  try {
    const out = await svc.createCycle({ businessId: req.user.businessId, actorId: req.user.id, ...(req.body || {}) });
    res.status(201).json(out);
  } catch (err) { handleError(res, err); }
}
async function listCycles(req, res) {
  try {
    const { schemeId, status, page, pageSize } = req.query || {};
    const out = await svc.listCycles({ businessId: req.user.businessId, schemeId, status, page, pageSize });
    res.json(out);
  } catch (err) { handleError(res, err); }
}
async function getCycle(req, res) {
  try {
    const out = await svc.getCycle({ businessId: req.user.businessId, cycleId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}
async function computeCycle(req, res) {
  try {
    const out = await svc.computeCycle({ businessId: req.user.businessId, actorId: req.user.id, cycleId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}
async function approveCycle(req, res) {
  try {
    const out = await svc.approveCycle({ businessId: req.user.businessId, actorId: req.user.id, cycleId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}
async function cancelCycle(req, res) {
  try {
    const out = await svc.cancelCycle({ businessId: req.user.businessId, actorId: req.user.id, cycleId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// ── awards ──
async function listAwards(req, res) {
  try {
    const out = await svc.listAwards({ businessId: req.user.businessId, cycleId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}
async function patchAward(req, res) {
  try {
    const { achievementPct, note } = req.body || {};
    const out = await svc.patchAward({ businessId: req.user.businessId, actorId: req.user.id, cycleId: req.params.id, awardId: req.params.awardId, achievementPct, note });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

module.exports = {
  createScheme,
  listSchemes,
  getScheme,
  updateScheme,
  deleteScheme,
  createCycle,
  listCycles,
  getCycle,
  computeCycle,
  approveCycle,
  cancelCycle,
  listAwards,
  patchAward,
};
