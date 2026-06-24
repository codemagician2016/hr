'use strict';

/**
 * arrears.controller.js — thin HTTP layer over arrears.service.js (Feature 27).
 * Operator handlers are tenant-scoped by req.user.businessId; the ESS handler is
 * scoped by the self-employee. Controllers carry NO arrear logic — they validate the
 * request shape, call the service, and translate an ArrearError into a status.
 */

const svc = require('./arrears.service');
const service = require('./service'); // ESS self-employee resolution (reused)

function handleError(res, err) {
  const status = err && (err.status || err.statusCode) ? (err.status || err.statusCode) : 500;
  const body = { message: err && err.message ? err.message : 'Internal error' };
  if (err && err.code) body.code = err.code;
  if (status === 500) {
    // eslint-disable-next-line no-console
    console.error('[arrears.controller]', err && err.stack ? err.stack : err);
  }
  return res.status(status).json(body);
}

async function detect(req, res) {
  try {
    const { entityId, period } = req.query || {};
    if (!entityId) return res.status(400).json({ code: 'MISSING_FIELDS', message: 'entityId is required' });
    // period "YYYY-MM" → first-of-month; default to the current month.
    const openPeriodStart = period ? `${period}-01` : `${new Date().toISOString().slice(0, 7)}-01`;
    const out = await svc.detectArrearCycles({ businessId: req.user.businessId, entityId, openPeriodStart });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function createCycle(req, res) {
  try {
    const { compensationRevisionId, detectedInPeriod } = req.body || {};
    const out = await svc.createArrearCycle({ businessId: req.user.businessId, actorId: req.user.id, compensationRevisionId, detectedInPeriod });
    res.status(201).json(out);
  } catch (err) { handleError(res, err); }
}

async function listCycles(req, res) {
  try {
    const { entityId, status } = req.query || {};
    const out = await svc.listArrearCycles({ businessId: req.user.businessId, entityId, status });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getCycle(req, res) {
  try {
    const out = await svc.getArrearCycle({ businessId: req.user.businessId, arrearCycleId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function updateCycle(req, res) {
  try {
    const { esiOnArrears, notes } = req.body || {};
    const out = await svc.updateArrearCycle({ businessId: req.user.businessId, actorId: req.user.id, arrearCycleId: req.params.id, esiOnArrears, notes });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function computeCycle(req, res) {
  try {
    const out = await svc.computeArrearCycle({ businessId: req.user.businessId, actorId: req.user.id, arrearCycleId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function approveCycle(req, res) {
  try {
    const { targetMode, targetPayRunId } = req.body || {};
    const out = await svc.approveArrearCycle({ businessId: req.user.businessId, actorId: req.user.id, arrearCycleId: req.params.id, targetMode, targetPayRunId });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function publishCycle(req, res) {
  try {
    const out = await svc.publishArrearSlips({ businessId: req.user.businessId, actorId: req.user.id, arrearCycleId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// ── ESS — the signed-in employee's own arrears (customer session) ──
async function getMyArrears(req, res) {
  try {
    const { businessId } = req.customer;
    const employeeId = await service.resolveSelfEmployee(businessId, req.customer);
    if (!employeeId) return res.status(404).json({ message: 'No employee profile for this account' });
    const out = await svc.getMyArrears({ businessId, employeeId });
    res.json({ items: out });
  } catch (err) { handleError(res, err); }
}

module.exports = {
  detect, createCycle, listCycles, getCycle, updateCycle, computeCycle, approveCycle, publishCycle, getMyArrears,
};
