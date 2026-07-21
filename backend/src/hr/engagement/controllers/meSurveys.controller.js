'use strict';

/**
 * meSurveys.controller.js — Feature 33 EMPLOYEE (ESS) survey surface, mounted at
 * /api/hr/me/engagement/surveys. CUSTOMER session (req.customer); SELF-ONLY by
 * construction — the subject employee is resolved ENTIRELY from the session
 * (workEmail/personalEmail/linked User), so a body/query employeeId is structurally
 * ignored and a cross-employee read/submit is impossible. Cross-tenant is blocked by
 * businessId on every where. Mirrors meEngagement.controller.js exactly.
 *
 * Surfaces:
 *   GET  /                   — my open occurrences + Done ✓ / Pending / Dismissed badge
 *   GET  /:occurrenceId      — questions to fill (rejects closed / out-of-audience /
 *                              already submitted)
 *   POST /:occurrenceId/submit  — the anonymity firewall (§5.2) → { receiptToken }
 *   POST /:occurrenceId/dismiss — stop reminders; counts as a non-response
 */

const prisma = require('../../../core/lib/prisma');
const { isEssVisibleStatus, essOrgPolicy } = require('../../lib/orgVisibility');
const responseSvc = require('../surveys/surveyResponse.service');

// Resolve the session customer's own Employee (mirror of meEngagement.resolveSelf).
async function resolveSelf(businessId, customer) {
  if (!customer || !customer.email) return null;
  const select = { id: true, code: true, firstName: true, lastName: true, status: true, isActive: true };
  const byEmail = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, OR: [{ workEmail: customer.email }, { personalEmail: customer.email }] },
    select,
  });
  if (byEmail) return byEmail;
  return prisma.employee.findFirst({
    where: { businessId, deletedAt: null, user: { is: { email: customer.email } } },
    select,
  });
}

async function withSelf(req, res) {
  const { businessId } = req.customer;
  const employee = await resolveSelf(businessId, req.customer);
  if (!employee) { res.status(404).json({ message: 'No employee record is linked to your account' }); return null; }
  // ESS ACTIVE-STATUS LOCKOUT — same gate as the engagement feed (fail-closed → 403).
  if (employee.isActive === false || !isEssVisibleStatus(employee.status, essOrgPolicy(businessId))) {
    res.status(403).json({ message: 'Your account is not active' });
    return null;
  }
  return { businessId, employee };
}

// GET /me/engagement/surveys — my open occurrences with the Done/Pending badge.
async function list(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const items = await responseSvc.listForEmployee({ businessId, employeeId: employee.id });
    return res.json({ items });
  } catch (e) { return next(e); }
}

// GET /me/engagement/surveys/:occurrenceId — the fill view (questions).
async function detail(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const out = await responseSvc.getForFill({ businessId, employeeId: employee.id, occurrenceId: req.params.occurrenceId });
    if (out.notFound) return res.status(404).json({ message: 'Survey not found' });
    if (out.conflict === 'SURVEY_CLOSED') return res.status(409).json({ code: 'SURVEY_CLOSED', message: 'This survey is closed' });
    if (out.conflict === 'ALREADY_SUBMITTED') return res.status(409).json({ code: 'ALREADY_SUBMITTED', message: 'You have already submitted this survey' });
    return res.json(out.occurrence);
  } catch (e) { return next(e); }
}

// POST /me/engagement/surveys/:occurrenceId/submit — the firewall. Body:
// { answers: [{ questionId, numericValue?, choiceValues?, textValue? }] }.
// Returns ONLY { receiptToken } — stored content is never echoed with identity.
async function submit(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const out = await responseSvc.submitResponse({
      businessId,
      occurrenceId: req.params.occurrenceId,
      employee, // resolved from the SESSION — never from the client
      answers: (req.body && req.body.answers) || [],
    });
    if (out.notFound) return res.status(404).json({ message: 'Survey not found' });
    if (out.forbidden) return res.status(403).json({ message: 'This survey is not addressed to you' });
    if (out.conflict === 'SURVEY_CLOSED') return res.status(409).json({ code: 'SURVEY_CLOSED', message: 'This survey is closed' });
    if (out.conflict === 'ALREADY_SUBMITTED') return res.status(409).json({ code: 'ALREADY_SUBMITTED', message: 'You have already submitted this survey' });
    if (out.invalid) return res.status(422).json({ message: out.invalid });
    return res.json({ receiptToken: out.receiptToken });
  } catch (e) { return next(e); }
}

// POST /me/engagement/surveys/:occurrenceId/dismiss — stop reminders (non-response).
async function dismissOccurrence(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const out = await responseSvc.dismiss({ businessId, employeeId: employee.id, occurrenceId: req.params.occurrenceId });
    if (out.notFound) return res.status(404).json({ message: 'Survey not found' });
    if (out.conflict === 'ALREADY_SUBMITTED') return res.status(409).json({ code: 'ALREADY_SUBMITTED', message: 'You have already submitted this survey' });
    return res.json({ ok: true, dismissed: true });
  } catch (e) { return next(e); }
}

module.exports = { list, detail, submit, dismiss: dismissOccurrence };
