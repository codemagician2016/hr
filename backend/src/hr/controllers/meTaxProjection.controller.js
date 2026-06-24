'use strict';

/**
 * meTaxProjection.controller.js — Feature 15. Employee Self-Service (ESS) India
 * income-tax projection, mounted at /api/hr/me/tax-projection. CUSTOMER session
 * (req.customer); SELF_ONLY — the subject employee is resolved from the session
 * (resolveSelfEmployee), NEVER from the client, so a cross-employee read is
 * structurally impossible (identical discipline to meTax / mePayslips).
 *
 *   GET  /                → the full IT-computation statement (§5.1 of the spec).
 *   GET  /regimes         → the lightweight OLD-vs-NEW comparison.
 *   GET  /pdf             → the branded IT-computation PDF (records SHA-256).
 *
 * India-only: the assembler country-gates (COUNTRY_UNSUPPORTED → 422). A non-IN
 * employee never reaches the engine.
 */

const crypto = require('crypto');
const prisma = require('../../core/lib/prisma');
const { resolveSelfEmployee, isSeparatedEmployee } = require('../lib/resolveSelfEmployee');
const assembler = require('../tax/projectionAssembler');
const { renderTaxProjectionPdf } = require('../tax/taxProjectionPdf');

const noEmployee = (res) => res.status(404).json({ message: 'No active employee record for this account' });

// Resolve the session's own active employee row (or null → lockout/404).
async function resolveActiveSelf(req) {
  const { businessId } = req.customer;
  const emp = await resolveSelfEmployee(businessId, req.customer);
  if (!emp) return null;
  // Reads stay open for separated employees (final statement), but a deactivated
  // account with no employee row is a lockout.
  return emp;
}

// Map assembler errors to HTTP. COUNTRY_UNSUPPORTED → 422 (India-only surface).
function mapError(res, e) {
  if (e && e.code === 'COUNTRY_UNSUPPORTED') {
    return res.status(422).json({ message: 'Tax projection is available for India only.', code: 'COUNTRY_UNSUPPORTED' });
  }
  if (e && e.code === 'NOT_FOUND') return noEmployee(res);
  if (e && (e.code === 'HR_NOT_SET_UP' || e.code === 'HR_COUNTRY_AMBIGUOUS')) {
    return res.status(422).json({ message: 'Your tax jurisdiction is not set up yet. Please contact HR.', code: e.code });
  }
  if (e && e.code === 'COUNTRY_MISMATCH') {
    return res.status(422).json({ message: 'Your statutory country could not be resolved. Please contact HR.', code: 'COUNTRY_MISMATCH' });
  }
  return null; // not handled here — let the error middleware deal with it
}

// GET /api/hr/me/tax-projection?asOf=YYYY-MM-DD
async function getProjection(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const asOf = typeof req.query.asOf === 'string' ? req.query.asOf : undefined;
    const statement = await assembler.buildTaxProjection({ businessId, employeeId: emp.id, asOf });
    return res.json(statement);
  } catch (e) {
    const handled = mapError(res, e);
    if (handled) return handled;
    return next(e);
  }
}

// GET /api/hr/me/tax-projection/regimes
async function getRegimes(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const cmp = await assembler.buildRegimeComparison({ businessId, employeeId: emp.id });
    return res.json(cmp);
  } catch (e) {
    const handled = mapError(res, e);
    if (handled) return handled;
    return next(e);
  }
}

// GET /api/hr/me/tax-projection/pdf — the branded IT computation.
async function getProjectionPdf(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const statement = await assembler.buildTaxProjection({ businessId, employeeId: emp.id });

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, name: true },
    });

    const pdf = await renderTaxProjectionPdf({ statement, business });

    // Best-effort tamper-evidence hash (non-fatal), mirroring the payslip PDF.
    try {
      const pdfHash = crypto.createHash('sha256').update(pdf).digest('hex');
      res.setHeader('X-Document-SHA256', pdfHash);
    } catch (_e) { /* non-fatal */ }

    const fileName = `tax-projection-${statement.taxYear}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdf.length);
    return res.status(200).send(pdf);
  } catch (e) {
    const handled = mapError(res, e);
    if (handled) return handled;
    return next(e);
  }
}

module.exports = { getProjection, getRegimes, getProjectionPdf };
