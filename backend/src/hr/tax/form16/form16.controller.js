'use strict';

/**
 * form16.controller.js — Feature 24 operator HTTP layer over form16.service +
 * form24q.service. Tenant-scoped by req.user.businessId. F1 scope is applied on
 * the READ surfaces (register / cert / pdf) via resolveAccessibleEmployeeIds so a
 * TEAM/SELF operator sees only in-scope certificates (out-of-scope ⇒ 404, never a
 * "forbidden" leak). The controller carries NO Form-16 logic.
 */

const prisma = require('../../../core/lib/prisma');
const svc = require('./form16.service');
const form24q = require('./form24q.service');
const { renderForm16Pdf } = require('./form16Pdf');
const { resolveAccessibleEmployeeIds, scopeWhere, scopeAllows } = require('../../lib/scopeResolver');

function handleError(res, err) {
  const status = err && (err.status || err.statusCode) ? (err.status || err.statusCode) : 500;
  const body = { message: err && err.message ? err.message : 'Internal error' };
  if (err && err.code) body.code = err.code;
  if (status === 500) {
    // eslint-disable-next-line no-console
    console.error('[form16.controller]', err && err.stack ? err.stack : err);
  }
  return res.status(status).json(body);
}

// ── batches ──
async function createBatch(req, res) {
  try {
    const { entityId, financialYear, notes } = req.body || {};
    const out = await svc.createForm16Batch({ businessId: req.user.businessId, actorId: req.user.id, entityId, financialYear, notes });
    res.status(201).json(out);
  } catch (err) { handleError(res, err); }
}

async function listBatches(req, res) {
  try {
    const { entityId, status, page, pageSize } = req.query || {};
    const out = await svc.listForm16Batches({ businessId: req.user.businessId, entityId, status, page, pageSize });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function computeBatch(req, res) {
  try {
    const { issueZeroTds } = req.body || {};
    const out = await svc.computeForm16Batch({ businessId: req.user.businessId, actorId: req.user.id, batchId: req.params.id, issueZeroTds: !!issueZeroTds });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function approveBatch(req, res) {
  try {
    const out = await svc.approveForm16Batch({ businessId: req.user.businessId, actorId: req.user.id, batchId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function issueBatch(req, res) {
  try {
    const { sign, signers, force } = req.body || {};
    const out = await svc.issueForm16Batch({ businessId: req.user.businessId, actorId: req.user.id, batchId: req.params.id, sign: !!sign, signers, force: !!force });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// GET batch + F1-scoped certificate register.
async function getBatch(req, res) {
  try {
    const scope = await resolveAccessibleEmployeeIds(req.user, 'canViewPayrollReports');
    const certWhere = scopeWhere(scope, 'employeeId');
    const out = await svc.getForm16Batch({ businessId: req.user.businessId, batchId: req.params.id, certWhere });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// Register CSV (F1-scoped).
async function getRegister(req, res) {
  try {
    const scope = await resolveAccessibleEmployeeIds(req.user, 'canViewPayrollReports');
    const certWhere = scopeWhere(scope, 'employeeId');
    const out = await svc.getForm16Batch({ businessId: req.user.businessId, batchId: req.params.id, certWhere });
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const header = ['Employee', 'Code', 'Certificate No', 'Regime', 'Gross', 'Taxable', 'Tax', 'TDS Deducted', 'TDS Deposited', 'Reconciled', 'Status'];
      const rows = out.certificates.map((c) => [
        c.employeeName, c.employeeCode, c.certificateNo, c.regime,
        (c.grossSalaryMinor / 100).toFixed(2), (c.totalTaxableMinor / 100).toFixed(2), (c.totalTaxMinor / 100).toFixed(2),
        (c.tdsDeductedMinor / 100).toFixed(2), (c.tdsDepositedMinor / 100).toFixed(2),
        c.tdsDepositedMinor >= c.tdsDeductedMinor ? 'YES' : 'NO', c.status,
      ]);
      const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="form16-register-${out.batch.financialYear}.csv"`);
      return res.send(csv);
    }
    return res.json({ batch: out.batch, register: out.certificates, totals: out.totals });
  } catch (err) { handleError(res, err); }
}

// ── certificates (F1-scoped, IDOR-safe) ──
async function getCertificate(req, res) {
  try {
    const cert = await svc.getForm16Certificate({ businessId: req.user.businessId, certificateId: req.params.id });
    const scope = await resolveAccessibleEmployeeIds(req.user, 'canViewPayrollReports');
    if (!scopeAllows(scope, cert.employeeId)) return res.status(404).json({ message: 'Certificate not found' });
    res.json(cert);
  } catch (err) { handleError(res, err); }
}

async function getCertificatePdf(req, res) {
  try {
    const cert = await svc.getForm16Certificate({ businessId: req.user.businessId, certificateId: req.params.id });
    const scope = await resolveAccessibleEmployeeIds(req.user, 'canViewPayrollReports');
    if (!scopeAllows(scope, cert.employeeId)) return res.status(404).json({ message: 'Certificate not found' });
    const business = await prisma.business.findFirst({ where: { id: req.user.businessId }, select: { name: true } });
    const pdf = await renderForm16Pdf({ partA: cert.partA, partB: cert.partB, business });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="form16-${cert.certificateNo.replace(/[^A-Za-z0-9]/g, '_')}.pdf"`);
    res.send(pdf);
  } catch (err) { handleError(res, err); }
}

async function regenerateCertificate(req, res) {
  try {
    const { reason, batchId } = req.body || {};
    // The route carries the cert id; resolve the batch + employee from it.
    const cert = await prisma.form16Certificate.findFirst({ where: { id: req.params.id, businessId: req.user.businessId }, select: { batchId: true, employeeId: true } });
    if (!cert) return res.status(404).json({ message: 'Certificate not found' });
    const out = await svc.regenerateForm16Certificate({ businessId: req.user.businessId, actorId: req.user.id, batchId: batchId || cert.batchId, employeeId: cert.employeeId, reason });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// ── Form 24Q ──
async function getForm24Q(req, res) {
  try {
    const { entityId, financialYear, quarter } = req.query || {};
    if (!entityId || !financialYear || !quarter) return res.status(400).json({ message: 'entityId, financialYear and quarter are required', code: 'MISSING_FIELDS' });
    const out = await form24q.export24Q({ businessId: req.user.businessId, actorId: req.user.id, entityId, financialYear, quarter, persist: false });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function persistForm24Q(req, res) {
  try {
    const { entityId, financialYear, quarter } = req.body || {};
    if (!entityId || !financialYear || !quarter) return res.status(400).json({ message: 'entityId, financialYear and quarter are required', code: 'MISSING_FIELDS' });
    const out = await form24q.export24Q({ businessId: req.user.businessId, actorId: req.user.id, entityId, financialYear, quarter, persist: true });
    res.json({ remittanceId: out.remittanceId, fileName: out.fileName, meta: out.meta });
  } catch (err) { handleError(res, err); }
}

module.exports = {
  createBatch,
  listBatches,
  computeBatch,
  approveBatch,
  issueBatch,
  getBatch,
  getRegister,
  getCertificate,
  getCertificatePdf,
  regenerateCertificate,
  getForm24Q,
  persistForm24Q,
};
