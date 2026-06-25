'use strict';

/**
 * disbursement.service.js — orchestrator for India salary disbursement.
 *
 * Converts an APPROVED / frozen (LOCKED) pay run into a PayoutBatch of
 * per-employee PayoutLines (a SNAPSHOT of net pay + the employee's primary bank
 * account), renders the bank salary-advice file from the PURE formatters in
 * bankFormats.js, and reconciles a UTR/status upload back onto the lines + batch.
 *
 * Invariants:
 *   - Tenant-walled: EVERY query is scoped by businessId; a cross-tenant id 404s.
 *   - India-only: the run's entity must be countryCode 'IN' (IFSC rail). NZ is
 *     served by the existing filing/newzealand bank batch — untouched here.
 *   - Money: integer minor units (paise) throughout; the DB columns are BIGINT,
 *     so we convert Number<->BigInt at the persistence boundary ONLY. Round-trip:
 *     Σ line.amountMinor == batch.totalMinor == run net (asserted on create).
 *   - Idempotent: createBatch is guarded against an over-pay (won't allow a 2nd
 *     batch once one is CREDITED for the run); generateFile is a pure re-render;
 *     reconcile is keyed by line and re-runnable.
 *
 * The HTTP layer (disbursement.controller.js) translates the thrown PayRunError
 * codes (reusing the existing payroll CODE_STATUS map) into status codes.
 */

const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');
const money = require('../money');
const { PayRunError } = require('../payrun');
const bankFormats = require('./bankFormats');
const payoutAdapter = require('./payoutAdapter');

// ── error helpers (same code vocabulary as payroll.controller's CODE_STATUS) ──
function notFound(message) {
  return new PayRunError('NOT_FOUND', message);
}
function badRequest(code, message) {
  return new PayRunError(code, message);
}

// ── minor-unit <-> BigInt boundary helpers ───────────────────────────────────
/** Number(paise) -> BigInt for a BIGINT column. Asserts integer minor first. */
function toBig(minor) {
  money.assertMinor(minor, 'amountMinor');
  return BigInt(minor);
}
/** BigInt|number from a BIGINT column -> safe Number(paise). */
function fromBig(v) {
  const n = typeof v === 'bigint' ? Number(v) : Number(v || 0);
  if (!Number.isSafeInteger(n)) {
    throw badRequest('STALE_TOTALS', `payout amount ${v} exceeds safe integer range`);
  }
  return n;
}

/** Prisma Decimal | number | string -> integer paise. */
function decimalToMinor(value, scale = 2) {
  if (value == null || value === '') return 0;
  let s;
  if (typeof value === 'object' && typeof value.toFixed === 'function') s = value.toFixed(scale);
  else if (typeof value === 'number') s = value.toFixed(scale);
  else s = String(value);
  return money.toMinor(s, scale);
}

/** YYYY-MM-DD from a Date | ISO string | null. */
function isoDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : String(value);
}

// Runs that are "ready to disburse": frozen (LOCKED) or APPROVED (or already
// PAID/FILED — you can still generate the advice for an already-paid run). DRAFT/
// COMPUTED/REVIEW are NOT disbursable (totals not yet committed by a checker).
const DISBURSABLE_STATUSES = new Set(['LOCKED', 'APPROVED', 'PAID', 'FILED']);

/**
 * loadRunForDisbursement — fetch the run tenant-scoped + assert India + state.
 * Returns the run (with entity). 404 on cross-tenant / missing.
 */
async function loadRunForDisbursement({ businessId, payRunId }) {
  const run = await prisma.payRun.findFirst({
    where: { id: payRunId, businessId, deletedAt: null },
    include: { entity: { select: { id: true, countryCode: true, payCurrency: true, legalName: true, code: true } } },
  });
  if (!run) throw notFound('Pay run not found');
  if (run.entity.countryCode !== 'IN') {
    throw badRequest('COUNTRY_UNSUPPORTED', 'Salary disbursement is India-only; this run is not an IN entity.');
  }
  return run;
}

/**
 * createBatch — build a PayoutBatch + PayoutLines for a run on a bank rail.
 *
 * Only allowed when the run is FROZEN(LOCKED)/APPROVED (or later). Selects each
 * PayRunLine's net pay + the employee's PRIMARY active BankAccount; employees
 * with no usable bank detail are FLAGGED (returned in `skipped`) and excluded
 * from the batch instead of failing the whole run. Persists the batch + lines in
 * a single transaction. Round-trips the total (Σ lines == batch total).
 */
async function createBatch({ businessId, actorId, payRunId, bank, debitAccount, valueDate, narration, force = false }) {
  if (!bank || !bankFormats.isSupportedBank(bank)) {
    throw badRequest('MISSING_FIELDS', `bank must be one of ${bankFormats.listBanks().map((b) => b.value).join(', ')}`);
  }
  const run = await loadRunForDisbursement({ businessId, payRunId });
  if (!DISBURSABLE_STATUSES.has(run.status)) {
    throw badRequest('BAD_STATE', `Disbursement requires a frozen or approved run (current: ${run.status}).`);
  }

  // Guard against a DOUBLE-PAY. A batch is only marked CREDITED after FULL
  // reconciliation, so a CREDITED-only guard leaves a wide-open window: between
  // generateFile (QUEUED→PROCESSING) and reconcile, the money is IN FLIGHT (a bank
  // file is already out) but no batch is CREDITED yet — a 2nd createBatch would
  // emit a 2nd identical file and pay everyone twice. So we refuse a new batch
  // while ANY non-terminal batch exists for the run (QUEUED/PROCESSING/PARTIAL/
  // CREDITED). Only a fully FAILED prior batch (no money landed) frees the run;
  // an explicit, audited `force` overrides even an in-flight batch (maker chose to
  // re-issue after a confirmed bank rejection of the whole file).
  const blocking = await prisma.payoutBatch.findFirst({
    where: { businessId, payRunId, status: { in: ['QUEUED', 'PROCESSING', 'PARTIAL', 'CREDITED'] } },
    select: { id: true, status: true, fileGeneratedAt: true },
    orderBy: { createdAt: 'desc' },
  });
  if (blocking && !force) {
    const e = badRequest('BAD_STATE', `A non-terminal payout batch (${blocking.status}) already exists for this run — treating its file as money-in-flight. Reconcile or fully fail it first, disburse corrections via a CORRECTION run, or pass force=true (audited) to re-issue.`);
    e.blockingBatchId = blocking.id;
    e.blockingStatus = blocking.status;
    throw e;
  }

  // Net pay per employee from the committed run lines (exclude EXCLUDED lines).
  const lines = await prisma.payRunLine.findMany({
    where: { businessId, payRunId, status: { notIn: ['EXCLUDED'] } },
    select: {
      employeeId: true,
      netPay: true,
      employee: { select: { id: true, code: true, firstName: true, lastName: true } },
    },
  });
  if (!lines.length) throw badRequest('BAD_STATE', 'This run has no payable lines.');

  // Primary active bank account per employee (tenant-scoped). Primary-first order,
  // first match wins — mirrors the NZ bank-batch selection in service.generateFile.
  const employeeIds = lines.map((l) => l.employeeId).filter(Boolean);
  const accounts = await prisma.bankAccount.findMany({
    where: { businessId, employeeId: { in: employeeIds }, isActive: true, deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: { employeeId: true, accountName: true, accountNumber: true, ifsc: true, bankName: true, isPrimary: true },
  });
  const bankByEmployee = new Map();
  for (const a of accounts) {
    if (!bankByEmployee.has(a.employeeId)) bankByEmployee.set(a.employeeId, a);
  }

  const empName = (e) => [e.firstName, e.lastName].filter(Boolean).join(' ').trim();
  const IFSC_RE = bankFormats._internals.IFSC_RE;
  const ACCOUNT_RE = bankFormats._internals.ACCOUNT_RE;

  const payable = [];
  const skipped = []; // employees flagged: no/invalid bank detail or non-positive net
  for (const l of lines) {
    const emp = l.employee || {};
    const acct = bankByEmployee.get(l.employeeId) || null;
    const netMinor = decimalToMinor(l.netPay);
    const name = emp ? empName(emp) : '';

    if (netMinor <= 0) {
      skipped.push({ employeeId: l.employeeId, code: emp.code || null, name, reason: 'NON_POSITIVE_NET', detail: `Net pay is ${money.fromMinor(netMinor)}; nothing to credit.` });
      continue;
    }
    if (!acct || !acct.accountNumber) {
      skipped.push({ employeeId: l.employeeId, code: emp.code || null, name, reason: 'MISSING_BANK_ACCOUNT', detail: 'No primary active bank account on file.' });
      continue;
    }
    // Validate the account number (length/charset) BEFORE it reaches the
    // fixed-width formatter — a too-long or non-numeric account would otherwise be
    // silently truncated into a CORRUPTED account and route the credit to a wrong
    // (or non-existent) account. Flag it as a skipped offender, like INVALID_IFSC.
    const account = String(acct.accountNumber).trim();
    if (!ACCOUNT_RE.test(account)) {
      skipped.push({ employeeId: l.employeeId, code: emp.code || null, name, reason: 'INVALID_ACCOUNT', detail: `Account "${account}" is not 6-18 digits.` });
      continue;
    }
    const ifsc = String(acct.ifsc || '').trim().toUpperCase();
    if (!IFSC_RE.test(ifsc)) {
      skipped.push({ employeeId: l.employeeId, code: emp.code || null, name, reason: 'INVALID_IFSC', detail: `IFSC "${acct.ifsc || ''}" is not an 11-char IFSC.` });
      continue;
    }
    payable.push({
      employeeId: l.employeeId,
      amountMinor: netMinor,
      beneficiaryName: acct.accountName || name || emp.code || 'EMPLOYEE',
      accountNumber: account,
      ifsc,
      narration: narration || defaultNarration(run),
    });
  }

  if (!payable.length) {
    const e = badRequest('MISSING_BANK_DETAILS', `No employees can be paid: ${skipped.length} flagged. Fix bank details, then create the batch.`);
    e.statusCode = 422;
    e.offenders = skipped;
    throw e;
  }

  const totalMinor = money.sumMinor(payable.map((p) => p.amountMinor)); // round-trip anchor

  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.payoutBatch.create({
      data: {
        businessId,
        payRunId,
        bank,
        status: 'QUEUED',
        totalMinor: toBig(totalMinor),
        count: payable.length,
        currencyCode: run.entity.payCurrency || run.currencyCode || 'INR',
        debitAccount: debitAccount ? String(debitAccount).trim() : null,
        valueDate: valueDate ? new Date(`${isoDate(valueDate)}T00:00:00.000Z`) : (run.payDate || null),
        createdBy: actorId,
        lines: {
          create: payable.map((p) => ({
            businessId,
            employeeId: p.employeeId,
            amountMinor: toBig(p.amountMinor),
            beneficiaryName: p.beneficiaryName,
            accountNumber: p.accountNumber,
            ifsc: p.ifsc,
            narration: p.narration,
            status: 'PENDING',
          })),
        },
      },
      include: { lines: true },
    });
    return created;
  });

  await writeAudit({
    businessId,
    actorId,
    action: 'payout.batch.create',
    entityType: 'PayoutBatch',
    entityId: batch.id,
    // Record `force` + the batch it overrode so a re-issue over an in-flight batch
    // is always auditable (HIGH double-pay guard).
    meta: {
      payRunId, bank, count: payable.length, totalMinor, skippedCount: skipped.length,
      force: !!force, overrodeBatchId: blocking ? blocking.id : undefined, overrodeStatus: blocking ? blocking.status : undefined,
    },
  }).catch(() => {});

  const out = serializeBatch(batch);
  out.skipped = skipped; // surface the flagged employees so the UI can show "fix these"
  return out;
}

/** Default statement narration: "SAL <MONYYYY>" from the run period. */
function defaultNarration(run) {
  const d = isoDate(run.periodStart) || isoDate(run.payDate) || '';
  const m = /^(\d{4})-(\d{2})/.exec(d);
  if (!m) return 'SALARY';
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `SAL ${months[Number(m[2]) - 1]}${m[1]}`;
}

/**
 * generateFile — render the bank salary-advice file for a batch via the PURE
 * formatter, and stamp fileGeneratedAt (first generation flips QUEUED→PROCESSING).
 * Re-rendering this same already-generated batch is allowed (idempotent
 * re-download). But it REFUSES to render a file while a DIFFERENT (sibling) batch
 * on the same run has a generated-but-unreconciled file — that sibling's file is
 * money-in-flight, and a second live file would double-pay. Returns { fileName,
 * contentType, content, meta }.
 */
async function generateFile({ businessId, batchId }) {
  const batch = await prisma.payoutBatch.findFirst({
    where: { id: batchId, businessId },
    include: {
      payRun: { select: { code: true, periodStart: true } },
      lines: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!batch) throw notFound('Payout batch not found');

  // HIGH double-pay guard: a sibling batch on this run whose file is already out
  // (fileGeneratedAt set) and NOT yet terminal-reconciled (still QUEUED/PROCESSING/
  // PARTIAL/CREDITED) is money-in-flight. Emitting a 2nd live file for the same run
  // pays everyone twice — refuse. (A fully FAILED sibling carried no money, so it
  // does not block.) Re-rendering THIS batch's own file stays allowed (idempotent).
  const inFlightSibling = await prisma.payoutBatch.findFirst({
    where: {
      businessId,
      payRunId: batch.payRunId,
      id: { not: batch.id },
      fileGeneratedAt: { not: null },
      status: { in: ['QUEUED', 'PROCESSING', 'PARTIAL', 'CREDITED'] },
    },
    select: { id: true, status: true },
  });
  if (inFlightSibling) {
    const e = badRequest('BAD_STATE', `Another payout batch (${inFlightSibling.status}) for this run already has a file in flight; generating a second file would double-pay. Reconcile or fully fail it first.`);
    e.blockingBatchId = inFlightSibling.id;
    e.blockingStatus = inFlightSibling.status;
    throw e;
  }

  const beneficiaries = batch.lines.map((l) => ({
    beneficiaryName: l.beneficiaryName,
    accountNumber: l.accountNumber,
    ifsc: l.ifsc,
    amountMinor: fromBig(l.amountMinor),
    narration: l.narration || undefined,
  }));

  const meta = {
    debitAccount: batch.debitAccount || '',
    valueDate: isoDate(batch.valueDate) || '',
    batchRef: batch.payRun ? batch.payRun.code : batch.id,
    defaultNarration: defaultNarration(batch.payRun || {}),
  };

  const rendered = bankFormats.generate(batch.bank, beneficiaries, meta); // pure; throws tagged 4xx

  // Round-trip guard: the freshly summed file total MUST equal the stored total.
  const storedTotal = fromBig(batch.totalMinor);
  if (rendered.totalMinor !== storedTotal) {
    throw badRequest('STALE_TOTALS', `File total ${rendered.totalMinor} != batch total ${storedTotal}.`);
  }

  // Stamp first-generation (QUEUED -> PROCESSING). Never regress a later status.
  if (!batch.fileGeneratedAt) {
    await prisma.payoutBatch.update({
      where: { id: batch.id },
      data: {
        fileGeneratedAt: new Date(),
        status: batch.status === 'QUEUED' ? 'PROCESSING' : batch.status,
      },
    });
  }

  const spec = bankFormats.formats[batch.bank];
  const safeRef = String(meta.batchRef).replace(/[^A-Za-z0-9_-]+/g, '_');
  return {
    fileName: `PAYOUT_${batch.bank}_${safeRef}.${spec.fileExt}`,
    contentType: spec.mime,
    content: rendered.content,
    meta: {
      kind: 'BANK_SALARY_ADVICE',
      bank: batch.bank,
      label: spec.label,
      count: rendered.count,
      totalMinor: rendered.totalMinor,
      totalRupees: money.fromMinor(rendered.totalMinor),
      valueDate: meta.valueDate,
    },
  };
}

/**
 * reconcile — apply a UTR/status upload onto the batch's lines and roll up the
 * batch status. `rows` is the parsed CSV: [{ accountNumber?, ifsc?, employeeCode?,
 * employeeId?, status, utr?, failureReason? }]. Each row is matched to a line by
 * (employeeId | employeeCode) else (accountNumber [+ ifsc]). Idempotent: a line
 * can be re-reconciled (e.g. RETURNED after CREDITED). Tenant-scoped.
 *
 * Returns the updated batch + a per-row match report.
 */
async function reconcile({ businessId, actorId, batchId, rows }) {
  if (!Array.isArray(rows)) throw badRequest('MISSING_FIELDS', 'reconcile rows must be an array');

  const batch = await prisma.payoutBatch.findFirst({
    where: { id: batchId, businessId },
    include: { lines: true },
  });
  if (!batch) throw notFound('Payout batch not found');

  // Index the lines for matching.
  const byEmpId = new Map();
  const byAccount = new Map();
  for (const l of batch.lines) {
    byEmpId.set(l.employeeId, l);
    byAccount.set(String(l.accountNumber).trim(), l);
  }
  // employeeCode -> employeeId (only needed when a row carries a code).
  let codeToId = null;
  if (rows.some((r) => r && r.employeeCode && !r.employeeId)) {
    const emps = await prisma.employee.findMany({
      where: { businessId, id: { in: batch.lines.map((l) => l.employeeId) } },
      select: { id: true, code: true },
    });
    codeToId = new Map(emps.map((e) => [String(e.code), e.id]));
  }

  const VALID = new Set(['PENDING', 'CREDITED', 'FAILED', 'RETURNED']);
  const report = [];
  const updates = []; // { id, data }
  const now = new Date();

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] || {};
    const status = String(r.status || '').trim().toUpperCase();
    if (!VALID.has(status)) {
      report.push({ index: i, matched: false, reason: 'BAD_STATUS', detail: `status "${r.status}" not in PENDING|CREDITED|FAILED|RETURNED` });
      continue;
    }
    let line = null;
    if (r.employeeId && byEmpId.has(r.employeeId)) line = byEmpId.get(r.employeeId);
    else if (r.employeeCode && codeToId && codeToId.has(String(r.employeeCode))) line = byEmpId.get(codeToId.get(String(r.employeeCode)));
    else if (r.accountNumber && byAccount.has(String(r.accountNumber).trim())) line = byAccount.get(String(r.accountNumber).trim());

    if (!line) {
      report.push({ index: i, matched: false, reason: 'NO_MATCH', detail: 'No batch line matched this row (by employee or account).' });
      continue;
    }
    // UTR is PROOF money left the company account. NEVER blank it on a status
    // change unless the row carries a new one: a previously-CREDITED line later
    // reconciled as RETURNED/FAILED must KEEP its original credit UTR (the proof of
    // a credited-then-clawed-back payment), so a row with no utr falls back to the
    // existing line.utr — for EVERY status, not just CREDITED. This also keeps a
    // stale re-applied row idempotent (it can't wipe the UTR).
    const newUtr = r.utr ? String(r.utr).trim() : line.utr || null;
    const data = {
      status,
      utr: newUtr,
      failureReason: status === 'FAILED' || status === 'RETURNED' ? (r.failureReason ? String(r.failureReason).trim() : 'Returned by bank') : null,
      // Idempotent timestamp: PENDING clears it; any settled status stamps `now` on
      // first settle but PRESERVES the existing reconciledAt on re-apply of a stale row.
      reconciledAt: status === 'PENDING' ? null : (line.reconciledAt || now),
    };
    updates.push({ id: line.id, data });
    report.push({ index: i, matched: true, lineId: line.id, employeeId: line.employeeId, status, clawedBack: status === 'RETURNED' && line.status === 'CREDITED' });
  }

  // Apply line updates + roll up the batch status in ONE transaction.
  const updated = await prisma.$transaction(async (tx) => {
    for (const u of updates) {
      await tx.payoutLine.update({ where: { id: u.id }, data: u.data });
    }
    // Recompute the rollup from the now-current line statuses. We count RETURNED
    // (clawed-back, money DID leave) SEPARATELY from FAILED (never paid) so the two
    // aren't conflated in the breakdown, even though both are non-credited for the
    // purposes of the batch-status rollup.
    const fresh = await tx.payoutLine.findMany({ where: { businessId, batchId: batch.id }, select: { status: true } });
    const total = fresh.length;
    const credited = fresh.filter((l) => l.status === 'CREDITED').length;
    const failedOnly = fresh.filter((l) => l.status === 'FAILED').length;
    const returnedOnly = fresh.filter((l) => l.status === 'RETURNED').length;
    const failed = failedOnly + returnedOnly; // non-credited settled (for rollup)
    let batchStatus;
    if (credited === total && total > 0) batchStatus = 'CREDITED';
    else if (failed === total && total > 0) batchStatus = 'FAILED';
    else if (credited > 0 || failed > 0) batchStatus = 'PARTIAL';
    else batchStatus = batch.fileGeneratedAt ? 'PROCESSING' : 'QUEUED';

    const isTerminal = batchStatus === 'CREDITED' || batchStatus === 'FAILED';
    const out = await tx.payoutBatch.update({
      where: { id: batch.id },
      data: { status: batchStatus, reconciledAt: isTerminal ? now : batch.reconciledAt },
      include: { lines: { orderBy: { createdAt: 'asc' } } },
    });
    out._breakdown = { total, credited, failed: failedOnly, returned: returnedOnly };
    return out;
  });

  const breakdown = updated._breakdown || null;
  await writeAudit({
    businessId,
    actorId,
    action: 'payout.batch.reconcile',
    entityType: 'PayoutBatch',
    entityId: batch.id,
    meta: { matched: report.filter((x) => x.matched).length, total: rows.length, status: updated.status, breakdown },
  }).catch(() => {});

  return { batch: serializeBatch(updated), report, breakdown };
}

/**
 * getBatch — read a single batch (tenant-scoped) with PAGINATED lines. 404 on a
 * cross-tenant id. `page`/`pageSize` page the lines (100+ employees).
 */
async function getBatch({ businessId, batchId, page = 1, pageSize = 100 }) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.min(500, Math.max(1, Number(pageSize) || 100));

  const batch = await prisma.payoutBatch.findFirst({
    where: { id: batchId, businessId },
    include: { payRun: { select: { code: true, status: true, periodStart: true, periodEnd: true } } },
  });
  if (!batch) throw notFound('Payout batch not found');

  const [lines, lineCount] = await Promise.all([
    prisma.payoutLine.findMany({
      where: { businessId, batchId },
      orderBy: { createdAt: 'asc' },
      skip: (p - 1) * size,
      take: size,
      include: { employee: { select: { code: true, firstName: true, lastName: true } } },
    }),
    prisma.payoutLine.count({ where: { businessId, batchId } }),
  ]);

  const out = serializeBatch(batch);
  out.payRun = batch.payRun
    ? { code: batch.payRun.code, status: batch.payRun.status, periodStart: isoDate(batch.payRun.periodStart), periodEnd: isoDate(batch.payRun.periodEnd) }
    : null;
  out.lines = lines.map(serializeLine);
  out.pagination = { page: p, pageSize: size, total: lineCount, pages: Math.ceil(lineCount / size) || 1 };
  return out;
}

/**
 * listBatches — paginated list of a run's batches (tenant-scoped). 404 if the
 * run isn't visible to this tenant.
 */
async function listBatches({ businessId, payRunId, page = 1, pageSize = 50 }) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.min(200, Math.max(1, Number(pageSize) || 50));

  const run = await prisma.payRun.findFirst({ where: { id: payRunId, businessId, deletedAt: null }, select: { id: true } });
  if (!run) throw notFound('Pay run not found');

  const [batches, total] = await Promise.all([
    prisma.payoutBatch.findMany({
      where: { businessId, payRunId },
      orderBy: { createdAt: 'desc' },
      skip: (p - 1) * size,
      take: size,
    }),
    prisma.payoutBatch.count({ where: { businessId, payRunId } }),
  ]);

  return {
    batches: batches.map(serializeBatch),
    pagination: { page: p, pageSize: size, total, pages: Math.ceil(total / size) || 1 },
    banks: bankFormats.listBanks(),
    gateway: { configured: payoutAdapter.isConfigured(), provider: payoutAdapter.getAdapter().id },
  };
}

// ── serialization (BigInt -> Number paise + rupee string for the UI) ──────────
function serializeBatch(b) {
  const totalMinor = fromBig(b.totalMinor);
  return {
    id: b.id,
    payRunId: b.payRunId,
    bank: b.bank,
    bankLabel: (bankFormats.formats[b.bank] || {}).label || b.bank,
    status: b.status,
    totalMinor,
    totalRupees: money.fromMinor(totalMinor),
    count: b.count,
    currencyCode: b.currencyCode,
    debitAccount: b.debitAccount,
    valueDate: isoDate(b.valueDate),
    gatewayProvider: b.gatewayProvider || null,
    gatewayBatchId: b.gatewayBatchId || null,
    createdBy: b.createdBy,
    fileGeneratedAt: b.fileGeneratedAt ? b.fileGeneratedAt.toISOString() : null,
    reconciledAt: b.reconciledAt ? b.reconciledAt.toISOString() : null,
    createdAt: b.createdAt ? b.createdAt.toISOString() : null,
    lines: Array.isArray(b.lines) ? b.lines.map(serializeLine) : undefined,
  };
}

function serializeLine(l) {
  const amountMinor = fromBig(l.amountMinor);
  const emp = l.employee || null;
  return {
    id: l.id,
    employeeId: l.employeeId,
    employeeCode: emp ? emp.code : undefined,
    employeeName: emp ? [emp.firstName, emp.lastName].filter(Boolean).join(' ') : undefined,
    amountMinor,
    amountRupees: money.fromMinor(amountMinor),
    beneficiaryName: l.beneficiaryName,
    // Mask the account number for display (last 4) — full value is only in the file.
    accountNumberMasked: maskAccount(l.accountNumber),
    ifsc: l.ifsc,
    narration: l.narration,
    status: l.status,
    utr: l.utr || null,
    failureReason: l.failureReason || null,
    reconciledAt: l.reconciledAt ? l.reconciledAt.toISOString() : null,
  };
}

function maskAccount(acct) {
  const s = String(acct || '');
  if (s.length <= 4) return s;
  return 'X'.repeat(Math.max(0, s.length - 4)) + s.slice(-4);
}

module.exports = {
  createBatch,
  generateFile,
  reconcile,
  getBatch,
  listBatches,
  // exposed for tests
  _internals: { serializeBatch, serializeLine, decimalToMinor, defaultNarration, maskAccount, DISBURSABLE_STATUSES },
};
