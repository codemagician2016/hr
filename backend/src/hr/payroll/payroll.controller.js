'use strict';

/**
 * payroll.controller.js — thin HTTP layer over service.js (the orchestrator).
 *
 * Every operator handler is tenant-scoped by req.user.businessId; the ESS (/me)
 * handlers are scoped by req.customer.businessId (customer session). Controllers
 * carry NO payroll logic — they validate the request shape, call the service,
 * and translate a PayRunError into the right status code.
 */

const crypto = require('crypto');
const prisma = require('../../core/lib/prisma');
const service = require('./service');
const india = require('./compliance/india'); // Feature 21 — LWF statutory read model
const { renderPayslipPdf } = require('./payslipPdf');
// Feature 15 — operator read-only mirror of the ESS India tax projection.
const taxProjectionAssembler = require('../tax/projectionAssembler');
const { renderTaxProjectionPdf } = require('../tax/taxProjectionPdf');

/** Translate a thrown error into an HTTP response (PayRunError carries a code). */
function handleError(res, err) {
  const status = err && err.statusCode ? err.statusCode
    : err && err.code && CODE_STATUS[err.code] ? CODE_STATUS[err.code]
    : 500;
  const body = { message: err && err.message ? err.message : 'Internal error' };
  if (err && err.code) body.code = err.code;
  // Surface the structured bank-detail offender list so the operator UI can show
  // exactly which employees to fix (finding #22) — never a bare 500.
  if (err && Array.isArray(err.offenders)) body.offenders = err.offenders;
  if (status === 500) {
    // eslint-disable-next-line no-console
    console.error('[payroll.controller]', err && err.stack ? err.stack : err);
  }
  return res.status(status).json(body);
}

const CODE_STATUS = {
  NOT_FOUND: 404,
  MISSING_FIELDS: 400,
  BAD_STATE: 400,
  NOT_CALCULATED: 409,
  MAKER_CHECKER: 409,
  OPEN_BLOCKERS: 409,
  STALE_TRANSITION: 409,
  STALE_TOTALS: 409,
  NOT_REVIEWED: 409,
  CANNOT_CANCEL: 409,
  CANNOT_REOPEN: 409,
  CLOSE_BLOCKED: 409,
  ILLEGAL_TRANSITION: 409,
  IMMUTABLE_RUN_VIOLATION: 409,
  NO_SUCH_BLOCKER: 409, // tried to acknowledge a blocker that isn't open on the run
  INVALID_THRESHOLD: 400, // a variance tolerance value out of range
  UNKNOWN_FILE_KIND: 400,
  COUNTRY_MISMATCH: 400,
  COUNTRY_UNSUPPORTED: 422, // Feature 15 — tax projection is India-only
  HR_NOT_SET_UP: 422,
  HR_COUNTRY_AMBIGUOUS: 422,
  MISSING_BANK_DETAILS: 422,
  BANK_FIELD_TOO_LONG: 422,
};

// ── Operator: runs ──────────────────────────────────────────────────────────

async function createRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const { entityId, payCalendarId, periodStart, periodEnd } = req.body || {};
    const run = await service.createRun({ businessId, actorId, entityId, payCalendarId, periodStart, periodEnd });
    res.status(201).json(run);
  } catch (err) { handleError(res, err); }
}

async function computeRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    // Seam #1 fix: thread the freeze flag from HTTP so the operator can freeze
    // attendance atomically as part of compute (?freeze=1 or body.freezeAttendance).
    const freezeAttendance =
      (req.body && (req.body.freezeAttendance === true || req.body.freeze === true)) ||
      req.query.freeze === '1' || req.query.freeze === 'true';
    const detail = await service.computeRun({ businessId, actorId, payRunId: req.params.id, freezeAttendance });
    res.json(detail);
  } catch (err) { handleError(res, err); }
}

/** Dedicated freeze endpoint — compute with freezeAttendance:true. */
async function freezeRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const detail = await service.computeRun({ businessId, actorId, payRunId: req.params.id, freezeAttendance: true });
    res.json(detail);
  } catch (err) { handleError(res, err); }
}

async function approveRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    // SECURITY (finding #2 + #3): four-eyes and the totals-staleness check are
    // SERVER-SIDE invariants resolved inside the service from tenant policy +
    // persisted totals. The request body CANNOT supply fourEyes/totalsHash to
    // weaken separation-of-duties or the STALE_TOTALS gate. Any such field is
    // intentionally ignored here.
    const detail = await service.approveRun({ businessId, actorId, payRunId: req.params.id });
    // Wave 2B — guards passed; mark the engine request decided (best-effort).
    try {
      const open = await prisma.approvalRequest.findFirst({
        where: { businessId, module: 'PAYRUN', entityId: req.params.id, status: { in: ['PENDING', 'ESCALATED'] } },
      });
      if (open) {
        await approvalsEngine.recordDecision({
          approvalRequestId: open.id, actorUserId: actorId || 'SYSTEM',
          decision: 'APPROVED', systemActor: true,
        });
      }
    } catch (e) { console.error('[payrun] request mark failed:', e.message); }
    res.json(detail);
  } catch (err) { handleError(res, err); }
}

async function listRuns(req, res) {
  try {
    const { businessId } = req.user;
    const { entityId, status, type, includeFnf, taxYear, page, pageSize } = req.query;
    const out = await service.listRuns({ businessId, entityId, status, type, includeFnf, taxYear, page, pageSize });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// ── Feature 7 — run orchestration / lifecycle past APPROVED ──────────────────

async function listRunEntities(req, res) {
  try {
    const { businessId } = req.user;
    const out = await service.listRunEntities({ businessId });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getInputsChecklist(req, res) {
  try {
    const { businessId } = req.user;
    const out = await service.getInputsChecklist({ businessId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function upsertOneTimeInput(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.upsertOneTimeInput({ businessId, actorId, payRunId: req.params.id, item: req.body || {} });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getVariance(req, res) {
  try {
    const { businessId } = req.user;
    const out = await service.computeVariance({ businessId, payRunId: req.params.id });
    // Surface the run's acknowledgement ledger + the operable blocker gate so the
    // pre-run review panel can show what's overridden without a second round-trip.
    const [{ items: acknowledgements }, gate] = await Promise.all([
      service.listAcknowledgements(businessId, req.params.id),
      service.countUnacknowledgedBlockers(businessId, req.params.id),
    ]);
    res.json({ ...out, acknowledgements, blockerGate: gate });
  } catch (err) { handleError(res, err); }
}

// Feature 7 — acknowledge / override a pre-run BLOCKER before approval. The route
// gates this on canApprovePayroll (the checker's audited override).
async function ackAnomaly(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const { code, employeeId, reason } = req.body || {};
    const out = await service.ackAnomaly({ businessId, actorId, payRunId: req.params.id, code, employeeId, reason });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// Feature 7 — view the per-tenant variance tolerances (the thresholds variance.js
// reads). Read-only, canRunPayroll-gated.
async function getThresholds(req, res) {
  try {
    const { businessId } = req.user;
    const out = await service.getThresholds(businessId);
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// Feature 7 — edit the per-tenant variance tolerances. canApprovePayroll-gated
// (MEDIUM-3): the thresholds drive the BLOCKER gate, so only the checker may tune
// them — the maker can't self-tune the gate they are gated by.
async function updateThresholds(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.updateThresholds({ businessId, actorId, config: (req.body || {}).config || req.body || {} });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// Wave 2B — PAYRUN rides the engine for VISIBILITY + tenant-authored chains;
// the run's own maker-checker (four-eyes / STALE_TOTALS / OPEN_BLOCKERS) stays
// the guard authority (see approvals/consumers.payrun.js).
const approvalsEngine = require('../approvals/engine');
require('../approvals/consumers.payrun');

async function openPayrunRequest(businessId, run) {
  const prior = await prisma.approvalRequest.findFirst({
    where: { businessId, module: 'PAYRUN', entityId: run.id, status: { in: ['PENDING', 'ESCALATED'] } },
  });
  if (prior) return prior;
  const opened = await approvalsEngine.openRequest({
    businessId,
    module: 'PAYRUN',
    entityType: 'PayRun',
    entityId: run.id,
    requesterEmployeeId: null,
    payload: {
      code: run.code || null,
      period: run.periodStart ? `${String(run.periodStart).slice(0, 10)} → ${String(run.periodEnd).slice(0, 10)}` : null,
      headcount: run.headcount || null,
      totalNet: run.totalNet != null ? String(run.totalNet) : null,
      amount: run.totalNet != null ? Number(run.totalNet) : null,
    },
    ctx: { entityId: run.id, amount: run.totalNet != null ? Number(run.totalNet) : null },
  });
  await prisma.payRun.update({ where: { id: run.id }, data: { approvalRequestId: opened.approvalRequest.id } });
  return opened.approvalRequest;
}

async function closeOpenPayrunRequest(businessId, payRunId, actorUserId, comment) {
  const open = await prisma.approvalRequest.findFirst({
    where: { businessId, module: 'PAYRUN', entityId: payRunId, status: { in: ['PENDING', 'ESCALATED'] } },
  });
  if (!open) return;
  await approvalsEngine.cancel({ approvalRequestId: open.id, actorUserId: actorUserId || 'SYSTEM', comment: comment || null }).catch(() => {});
}

async function submitRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.submitRun({ businessId, actorId, payRunId: req.params.id });
    // Open the engine request AFTER a successful submit (best-effort — the run's
    // own review state machine is the authority).
    try {
      const run = await prisma.payRun.findFirst({ where: { id: req.params.id, businessId } });
      if (run) await openPayrunRequest(businessId, run);
    } catch (e) { console.error('[payrun] request open failed:', e.message); }
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function sendBackRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.sendBackRun({ businessId, actorId, payRunId: req.params.id, reason: (req.body || {}).reason });
    await closeOpenPayrunRequest(businessId, req.params.id, actorId, `Sent back: ${(req.body || {}).reason || ''}`);
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function publishRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.publishRun({ businessId, actorId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function disburseRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.disburseRun({ businessId, actorId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function fileRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.fileRun({ businessId, actorId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function closeRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.closeRun({ businessId, actorId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function cancelRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.cancelRun({ businessId, actorId, payRunId: req.params.id, reason: (req.body || {}).reason });
    await closeOpenPayrunRequest(businessId, req.params.id, actorId, `Run cancelled: ${(req.body || {}).reason || ''}`);
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function reopenRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.reopenRun({ businessId, actorId, payRunId: req.params.id });
    await closeOpenPayrunRequest(businessId, req.params.id, actorId, 'Run reopened for recompute');
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getRun(req, res) {
  try {
    const { businessId } = req.user;
    const detail = await service.getRun({ businessId, payRunId: req.params.id });
    res.json(detail);
  } catch (err) { handleError(res, err); }
}

async function getRunPayslips(req, res) {
  try {
    const { businessId } = req.user;
    const out = await service.getRunPayslips({ businessId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getPayslip(req, res) {
  try {
    const { businessId } = req.user;
    const payslip = await service.getPayslip({ businessId, payslipId: req.params.id });
    res.json(payslip);
  } catch (err) { handleError(res, err); }
}

/**
 * getPayslipPdf — operator payslip as a branded `application/pdf` (finding #23).
 *
 * The operator "View" used to open the raw JSON API in a new tab. This renders
 * the SAME branded PDF the employee sees, from the payslip's frozen snapshotJson
 * (immutable source of truth) — no stored blob, a fresh render per request.
 * Scoping is by req.user.businessId via service.getPayslipPdfContext, behind the
 * canViewPayrollReports route gate. The bytes' SHA-256 is recorded best-effort
 * as tamper evidence (mirrors the ESS path) and never blocks the download.
 */
// ── Program P1.2 — payslip brand + PDF-password context ──────────────────────
// TenantBrand (colors + logo URL) finally reaches the payslip renderer; the
// logo is fetched once and cached in-process (3s timeout, ≤1MB, best-effort —
// a fetch failure renders the text header exactly as before). PDF password is
// a tenant setting (featureFlags.payroll.payslipPdfPassword = 'NONE'|'DOB'):
// DOB = the common Indian convention DDMMYYYY from the employee's birth date.
const _logoCache = new Map(); // url -> Buffer|null
async function fetchLogoBytes(url) {
  if (!url || !/^https:\/\//i.test(url)) return null;
  if (_logoCache.has(url)) return _logoCache.get(url);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const resp = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!resp.ok) throw new Error(String(resp.status));
    const buf = Buffer.from(await resp.arrayBuffer());
    const out = buf.length > 0 && buf.length <= 1024 * 1024 ? buf : null;
    _logoCache.set(url, out);
    return out;
  } catch (_e) {
    _logoCache.set(url, null);
    return null;
  }
}
async function payslipRenderExtras(businessId, employee) {
  const extras = { brand: null, pdfPassword: null };
  try {
    const brand = await prisma.tenantBrand.findFirst({
      where: { businessId, entityId: null, isActive: true },
      select: { primaryColor: true, accentColor: true, logoUrl: true },
    });
    if (brand) {
      extras.brand = {
        primaryColor: brand.primaryColor || null,
        accentColor: brand.accentColor || null,
        logoBytes: await fetchLogoBytes(brand.logoUrl),
      };
    }
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { featureFlags: true } });
    const pf = biz && biz.featureFlags && typeof biz.featureFlags === 'object' ? biz.featureFlags.payroll : null;
    if (pf && pf.payslipPdfPassword === 'DOB' && employee && employee.dateOfBirth) {
      const d = new Date(employee.dateOfBirth);
      extras.pdfPassword = `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}${d.getUTCFullYear()}`;
    }
  } catch (_e) { /* best-effort — plain render on any failure */ }
  return extras;
}

async function getPayslipPdf(req, res) {
  try {
    const { businessId } = req.user;
    const { payslip, employee, business } = await service.getPayslipPdfContext({
      businessId, payslipId: req.params.id,
    });

    const extras = await payslipRenderExtras(businessId, employee);
    const pdf = await renderPayslipPdf({ payslip, employee, business, ...extras });

    try {
      const pdfHash = crypto.createHash('sha256').update(pdf).digest('hex');
      await service.recordPayslipPdfHash({ businessId, payslipId: payslip.id, pdfHash });
    } catch (_e) { /* non-fatal */ }

    const fileName = `${payslip.code || 'payslip'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    // inline so the operator's "View" opens the PDF in the browser tab.
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', pdf.length);
    res.status(200).send(pdf);
  } catch (err) { handleError(res, err); }
}

/**
 * getEmployeeTaxProjection — Feature 15 operator read-only mirror of the ESS
 * India income-tax projection (for payroll-desk queries: "why is my TDS this
 * much?"). Behind canViewPayrollReports + F1 scope: the route's withEmployeeScope
 * 404s an out-of-scope employeeId BEFORE this runs, so the handler only computes
 * for in-scope, tenant-scoped employees. Read-only — never writes.
 */
async function getEmployeeTaxProjection(req, res) {
  try {
    const { businessId } = req.user;
    const asOf = typeof req.query.asOf === 'string' ? req.query.asOf : undefined;
    const statement = await taxProjectionAssembler.buildTaxProjection({
      businessId, employeeId: req.params.employeeId, asOf,
    });
    res.json(statement);
  } catch (err) { handleError(res, err); }
}

/** getEmployeeTaxProjectionPdf — same statement as a branded PDF (operator view). */
async function getEmployeeTaxProjectionPdf(req, res) {
  try {
    const { businessId } = req.user;
    const statement = await taxProjectionAssembler.buildTaxProjection({
      businessId, employeeId: req.params.employeeId,
    });
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, name: true },
    });
    const pdf = await renderTaxProjectionPdf({ statement, business });
    const fileName = `tax-projection-${statement.employeeCode || 'employee'}-${statement.taxYear}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', pdf.length);
    res.status(200).send(pdf);
  } catch (err) { handleError(res, err); }
}

async function getFile(req, res) {
  try {
    const { businessId } = req.user;
    const file = await service.generateFile({ businessId, payRunId: req.params.id, kind: req.params.kind });
    res.setHeader('Content-Type', file.contentType || 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('X-Payroll-File-Meta', Buffer.from(JSON.stringify(file.meta || {})).toString('base64'));
    res.status(200).send(file.content);
  } catch (err) { handleError(res, err); }
}

// ── ESS (customer session): own payslips ────────────────────────────────────

async function getMyPayslips(req, res) {
  try {
    const { businessId } = req.customer;
    const { page, pageSize } = req.query;
    const out = await service.getMyPayslips({ businessId, customer: req.customer, page, pageSize });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getMyPayslip(req, res) {
  try {
    const { businessId } = req.customer;
    const payslip = await service.getMyPayslip({ businessId, customer: req.customer, payslipId: req.params.id });
    res.json(payslip);
  } catch (err) { handleError(res, err); }
}

/**
 * getMyPayslipPdf — the employee's OWN payslip as a branded `application/pdf`.
 *
 * Security (§6.6): the ESS download serves the employee's OWN payslip, NEVER the
 * run-level bank/statutory file. ALL scoping flows through the existing secure
 * path service.getMyPayslipPdfContext -> getMyPayslip, which enforces
 * employee-own + PUBLISHED|VIEWED and marks first view. We then render the
 * frozen snapshotJson (the immutable source of truth) into a PDF on demand —
 * no S3, no stored blob; a fresh render per request. A SHA-256 of the bytes is
 * recorded as tamper evidence (best-effort; never blocks the download).
 */
async function getMyPayslipPdf(req, res) {
  try {
    const { businessId } = req.customer;
    const { payslip, employee, business } = await service.getMyPayslipPdfContext({
      businessId, customer: req.customer, payslipId: req.params.id,
    });

    const extras = await payslipRenderExtras(businessId, employee);
    const pdf = await renderPayslipPdf({ payslip, employee, business, ...extras });

    // Tamper-evidence: persist the SHA-256 of the rendered bytes. Best-effort —
    // a write failure must NOT fail the employee's download.
    try {
      const pdfHash = crypto.createHash('sha256').update(pdf).digest('hex');
      await service.recordPayslipPdfHash({ businessId, payslipId: payslip.id, pdfHash });
    } catch (_e) { /* non-fatal */ }

    const fileName = `${payslip.code || 'payslip'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdf.length);
    res.status(200).send(pdf);
  } catch (err) { handleError(res, err); }
}

// Feature 21 — GET /payroll/statutory/lwf?stateCode=MH&asOf=YYYY-MM-DD — the resolved
// per-state LWF read model for the admin "Labour Welfare Fund" panel. India-only
// (404 for non-IN tenants); pure read from india.resolveLwf (effective-dated).
async function getLwfFramework(req, res) {
  try {
    const { businessId } = req.user;
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { hrCountry: true } });
    if (biz && biz.hrCountry && biz.hrCountry !== 'IN') {
      return res.status(404).json({ message: 'Labour Welfare Fund is India-only', reason: 'NOT_INDIA_TENANT' });
    }
    const stateCode = req.query.stateCode || null;
    if (!stateCode) return res.status(400).json({ message: 'stateCode is required', code: 'MISSING_FIELDS' });
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
    const lwf = india._internals.resolveLwf(String(stateCode).toUpperCase(), asOf);
    res.json(lwf);
  } catch (err) { handleError(res, err); }
}

// ── Program P1.2 — per-employee payslip HOLD / RELEASE + tenant settings ─────
async function holdPayslip(req, res, next) {
  try {
    const { businessId } = req.user;
    const line = await prisma.payRunLine.findFirst({ where: { id: req.params.lineId, businessId, payRunId: req.params.id } });
    if (!line) return res.status(404).json({ message: 'Pay run line not found' });
    if (line.payslipHeldAt) return res.status(409).json({ message: 'Already held' });
    const row = await prisma.payRunLine.update({
      where: { id: line.id },
      data: { payslipHeldAt: new Date(), payslipHeldBy: req.user.id || null, payslipHoldNote: (req.body && req.body.note) || null },
    });
    const { writeAudit } = require('../../core/lib/audit');
    await writeAudit({ businessId, actorId: req.user.id, action: 'payroll.payslip.hold', entityType: 'PayRunLine', entityId: line.id, meta: { employeeId: line.employeeId, note: row.payslipHoldNote } }).catch(() => {});
    res.json({ held: true, payslipHeldAt: row.payslipHeldAt });
  } catch (e) { next(e); }
}

async function releasePayslip(req, res, next) {
  try {
    const { businessId } = req.user;
    const line = await prisma.payRunLine.findFirst({ where: { id: req.params.lineId, businessId, payRunId: req.params.id } });
    if (!line) return res.status(404).json({ message: 'Pay run line not found' });
    if (!line.payslipHeldAt) return res.status(409).json({ message: 'Not held' });
    await prisma.payRunLine.update({
      where: { id: line.id },
      data: { payslipHeldAt: null, payslipHeldBy: null, payslipHoldNote: null },
    });
    const { writeAudit } = require('../../core/lib/audit');
    await writeAudit({ businessId, actorId: req.user.id, action: 'payroll.payslip.release', entityType: 'PayRunLine', entityId: line.id, meta: { employeeId: line.employeeId } }).catch(() => {});
    res.json({ held: false });
  } catch (e) { next(e); }
}

async function getPayslipSettings(req, res, next) {
  try {
    const biz = await prisma.business.findUnique({ where: { id: req.user.businessId }, select: { featureFlags: true } });
    const pf = biz && biz.featureFlags && typeof biz.featureFlags === 'object' ? biz.featureFlags.payroll : null;
    res.json({ payslipPdfPassword: (pf && pf.payslipPdfPassword) || 'NONE' });
  } catch (e) { next(e); }
}

async function updatePayslipSettings(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const mode = req.body && req.body.payslipPdfPassword;
    if (!['NONE', 'DOB'].includes(mode)) return res.status(400).json({ message: "payslipPdfPassword must be 'NONE' or 'DOB'" });
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { featureFlags: true } });
    const flags = biz && biz.featureFlags && typeof biz.featureFlags === 'object' ? biz.featureFlags : {};
    const pf = flags.payroll && typeof flags.payroll === 'object' ? flags.payroll : {};
    await prisma.business.update({ where: { id: businessId }, data: { featureFlags: { ...flags, payroll: { ...pf, payslipPdfPassword: mode } } } });
    const { writeAudit } = require('../../core/lib/audit');
    await writeAudit({ businessId, actorId: req.user.id, action: 'payroll.payslip.settings', entityType: 'Business', entityId: businessId, meta: { payslipPdfPassword: mode } }).catch(() => {});
    res.json({ payslipPdfPassword: mode });
  } catch (e) { next(e); }
}

module.exports = {
  createRun,
  computeRun,
  freezeRun,
  approveRun,
  listRuns,
  holdPayslip,
  releasePayslip,
  getPayslipSettings,
  updatePayslipSettings,
  getRun,
  getRunPayslips,
  getPayslip,
  getPayslipPdf,
  // Feature 15 — operator read-only tax-projection mirror (F1-scoped).
  getEmployeeTaxProjection,
  getEmployeeTaxProjectionPdf,
  getFile,
  getMyPayslips,
  getMyPayslip,
  getMyPayslipPdf,
  // Feature 21 — LWF statutory framework read (India-only, effective-dated)
  getLwfFramework,
  // Feature 7 — run orchestration / lifecycle
  listRunEntities,
  getInputsChecklist,
  upsertOneTimeInput,
  getVariance,
  ackAnomaly,
  getThresholds,
  updateThresholds,
  submitRun,
  sendBackRun,
  publishRun,
  disburseRun,
  fileRun,
  closeRun,
  cancelRun,
  reopenRun,
};
