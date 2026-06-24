'use strict';

/**
 * meProofs.controller.js — Feature 20 slice 20b/20e. Employee Self-Service (ESS)
 * investment-proof upload + Form 12BB, mounted at /api/hr/me/proofs. CUSTOMER session
 * (req.customer); SELF_ONLY — the subject employee is resolved from the session
 * (resolveSelfEmployee), NEVER from the client, so a cross-employee write is
 * structurally impossible (identical discipline to meTax / meTaxProjection).
 *
 * Upload is GATED on the window being OPEN (edge case: no window → can't upload, but
 * the projection still runs provisional). Reuses validateDocDataUrl + sha256 +
 * s3.uploadDataUrl (10MB, PDF/PNG/JPG, server-computed hash). NEW-regime employees
 * skip proofs entirely (mirrors saveDeclaration's isOld gate). HRA rent > ₹1L requires
 * a landlord PAN (Rule 26C). Withdraw is allowed only for an OWN PENDING proof while
 * the window is OPEN (soft-delete; an ACCEPTED/REJECTED proof is immutable).
 */

const crypto = require('crypto');
const prisma = require('../../../core/lib/prisma');
const s3 = require('../../../core/lib/s3');
const payrollService = require('../../payroll/service');
const { resolveStatutoryCountry } = require('../../lib/resolveStatutoryCountry');
const { resolveWindow } = require('./windowResolver');
const { shouldUseVerified } = require('./proofAggregator');
const { renderForm12bbPdf } = require('./form12bbPdf');
const {
  isValidClaimType, isFbpClaimType, CLAIM_TYPE_META, HRA_LANDLORD_PAN_THRESHOLD_RUPEES, PAN_RE,
} = require('./claimTypes');

// ── upload guards (mirror documents.controller — 10MB + PDF/PNG/JPG) ─────────
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const ALLOWED_DOC_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);

function validateDocDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return { ok: false, status: 400, message: 'A file (fileBase64 data URL) is required' };
  }
  const m = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(dataUrl);
  if (!m || !m[2]) return { ok: false, status: 422, message: 'Only base64 data URLs are supported' };
  const mime = m[1].toLowerCase();
  if (!ALLOWED_DOC_MIME.has(mime)) {
    return { ok: false, status: 422, message: `Unsupported document type: ${mime}. Allowed: PDF, PNG, JPG.` };
  }
  const b64 = m[3] || '';
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const approxBytes = Math.floor((b64.length * 3) / 4) - padding;
  if (approxBytes > MAX_DOC_BYTES) {
    return { ok: false, status: 413, message: `File exceeds the ${MAX_DOC_BYTES / (1024 * 1024)} MB upload limit` };
  }
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length > MAX_DOC_BYTES) {
    return { ok: false, status: 413, message: `File exceeds the ${MAX_DOC_BYTES / (1024 * 1024)} MB upload limit` };
  }
  return { ok: true, mime, buffer, bytes: buffer.length };
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const PROOF_PUBLIC = [
  'id', 'employeeId', 'windowId', 'financialYear', 'claimType', 'subSection',
  'declaredAmount', 'verifiedAmount', 'fileUrl', 'fileHash', 'mimeType', 'sizeBytes',
  'originalName', 'landlordName', 'landlordPan', 'rentMonthsCovered', 'status',
  'rejectReason', 'verifiedAt', 'createdAt', 'updatedAt',
];
function publicProof(p) {
  if (!p) return null;
  const out = {};
  for (const f of PROOF_PUBLIC) if (p[f] !== undefined) out[f] = p[f];
  return out;
}

function toNum(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const noEmployee = (res) => res.status(404).json({ message: 'No active employee record for this account' });

// Resolve the active self employee row (id + country). Null → lockout (404).
async function resolveActiveSelf(req) {
  const { businessId } = req.customer;
  const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, code: true, firstName: true, middleName: true, lastName: true, countryCode: true, isActive: true },
  });
  if (!emp || emp.isActive === false) return null;
  return emp;
}

// The current India financial year ("YYYY-YY") for an asOf, via the payroll taxYearFor.
function currentFy(asOfIso) {
  return payrollService._internal.taxYearFor(asOfIso || new Date().toISOString().slice(0, 10), 4);
}

// Build the per-claim rollup: declared (from SP) vs Σaccepted vs Σpending per claimType.
function buildRollup(sp, proofs) {
  const isOld = sp && String(sp.taxRegime).toUpperCase() === 'OLD';
  const rows = [];
  for (const ct of Object.keys(CLAIM_TYPE_META)) {
    const meta = CLAIM_TYPE_META[ct];
    // Feature 25 — FBP heads have their own ESS surface (/me/fbp) and back an
    // FbpAllocationLine, not a StatutoryProfile column (spField:null). They never
    // appear in the F20 investment-proof rollup — keep this view 80C/HRA/24b only.
    if (meta.fbp) continue;
    const declared = isOld && sp ? toNum(sp[meta.spField]) : 0;
    const mine = proofs.filter((p) => p.claimType === ct);
    let accepted = 0; let pending = 0; let rejected = 0;
    for (const p of mine) {
      if (p.status === 'ACCEPTED' && p.verifiedAmount != null) accepted += toNum(p.verifiedAmount);
      else if (p.status === 'PENDING') pending += toNum(p.declaredAmount);
      else if (p.status === 'REJECTED') rejected += toNum(p.declaredAmount);
    }
    // Only surface a claim the employee actually declared (or already uploaded against).
    if (declared <= 0 && mine.length === 0) continue;
    rows.push({
      claimType: ct,
      label: meta.label,
      declared,
      verified: Math.min(declared, accepted),
      pendingAmount: pending,
      rejectedAmount: rejected,
      proofCount: mine.length,
      requiresProof: meta.engineConsumed,
    });
  }
  return rows;
}

// ── GET /api/hr/me/proofs?fy=2026-27 — my proofs + window status + rollup ──────
async function listMyProofs(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const country = await resolveStatutoryCountry(businessId, emp);
    if (country !== 'IN') {
      return res.status(422).json({ message: 'Investment proofs are available for India only.', code: 'COUNTRY_UNSUPPORTED' });
    }
    const fy = typeof req.query.fy === 'string' && /^\d{4}-\d{2}$/.test(req.query.fy) ? req.query.fy : currentFy();
    const sp = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId: emp.id } });
    const regime = sp && sp.taxRegime ? String(sp.taxRegime).toUpperCase() : 'NEW';
    const window = await resolveWindow({ businessId, financialYear: fy });
    const proofs = await prisma.investmentProof.findMany({
      where: { businessId, employeeId: emp.id, financialYear: fy, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      employeeId: emp.id,
      financialYear: fy,
      regime,
      // NEW regime ignores proofs (no Chapter-VIA/HRA) — surface that loudly to the UI.
      proofsApplicable: regime === 'OLD',
      window: window ? {
        id: window.id, status: window.status, opensAt: window.opensAt,
        closesAt: window.closesAt, proofDeadline: window.proofDeadline,
        canUpload: window.status === 'OPEN' && regime === 'OLD',
      } : null,
      rollup: buildRollup(sp, proofs),
      proofs: proofs.map(publicProof),
    });
  } catch (e) { next(e); }
}

// ── POST /api/hr/me/proofs — upload one proof (window OPEN, OLD regime, self-only) ─
async function uploadProof(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const country = await resolveStatutoryCountry(businessId, emp);
    if (country !== 'IN') {
      return res.status(422).json({ message: 'Investment proofs are available for India only.', code: 'COUNTRY_UNSUPPORTED' });
    }

    const body = req.body || {};
    const claimType = body.claimType;
    if (!isValidClaimType(claimType)) {
      return res.status(422).json({ message: `Invalid claimType: ${claimType}` });
    }

    const sp = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId: emp.id } });
    const regime = sp && sp.taxRegime ? String(sp.taxRegime).toUpperCase() : 'NEW';
    // NEW regime: proofs are not collected (engine zeroes deductions). Mirror saveDeclaration.
    if (regime !== 'OLD') {
      return res.status(409).json({ message: 'Proofs are not applicable under the new tax regime.', code: 'NEW_REGIME_NO_PROOFS' });
    }

    const fy = typeof body.financialYear === 'string' && /^\d{4}-\d{2}$/.test(body.financialYear)
      ? body.financialYear : currentFy();
    // Feature 25 — FBP bills (FBP_* claim types) ride the FBP_ALLOCATION window (its
    // proofDeadline is the declared→verified flip for the basket heads); investment
    // proofs ride the default INVESTMENT_PROOF window. One model, two purposes.
    const windowPurpose = isFbpClaimType(claimType) ? 'FBP_ALLOCATION' : 'INVESTMENT_PROOF';
    const window = await resolveWindow({ businessId, financialYear: fy, purpose: windowPurpose });
    if (!window) {
      return res.status(409).json({ message: 'The declaration window for this year is not configured yet.', code: 'NO_WINDOW' });
    }
    // §201 DATE GUARD (authoritative): the proofDeadline is the date the assembler
    // freezes TDS on VERIFIED figures. Past it, no new proof may enter — even if the
    // lifecycle cron was missed and the window is still flagged OPEN. The DATE wins;
    // the status flag is advisory. Without this, a late upload + accept would CUT the
    // already-frozen VERIFIED TDS (the §201 freeze defeated). shouldUseVerified is the
    // SAME primitive the assembler uses to flip DECLARED→VERIFIED, so the gate and the
    // math can never diverge.
    const asOf = new Date().toISOString().slice(0, 10);
    if (shouldUseVerified(window, asOf)) {
      return res.status(409).json({
        message: `The proof deadline (${String(window.proofDeadline).slice(0, 10)}) has passed; uploads are closed and verified TDS is frozen.`,
        code: 'PROOF_DEADLINE_PASSED',
      });
    }
    if (window.status !== 'OPEN') {
      return res.status(409).json({ message: `Uploads are only accepted while the window is OPEN (currently ${window.status}).`, code: 'WINDOW_NOT_OPEN' });
    }

    const declaredAmount = Math.max(0, toNum(body.declaredAmount));
    if (declaredAmount <= 0) {
      return res.status(422).json({ message: 'declaredAmount must be a positive number (annual ₹).' });
    }

    // HRA Rule 26C — landlord PAN mandatory when annual rent claimed > ₹1,00,000.
    let landlordName = null; let landlordPan = null; let rentMonthsCovered = null;
    if (claimType === 'HRA_RENT') {
      landlordName = typeof body.landlordName === 'string' ? body.landlordName.trim().slice(0, 120) || null : null;
      rentMonthsCovered = Number.isInteger(body.rentMonthsCovered) ? body.rentMonthsCovered : null;
      if (declaredAmount > HRA_LANDLORD_PAN_THRESHOLD_RUPEES) {
        const pan = typeof body.landlordPan === 'string' ? body.landlordPan.trim().toUpperCase() : '';
        if (!PAN_RE.test(pan)) {
          return res.status(422).json({
            message: `Landlord PAN is required (Rule 26C) when annual rent exceeds ₹${HRA_LANDLORD_PAN_THRESHOLD_RUPEES.toLocaleString('en-IN')}.`,
            code: 'LANDLORD_PAN_REQUIRED',
          });
        }
        landlordPan = pan;
      } else if (typeof body.landlordPan === 'string' && body.landlordPan.trim()) {
        const pan = body.landlordPan.trim().toUpperCase();
        if (!PAN_RE.test(pan)) return res.status(422).json({ message: 'Landlord PAN is not a valid PAN.', code: 'BAD_PAN' });
        landlordPan = pan;
      }
    }

    // Validate + store the file (server-computed hash; never trust client mime/size).
    const dataUrl = body.fileBase64 || body.dataUrl;
    const check = validateDocDataUrl(dataUrl);
    if (!check.ok) return res.status(check.status).json({ message: check.message });
    const fileHash = sha256(check.buffer);
    let fileUrl;
    if (s3.isConfigured()) {
      const up = await s3.uploadDataUrl({ dataUrl, businessId, scope: 'investment-proof' });
      fileUrl = up.url;
    } else {
      fileUrl = dataUrl; // dev/test fallback (same allow-list + cap already applied)
    }

    const proof = await prisma.investmentProof.create({
      data: {
        businessId,
        employeeId: emp.id,
        windowId: window.id,
        financialYear: fy,
        claimType,
        subSection: typeof body.subSection === 'string' ? body.subSection.trim().slice(0, 16) || null : null,
        declaredAmount,
        fileUrl,
        fileHash,
        mimeType: check.mime,
        sizeBytes: check.bytes,
        originalName: typeof body.originalName === 'string' ? body.originalName.slice(0, 200) : null,
        landlordName,
        landlordPan,
        rentMonthsCovered,
        status: 'PENDING',
      },
    });
    res.status(201).json(publicProof(proof));
  } catch (e) { next(e); }
}

// ── DELETE /api/hr/me/proofs/:id — withdraw own PENDING proof while window OPEN ──
async function withdrawProof(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const proof = await prisma.investmentProof.findFirst({
      where: { id: req.params.id, businessId, employeeId: emp.id, deletedAt: null },
    });
    if (!proof) return res.status(404).json({ message: 'Proof not found' });
    if (proof.status !== 'PENDING') {
      return res.status(409).json({ message: `Only a PENDING proof can be withdrawn (this one is ${proof.status}).` });
    }
    const window = await resolveWindow({ businessId, financialYear: proof.financialYear });
    if (window && window.status !== 'OPEN') {
      return res.status(409).json({ message: 'Proofs can only be withdrawn while the window is OPEN.' });
    }
    await prisma.investmentProof.update({
      where: { id: proof.id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    res.json({ ok: true, id: proof.id });
  } catch (e) { next(e); }
}

// ── GET /api/hr/me/proofs/form12bb.pdf?fy= — Form 12BB from the verified record ─
async function getForm12bbPdf(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const country = await resolveStatutoryCountry(businessId, emp);
    if (country !== 'IN') {
      return res.status(422).json({ message: 'Form 12BB is available for India only.', code: 'COUNTRY_UNSUPPORTED' });
    }
    const fy = typeof req.query.fy === 'string' && /^\d{4}-\d{2}$/.test(req.query.fy) ? req.query.fy : currentFy();
    const sp = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId: emp.id } });
    const regime = sp && sp.taxRegime ? String(sp.taxRegime).toUpperCase() : 'NEW';
    const window = await resolveWindow({ businessId, financialYear: fy });
    const proofs = await prisma.investmentProof.findMany({
      where: { businessId, employeeId: emp.id, financialYear: fy, deletedAt: null },
    });

    // The TDS basis matches the assembler: VERIFIED on/after the deadline, else DECLARED.
    const asOf = new Date().toISOString().slice(0, 10);
    const basis = (window && shouldUseVerified(window, asOf)) ? 'VERIFIED' : 'DECLARED';

    // Σ verified per claim type (ACCEPTED only), capped at declared.
    const verifiedFor = (ct) => {
      const declared = sp ? toNum(sp[CLAIM_TYPE_META[ct].spField]) : 0;
      const sum = proofs
        .filter((p) => p.claimType === ct && p.status === 'ACCEPTED' && p.verifiedAmount != null)
        .reduce((a, p) => a + toNum(p.verifiedAmount), 0);
      return Math.min(declared, sum);
    };
    const declaredFor = (ct) => (sp ? toNum(sp[CLAIM_TYPE_META[ct].spField]) : 0);

    // HRA particulars — pick the most-complete ACCEPTED proof (else any) for landlord details.
    const hraProofs = proofs.filter((p) => p.claimType === 'HRA_RENT');
    const hraLead = hraProofs.find((p) => p.status === 'ACCEPTED' && p.landlordPan) || hraProofs.find((p) => p.landlordName) || hraProofs[0];
    const rentPaid = declaredFor('HRA_RENT');
    const form = {
      employeeName: [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(' ') || emp.code,
      employeeCode: emp.code || null,
      pan: sp && sp.pan ? sp.pan : null,
      financialYear: fy,
      regime,
      basis,
      hra: rentPaid > 0 ? {
        rentPaid,
        verified: verifiedFor('HRA_RENT'),
        landlordName: hraLead ? hraLead.landlordName : null,
        landlordPan: hraLead ? hraLead.landlordPan : null,
        monthsCovered: hraLead ? hraLead.rentMonthsCovered : null,
      } : null,
      homeLoan: declaredFor('SEC_24B_HOME_LOAN') > 0 ? {
        declared: declaredFor('SEC_24B_HOME_LOAN'),
        verified: verifiedFor('SEC_24B_HOME_LOAN'),
        lenderName: null,
        lenderPan: null,
      } : null,
      chapterVIA: ['SEC_80C', 'SEC_80CCD1B', 'SEC_80D', 'SEC_80TTA']
        .map((ct) => ({ section: ct, label: CLAIM_TYPE_META[ct].label, declared: declaredFor(ct), verified: verifiedFor(ct) }))
        .filter((r) => r.declared > 0),
    };

    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true, name: true } });
    const pdf = await renderForm12bbPdf({ form, business });
    try {
      const pdfHash = crypto.createHash('sha256').update(pdf).digest('hex');
      res.setHeader('X-Document-SHA256', pdfHash);
    } catch (_e) { /* non-fatal */ }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="form12bb-${fy}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    return res.status(200).send(pdf);
  } catch (e) { next(e); }
}

module.exports = {
  listMyProofs, uploadProof, withdrawProof, getForm12bbPdf,
  _internals: { buildRollup, validateDocDataUrl, sha256, resolveActiveSelf, currentFy },
};
