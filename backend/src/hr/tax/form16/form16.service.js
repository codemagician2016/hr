'use strict';

/**
 * form16.service.js — Feature 24 Form-16 orchestrator. The annual per-entity-per-FY
 * maker-checker generation run, mirroring bonus.service.js 1:1:
 *
 *   createForm16Batch  — India-gate + snapshot deductor PAN/TAN/name; DRAFT (409 if exists).
 *   computeForm16Batch — idempotent recompute: every employee with ≥1 published payslip in
 *                        the FY gets a FROZEN Form16Certificate (Part A + Part B + cert no).
 *                        Rolls up batch totals + reconciledOk. COMPUTED (computedBy = maker).
 *   approveForm16Batch — maker-checker SoD (approver ≠ computedBy); atomic single-approve.
 *   issueForm16Batch   — bulk-issue every PENDING cert through the EXISTING letters engine
 *                        (issueRenderedDocument → IssuedLetter + EmployeeDocument vault doc +
 *                        optional e-sign). Per-cert isolation; best-effort notify fan-out.
 *   regenerateForm16Certificate — void-old (revokeLetter) + re-mint ONE cert (supersede chain).
 *   export24Q          — delegates to form24q.service (reuse the pure generate24Q).
 *
 * Part A/Part B math is all in form16Assembler (zero new tax math; reuses F15). All
 * money is INTEGER paise through the service; BigInt conversion only at the edge.
 * India-only via assertCountry (fail-closed 404 for non-IN).
 */

const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');
const { assertCountry } = require('../../tenant/countryContext');
const { notifyHrEvent } = require('../../integrations/notifications');
const { allocateCode } = require('../../lifecycle/lib/codes');
const letters = require('../../letters/letters.service');
const assembler = require('./form16Assembler');
const { renderForm16Pdf } = require('./form16Pdf');
const form24q = require('./form24q.service');

class Form16Error extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.reason = code;
  }
}

// paise → "rupees.cc" string for Decimal edges (none here; BigInt is used directly).
function toBig(minor) { return BigInt(Math.round(Number(minor) || 0)); }
function fromBig(v) { return v == null ? 0 : Number(v); }
// rupees (number | Prisma.Decimal) → integer paise (for challan-pool reconciliation).
function toMinor(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// FORM16 / IN_FORM130 (FY ≥ 2026-27) — effective-dated form succession (§11), data not branch.
function resolveFormKind(financialYear) {
  const m = String(financialYear || '').match(/^(\d{4})-(\d{2})$/);
  const startYear = m ? Number(m[1]) : 0;
  return startYear >= 2026 ? 'IN_FORM130' : 'IN_FORM16';
}

// A ref-safe certificate-number prefix derived from the TAN (TRACES style).
function certPrefix(tan) {
  const t = String(tan || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `FORM16${t ? '/' + t : ''}`;
}

// ── 1. createForm16Batch ──────────────────────────────────────────────────────
async function createForm16Batch({ businessId, actorId, entityId, financialYear, notes }) {
  if (!entityId || !financialYear) throw new Form16Error('MISSING_FIELDS', 'entityId and financialYear are required', 400);
  if (!/^\d{4}-\d{2}$/.test(financialYear)) throw new Form16Error('BAD_FINANCIAL_YEAR', 'financialYear must be "YYYY-YY"', 422);

  const entity = await prisma.entity.findFirst({ where: { id: entityId, businessId } });
  if (!entity) throw new Form16Error('ENTITY_NOT_FOUND', 'Entity not found', 404);
  // India-gate (same gate bonus.service / service.createRun use): NZ has no Form 16.
  if (entity.countryCode) await assertCountry(businessId, entity.countryCode);
  if (entity.countryCode !== 'IN') throw new Form16Error('COUNTRY_NOT_SUPPORTED', 'Form 16 applies to India only', 404);

  try {
    const batch = await prisma.form16Batch.create({
      data: {
        businessId,
        entityId,
        financialYear,
        formKind: resolveFormKind(financialYear),
        status: 'DRAFT',
        // Deductor identity SNAPSHOT at generate (a later Entity edit can't alter an issued cert).
        deductorPan: entity.pan || null,
        deductorTan: entity.tan || null,
        deductorName: entity.legalName || entity.tradeName || null,
        notes: notes || null,
      },
    });
    await writeAudit({ businessId, actorId, action: 'form16.batch.create', entityType: 'Form16Batch', entityId: batch.id, meta: { entityId, financialYear } });
    return serializeBatch(batch);
  } catch (e) {
    if (e && e.code === 'P2002') throw new Form16Error('BATCH_EXISTS', `A Form 16 batch already exists for ${financialYear}`, 409);
    throw e;
  }
}

// ── 2. computeForm16Batch ─────────────────────────────────────────────────────
async function computeForm16Batch({ businessId, actorId, batchId, issueZeroTds = false }) {
  const batch = await loadBatch(businessId, batchId);
  if (batch.status === 'APPROVED' || batch.status === 'ISSUED') {
    throw new Form16Error('IMMUTABLE_BATCH', `Batch is ${batch.status}; recompute not allowed`, 409);
  }
  const entity = await prisma.entity.findFirst({ where: { id: batch.entityId, businessId } });
  if (!entity) throw new Form16Error('ENTITY_NOT_FOUND', 'Entity not found', 404);

  const { fyStartIso, fyEndIso } = assembler._internals.fyBounds(batch.financialYear);

  // Scope: every employee with ≥1 published payslip in the FY for this entity. This
  // is an entity-wide STATUTORY run (F1 applies on the READ/issue surfaces, not here).
  const payslipEmps = await prisma.payslip.findMany({
    where: {
      businessId,
      deletedAt: null,
      status: { in: ['PUBLISHED', 'VIEWED'] },
      periodEnd: { gte: new Date(fyStartIso), lte: new Date(fyEndIso) },
      payRun: { entityId: batch.entityId },
    },
    select: { employeeId: true },
    distinct: ['employeeId'],
  });
  const employeeIds = [...new Set(payslipEmps.map((p) => p.employeeId))];

  const deductor = {
    name: batch.deductorName || entity.legalName,
    pan: batch.deductorPan || entity.pan || null,
    tan: batch.deductorTan || entity.tan || null,
    address: [entity.addressLine1, entity.addressLine2, entity.city, entity.stateCode, entity.postalCode].filter(Boolean).join(', ') || null,
  };

  // ── ENTITY-LEVEL §201 challan pool (Finding 1) ────────────────────────────────
  // The TRUE deducted-vs-deposited reconciliation is at the ENTITY (batch) level:
  // Σ TDS the entity actually DEPOSITED (its PAID/FILED IN_TDS challan rows for the
  // FY) vs Σ TDS it DEDUCTED across all employees. A per-employee "a covering challan
  // exists" check cannot catch a short-DEPOSIT (deducted 6k but only 4k deposited) —
  // only this pool comparison can. The per-cert deposited figure is now the
  // employee's own slice (no entity-pool leak), so we compute the entity gap once
  // here rather than smearing the pool total onto every certificate.
  const { startYear } = assembler._internals.fyBounds(batch.financialYear);
  const challanPeriods = ['Q1', 'Q2', 'Q3', 'Q4']
    .flatMap((q) => assembler._internals.quarterTaxPeriods(q, startYear));
  const entityChallans = await prisma.statutoryRemittance.findMany({
    where: {
      businessId, entityId: batch.entityId, kind: 'IN_TDS',
      taxPeriod: { in: challanPeriods }, status: { in: ['PAID', 'FILED'] },
    },
    select: { amount: true },
  });
  const entityDepositedPoolMinor = entityChallans.reduce(
    (s, r) => s + toMinor(r.amount), 0,
  );

  // Build every employee's frozen certificate. allocateCode mints a deterministic,
  // tenant-unique, burned certificate number per (entity, FY). We compute in a tx
  // so a partial failure rolls back; idempotent recompute deletes + rewrites.
  let rolled;
  await prisma.$transaction(async (tx) => {
    // Idempotent: clear PENDING certs (issued certs are immutable — re-compute only
    // touches not-yet-issued rows; an issued batch is blocked above).
    await tx.form16Certificate.deleteMany({ where: { businessId, batchId } });

    let headcount = 0;
    let totalDeducted = 0;
    let totalDeposited = 0;
    let reconciledOk = true;

    for (const employeeId of employeeIds) {
      // Mint the certificate number inside the tx (atomic, burned, never reused).
      const code = await allocateCode(tx, {
        businessId, entityId: batch.entityId, scope: 'FORM16',
        prefix: `${certPrefix(deductor.tan)}/${batch.financialYear}/`, padding: 4, periodKey: batch.financialYear,
      });
      const certificateNo = code;

      const cert = await assembler.buildCertificate({
        businessId, employeeId, entity, deductor, financialYear: batch.financialYear, certificateNo, db: tx,
      });

      // Skip zero-TDS employees unless the batch opts in (Form 16 is for those from
      // whom TDS was deducted; Part-B-only certs are an opt-in policy — §11).
      const hasTds = cert.rollups.tdsDeductedMinor > 0;
      if (!hasTds && !issueZeroTds) continue;

      await tx.form16Certificate.create({
        data: {
          businessId,
          batchId,
          employeeId,
          financialYear: batch.financialYear,
          certificateNo,
          regime: cert.regime,
          partAJson: cert.partA,
          partBJson: cert.partB,
          grossSalaryMinor: toBig(cert.rollups.grossSalaryMinor),
          totalTaxableMinor: toBig(cert.rollups.totalTaxableMinor),
          totalTaxMinor: toBig(cert.rollups.totalTaxMinor),
          tdsDeductedMinor: toBig(cert.rollups.tdsDeductedMinor),
          tdsDepositedMinor: toBig(cert.rollups.tdsDepositedMinor),
          anomaliesJson: cert.anomalies && cert.anomalies.length ? cert.anomalies : null,
          status: 'PENDING',
        },
      });

      headcount += 1;
      totalDeducted += cert.rollups.tdsDeductedMinor;
      totalDeposited += cert.rollups.tdsDepositedMinor;
      if (!cert.reconciledOk) reconciledOk = false;
    }

    // ENTITY-LEVEL §201 gap: the batch is NOT reconciled if the entity's actual
    // challan pool deposit is short of the entity's total deducted TDS — a real
    // short-deposit liability that per-employee "challan exists" checks miss. We
    // certify the entity-deposited POOL as the batch's totalTdsDeposited (the true
    // amount in the government's hands), not the Σ of per-employee covered slices,
    // so the register shows the genuine deducted-vs-deposited position.
    const entityShortDeposit = entityDepositedPoolMinor < totalDeducted;
    if (entityShortDeposit) reconciledOk = false;
    totalDeposited = entityDepositedPoolMinor;

    await tx.form16Batch.update({
      where: { id: batchId },
      data: {
        status: 'COMPUTED',
        headcount,
        totalTdsDeductedMinor: toBig(totalDeducted),
        totalTdsDepositedMinor: toBig(totalDeposited),
        reconciledOk,
        computedAt: new Date(),
        computedBy: actorId,
        version: { increment: 1 },
      },
    });
    rolled = {
      headcount, totalDeducted, totalDeposited, reconciledOk,
      entityDepositedPoolMinor, entityShortDeposit,
    };
  }, { timeout: 60000 });

  await writeAudit({ businessId, actorId, action: 'form16.batch.compute', entityType: 'Form16Batch', entityId: batchId, meta: rolled });
  try {
    await notifyHrEvent({ businessId, event: 'form16.computed', triggeredBy: actorId, variables: { YEAR: batch.financialYear, COUNT: String(rolled.headcount) } });
  } catch (_) { /* notification failure must not fail the compute */ }

  return getForm16Batch({ businessId, batchId });
}

// ── 3. approveForm16Batch — maker-checker SoD; atomic single-approve ──────────
async function approveForm16Batch({ businessId, actorId, batchId }) {
  const batch = await loadBatch(businessId, batchId);
  if (batch.status !== 'COMPUTED') throw new Form16Error('BAD_STATE', `Approve requires a COMPUTED batch (current: ${batch.status})`, 409);
  if (!batch.computedBy) throw new Form16Error('SOD_MAKER_UNKNOWN', 'Batch maker is unknown; cannot approve (fail-closed)', 403);
  if (batch.computedBy === actorId) throw new Form16Error('MAKER_CHECKER', 'Maker-checker: the approver must differ from the employee who computed the batch', 403);

  // Atomic single-approve: conditional updateMany keyed on {status:'COMPUTED'} so two
  // concurrent approves serialise on the row lock — exactly one matches 1 row.
  const claim = await prisma.form16Batch.updateMany({
    where: { id: batchId, businessId, status: 'COMPUTED' },
    data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: actorId, version: { increment: 1 } },
  });
  if (claim.count !== 1) throw new Form16Error('BAD_STATE', 'Batch is no longer COMPUTED (lost the concurrent approve race)', 409);

  await writeAudit({ businessId, actorId, action: 'form16.batch.approve', entityType: 'Form16Batch', entityId: batchId, meta: { headcount: batch.headcount } });
  return getForm16Batch({ businessId, batchId });
}

// ── 4. issueForm16Batch — bulk-issue through the EXISTING letters engine ──────
async function issueForm16Batch({ businessId, actorId, batchId, sign = false, signers, force = false }) {
  const batch = await loadBatch(businessId, batchId);
  if (batch.status !== 'APPROVED' && batch.status !== 'ISSUED') {
    throw new Form16Error('BAD_STATE', `Issue requires an APPROVED batch (current: ${batch.status})`, 409);
  }
  // A non-reconciled batch (deducted ≠ deposited / unfiled challans) is a §201
  // liability — block issue unless the operator force-acknowledges (audited).
  if (!batch.reconciledOk && !force) {
    throw new Form16Error('NOT_RECONCILED', 'Batch is not reconciled (deducted-vs-deposited gap). Re-run after filing the challans, or force-acknowledge to issue anyway.', 409);
  }

  const entity = await prisma.entity.findFirst({ where: { id: batch.entityId, businessId } });
  const business = await prisma.business.findFirst({ where: { id: businessId }, select: { name: true, email: true } });
  const brand = await prisma.tenantBrand.findFirst({ where: { businessId, entityId: batch.entityId } })
    || await prisma.tenantBrand.findFirst({ where: { businessId, entityId: null } })
    || await prisma.tenantBrand.findFirst({ where: { businessId } });

  const certs = await prisma.form16Certificate.findMany({
    where: { businessId, batchId, status: 'PENDING' },
  });

  let issued = 0;
  let failed = 0;
  const deductor = {
    name: batch.deductorName || (entity && entity.legalName),
    pan: batch.deductorPan || (entity && entity.pan) || null,
    tan: batch.deductorTan || (entity && entity.tan) || null,
    address: entity ? [entity.addressLine1, entity.addressLine2, entity.city, entity.stateCode, entity.postalCode].filter(Boolean).join(', ') || null : null,
  };

  for (const cert of certs) {
    try {
      // Render the frozen Part A/B (no recompute — the cert is the immutable truth).
      const pdf = await renderForm16Pdf({
        partA: cert.partAJson,
        partB: cert.partBJson,
        deductor,
        deductee: cert.partAJson && cert.partAJson.deductee,
        business,
        brand: brand ? { signatoryName: brand.signatoryName, signatoryDesignation: brand.signatoryDesignation } : null,
      });

      // Issue through the EXISTING letters engine (ref-no + sha256 + IssuedLetter +
      // EmployeeDocument EMPLOYEE_VISIBLE + optional e-sign). The Form-16 PDF IS the
      // rendered artifact (issueRenderedDocument — the factored-out seam).
      const out = await letters.issueRenderedDocument(prisma, {
        businessId,
        entityId: batch.entityId,
        actorUserId: actorId,
        employeeId: cert.employeeId,
        pdf,
        subject: `Form 16 — ${cert.financialYear} — ${cert.certificateNo}`,
        category: 'CUSTOM',
        docCategory: 'FORM16',
        refNoPrefix: 'F16',
        sign: !!sign,
        signers,
        brand: brand ? { signatoryName: brand.signatoryName, signatoryDesignation: brand.signatoryDesignation } : null,
        business,
        mergeDataJson: { certificateNo: cert.certificateNo, financialYear: cert.financialYear },
        periodKey: cert.financialYear,
      });

      await prisma.form16Certificate.update({
        where: { id: cert.id },
        data: {
          issuedLetterId: out.issuedLetterId,
          employeeDocumentId: out.employeeDocumentId,
          fileHash: out.fileHash,
          signatureEnvelopeId: out.signatureEnvelopeId || null,
          status: sign ? 'PENDING_SIGNATURE' : 'ISSUED',
          version: { increment: 1 },
        },
      });
      issued += 1;

      // Best-effort per-employee notify fan-out (never aborts the batch).
      try {
        const emp = await prisma.employee.findUnique({ where: { id: cert.employeeId }, select: { firstName: true, workEmail: true, personalEmail: true } });
        await notifyHrEvent({
          businessId, event: 'form16.issued', triggeredBy: actorId,
          recipientEmail: emp ? (emp.workEmail || emp.personalEmail || undefined) : undefined,
          variables: { NAME: (emp && emp.firstName) || 'there', YEAR: cert.financialYear },
        });
      } catch (_) { /* per-recipient failure must not abort the batch */ }
    } catch (e) {
      // Per-cert failure is ISOLATED — the batch continues (the FnF/bonus per-row pattern).
      failed += 1;
      // eslint-disable-next-line no-console
      console.error('[form16.issue] cert failed', cert.id, e && e.message ? e.message : e);
    }
  }

  // Only mark the batch ISSUED when at least one certificate actually reached a
  // terminal issued/pending-signature state in this run (Finding 5). If every cert
  // failed (issued === 0 && failed > 0 — e.g. storePdf / e-sign down), keep the
  // batch APPROVED so the run is re-driveable and the status doesn't misrepresent a
  // 0-issued run as completed. An already-ISSUED batch re-driven with nothing left
  // to issue (issued === 0 && failed === 0 because certs.length === 0) stays ISSUED.
  const anyIssued = issued > 0;
  const alreadyIssued = batch.status === 'ISSUED';
  if (anyIssued || alreadyIssued) {
    await prisma.form16Batch.update({
      where: { id: batchId },
      data: {
        status: 'ISSUED',
        // Stamp issuedAt/By only on the first transition to ISSUED (don't overwrite
        // the original issue stamp on a later re-drive of an already-ISSUED batch).
        ...(alreadyIssued ? {} : { issuedAt: new Date(), issuedBy: actorId }),
        version: { increment: 1 },
      },
    });
  }
  await writeAudit({ businessId, actorId, action: 'form16.batch.issue', entityType: 'Form16Batch', entityId: batchId, meta: { issued, failed, sign: !!sign, force: !!force, batchIssued: anyIssued || alreadyIssued } });

  return {
    batchId, issued, failed, total: certs.length, signed: !!sign,
    batchStatus: (anyIssued || alreadyIssued) ? 'ISSUED' : batch.status,
  };
}

// ── 5. regenerateForm16Certificate — SUPERSEDE the old cert + INSERT a fresh one ──
// A re-generate NEVER mutates a frozen cert's partAJson/partBJson/certificateNo
// (those are the legal record at issue). It marks the old row SUPERSEDED and INSERTs
// a NEW cert row (fresh number, fresh Part A/B), linked both ways via the supersede
// chain — mirroring the IssuedLetter supersede pattern. The old certified figures
// remain immutable + recoverable from the SUPERSEDED row.
async function regenerateForm16Certificate({ businessId, actorId, batchId, employeeId, reason }) {
  const batch = await loadBatch(businessId, batchId);
  if (batch.status !== 'APPROVED' && batch.status !== 'ISSUED') {
    throw new Form16Error('BAD_STATE', 'Re-generate requires an APPROVED/ISSUED batch', 409);
  }
  // The ACTIVE cert (not an already-superseded history row) is the supersede source.
  const cert = await prisma.form16Certificate.findFirst({
    where: { businessId, batchId, employeeId, status: { not: 'SUPERSEDED' } },
    orderBy: { createdAt: 'desc' },
  });
  if (!cert) throw new Form16Error('NOT_FOUND', 'Certificate not found', 404);

  const entity = await prisma.entity.findFirst({ where: { id: batch.entityId, businessId } });
  if (!entity) throw new Form16Error('ENTITY_NOT_FOUND', 'Entity not found', 404);

  // 1) Void the old IssuedLetter (revokeLetter flips the ESS vault doc → HR_ONLY). The
  // revoked IssuedLetter + its PDF/sha256 stay linked to the SUPERSEDED cert row.
  if (cert.issuedLetterId) {
    try {
      await letters.revokeLetter(prisma, { businessId, actorUserId: actorId, id: cert.issuedLetterId, reason: reason || 'Form 16 re-generated (correction)' });
    } catch (_) { /* already voided / missing — proceed to re-mint */ }
  }

  const deductor = {
    name: batch.deductorName || entity.legalName,
    pan: batch.deductorPan || entity.pan || null,
    tan: batch.deductorTan || entity.tan || null,
    address: [entity.addressLine1, entity.addressLine2, entity.city, entity.stateCode, entity.postalCode].filter(Boolean).join(', ') || null,
  };

  // 2) Re-compute Part A/B + mint a FRESH certificate number (the old one is burned),
  // INSERT a new row, and SUPERSEDE the old one — atomically. The old row's frozen
  // partAJson/partBJson/certificateNo are NEVER touched.
  const updated = await prisma.$transaction(async (tx) => {
    const code = await allocateCode(tx, {
      businessId, entityId: batch.entityId, scope: 'FORM16',
      prefix: `${certPrefix(deductor.tan)}/${batch.financialYear}/`, padding: 4, periodKey: batch.financialYear,
    });
    const fresh = await assembler.buildCertificate({
      businessId, employeeId, entity, deductor, financialYear: batch.financialYear, certificateNo: code, db: tx,
    });
    // SUPERSEDE the old row FIRST — its frozen partAJson/partBJson/certificateNo stay
    // as-is (immutable); only status (→ SUPERSEDED) changes. This also clears it from
    // the ACTIVE partial-unique set so the replacement row (same business/batch/
    // employee) can be inserted without colliding on the one-active-cert constraint.
    await tx.form16Certificate.update({
      where: { id: cert.id },
      data: {
        status: 'SUPERSEDED',
        version: { increment: 1 },
      },
    });
    // INSERT the replacement cert (PENDING, ready for re-issue), linked to its source.
    const created = await tx.form16Certificate.create({
      data: {
        businessId,
        batchId,
        employeeId,
        financialYear: batch.financialYear,
        certificateNo: code,
        regime: fresh.regime,
        partAJson: fresh.partA,
        partBJson: fresh.partB,
        grossSalaryMinor: toBig(fresh.rollups.grossSalaryMinor),
        totalTaxableMinor: toBig(fresh.rollups.totalTaxableMinor),
        totalTaxMinor: toBig(fresh.rollups.totalTaxMinor),
        tdsDeductedMinor: toBig(fresh.rollups.tdsDeductedMinor),
        tdsDepositedMinor: toBig(fresh.rollups.tdsDepositedMinor),
        anomaliesJson: fresh.anomalies && fresh.anomalies.length ? fresh.anomalies : null,
        status: 'PENDING',
        supersedesCertId: cert.id,
      },
    });
    // Back-link the superseded row to its replacement (forward + back chain).
    await tx.form16Certificate.update({
      where: { id: cert.id },
      data: { supersededByCertId: created.id },
    });
    return created;
  });

  await writeAudit({ businessId, actorId, action: 'form16.cert.regenerate', entityType: 'Form16Certificate', entityId: cert.id, meta: { employeeId, reason: reason || null, oldCertId: cert.id, oldCertNo: cert.certificateNo, newCertId: updated.id, newCertNo: updated.certificateNo } });
  return serializeCert(updated);
}

// ── 6. export24Q — reuse the pure generate24Q (delegated) ─────────────────────
async function export24Q({ businessId, actorId, entityId, financialYear, quarter, persist = false }) {
  return form24q.export24Q({ businessId, actorId, entityId, financialYear, quarter, persist });
}

// ── reads ──────────────────────────────────────────────────────────────────
async function loadBatch(businessId, batchId) {
  const batch = await prisma.form16Batch.findFirst({ where: { id: batchId, businessId, deletedAt: null } });
  if (!batch) throw new Form16Error('NOT_FOUND', 'Form 16 batch not found', 404);
  return batch;
}

function serializeBatch(b) {
  return {
    ...b,
    totalTdsDeductedMinor: fromBig(b.totalTdsDeductedMinor),
    totalTdsDepositedMinor: fromBig(b.totalTdsDepositedMinor),
  };
}

function serializeCert(c) {
  return {
    ...c,
    grossSalaryMinor: fromBig(c.grossSalaryMinor),
    totalTaxableMinor: fromBig(c.totalTaxableMinor),
    totalTaxMinor: fromBig(c.totalTaxMinor),
    tdsDeductedMinor: fromBig(c.tdsDeductedMinor),
    tdsDepositedMinor: fromBig(c.tdsDepositedMinor),
  };
}

/**
 * getForm16Batch — batch + the certificate register. `scopeWhere` (F1) is applied
 * by the controller when reading the register; the service accepts an optional
 * `certWhere` fragment so an out-of-scope cert never appears.
 */
async function getForm16Batch({ businessId, batchId, certWhere = {} }) {
  const batch = await loadBatch(businessId, batchId);
  const certs = await prisma.form16Certificate.findMany({
    where: { businessId, batchId, ...certWhere },
    include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return {
    batch: serializeBatch(batch),
    certificates: certs.map((c) => ({
      ...serializeCert(c),
      employeeName: `${c.employee.firstName || ''} ${c.employee.lastName || ''}`.trim() || c.employee.code,
      employeeCode: c.employee.code,
      partA: c.partAJson,
      partB: c.partBJson,
      anomalies: c.anomaliesJson || [],
    })),
    totals: {
      headcount: batch.headcount,
      totalTdsDeductedMinor: fromBig(batch.totalTdsDeductedMinor),
      totalTdsDepositedMinor: fromBig(batch.totalTdsDepositedMinor),
      reconciledOk: batch.reconciledOk,
    },
  };
}

async function getForm16Certificate({ businessId, certificateId }) {
  const cert = await prisma.form16Certificate.findFirst({
    where: { id: certificateId, businessId },
    include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } } },
  });
  if (!cert) throw new Form16Error('NOT_FOUND', 'Certificate not found', 404);
  return {
    ...serializeCert(cert),
    employeeName: `${cert.employee.firstName || ''} ${cert.employee.lastName || ''}`.trim() || cert.employee.code,
    partA: cert.partAJson,
    partB: cert.partBJson,
    anomalies: cert.anomaliesJson || [],
  };
}

async function listForm16Batches({ businessId, entityId, status, page = 1, pageSize = 25 }) {
  const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { businessId, deletedAt: null };
  if (entityId) where.entityId = entityId;
  if (status) where.status = status;
  const [items, total] = await Promise.all([
    prisma.form16Batch.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { entity: { select: { id: true, code: true, legalName: true } } } }),
    prisma.form16Batch.count({ where }),
  ]);
  return { items: items.map(serializeBatch), total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take };
}

module.exports = {
  Form16Error,
  createForm16Batch,
  computeForm16Batch,
  approveForm16Batch,
  issueForm16Batch,
  regenerateForm16Certificate,
  export24Q,
  getForm16Batch,
  getForm16Certificate,
  listForm16Batches,
  _internals: { resolveFormKind, certPrefix, serializeBatch, serializeCert },
};
