'use strict';

/**
 * meExpenses.controller.js — Feature 11 Employee Self-Service (ESS) for reimbursement
 * claims + travel/outdoor-duty. Mounted at /api/hr/me/expenses on the CUSTOMER session.
 *
 * SELF-ONLY by construction: the subject employee is resolved ENTIRELY from the session
 * (resolveSelfEmployee) — there is NO employeeId accepted from any body/param, so a USER
 * can only ever see/act on their OWN claims + trips (IDOR-safe). A terminated/inactive
 * employee is locked out (404), the F4 ESS-lockout pattern.
 *
 * The flow the owner asked for:
 *   - Apply for reimbursement → DRAFT claim → add bill lines (receipt + live policy
 *     verdict) → submit → opens the F10 EXPENSE chain (manager → finance over threshold).
 *   - Apply for outdoor duty / travel → a TRV-#### travel id is minted → submit for
 *     pre-trip approval → add bills against that travel id.
 *   - Every bill is auto-validated against the active TravelPolicy on add + on submit;
 *     a HARD over-cap line BLOCKS submit (server-side, not just the UI).
 */

const prisma = require('../../core/lib/prisma');
const s3 = require('../../core/lib/s3');
const payrollService = require('../payroll/service');
const engine = require('../approvals/engine');
const service = require('./expenses.service');
const { evaluateLine, rollupVerdict } = require('./policyEngine');
const { validateDocDataUrl, sha256 } = require('../controllers/documents.controller');
require('../approvals/consumers.expense');
require('../approvals/consumers.travel');

// ── self resolution + lockout ───────────────────────────────────────────────
async function resolveActiveSelfId(req) {
  const { businessId } = req.customer;
  const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null }, select: { id: true, isActive: true } });
  if (!emp || emp.isActive === false) return null;
  return emp.id;
}
const noEmployee = (res) => res.status(404).json({ message: 'No active employee record for this account' });

// ── policy context for a claim/trip's owner ─────────────────────────────────
async function policyCtx(businessId, employeeId, trip) {
  const policy = await service.loadActivePolicy(businessId, {});
  const gradeRank = await service.gradeRankOf(businessId, employeeId);
  let cityTier = policy ? policy.defaultTier : 'TIER_3';
  let journeyHours = null;
  if (trip) {
    cityTier = trip.destTier || await service.resolveCityTier(businessId, trip.destCity, policy ? policy.countryCode : null, policy ? policy.defaultTier : 'TIER_3');
    journeyHours = trip.durationHours != null ? Number(trip.durationHours) : null;
  }
  const currencyCode = (policy && policy.currencyCode) || (trip && trip.currencyCode) || 'INR';
  return { policy, gradeRank, cityTier, journeyHours, currencyCode };
}

// ═══ CLAIMS ════════════════════════════════════════════════════════════════════

async function listClaims(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return res.json({ items: [], total: 0 });
    const { businessId } = req.customer;
    const where = { businessId, employeeId, deletedAt: null };
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.expenseClaim.findMany({
      where,
      include: {
        category: { select: { id: true, name: true } },
        travelRequest: { select: { id: true, travelNumber: true, destCity: true } },
        _count: { select: { lines: true } },
      },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

async function getClaim(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const claim = await prisma.expenseClaim.findFirst({
      where: { id: req.params.id, businessId, employeeId, deletedAt: null },
      include: { lines: { include: { category: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } }, category: true, travelRequest: true },
    });
    if (!claim) return res.status(404).json({ message: 'Expense claim not found' });
    res.json(claim);
  } catch (e) { next(e); }
}

// Create a DRAFT claim (standalone reimbursement OR booked against a trip the caller owns).
async function createClaim(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const b = req.body || {};

    let travelRequestId = null;
    let claimType = 'REIMBURSEMENT';
    if (b.travelRequestId) {
      const trip = await prisma.travelRequest.findFirst({ where: { id: b.travelRequestId, businessId, employeeId }, select: { id: true, status: true, currencyCode: true } });
      if (!trip) return res.status(400).json({ message: 'travelRequestId does not reference one of your trips' });
      travelRequestId = trip.id;
      claimType = 'TRAVEL';
    }
    if (b.categoryId) {
      const cat = await prisma.expenseCategory.findFirst({ where: { id: b.categoryId, businessId, deletedAt: null } });
      if (!cat) return res.status(400).json({ message: 'categoryId does not reference a valid category' });
    }

    // Mint EXP-#### atomically (allocateCode) inside the insert tx. The new
    // @@unique([businessId, claimNumber]) is the backstop: should the seeded counter ever
    // collide with a pre-existing legacy claim, the insert throws P2002 — we bump the
    // counter (allocateCode reads the now-incremented nextValue) and retry a few times.
    let claim;
    for (let attempt = 0; ; attempt += 1) {
      try {
        claim = await prisma.$transaction(async (tx) => {
          const claimNumber = await service.mintClaimNumber(tx, businessId);
          return tx.expenseClaim.create({
            data: {
              businessId, employeeId, status: 'DRAFT', claimType, travelRequestId,
              claimNumber,
              categoryId: b.categoryId || null,
              amount: '0', // header amount is the sum of lines, set on submit
              currencyCode: b.currencyCode || 'INR',
              description: b.description || null,
              expenseDate: b.expenseDate ? new Date(b.expenseDate) : null,
            },
          });
        });
        break;
      } catch (err) {
        if (err && err.code === 'P2002' && attempt < 5) continue; // counter advanced; retry
        throw err;
      }
    }
    res.status(201).json(claim);
  } catch (e) { next(e); }
}

// Edit a DRAFT claim header (description/category). Status/workflow stamps never settable.
async function updateClaim(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const claim = await prisma.expenseClaim.findFirst({ where: { id: req.params.id, businessId, employeeId, deletedAt: null } });
    if (!claim) return res.status(404).json({ message: 'Expense claim not found' });
    if (claim.status !== 'DRAFT') return res.status(409).json({ message: `Cannot edit a claim in status ${claim.status}` });
    const b = req.body || {};
    const data = {};
    if (b.description !== undefined) data.description = b.description;
    if (b.categoryId !== undefined) {
      if (b.categoryId) {
        const cat = await prisma.expenseCategory.findFirst({ where: { id: b.categoryId, businessId, deletedAt: null } });
        if (!cat) return res.status(400).json({ message: 'categoryId does not reference a valid category' });
      }
      data.categoryId = b.categoryId || null;
    }
    const updated = await prisma.expenseClaim.update({ where: { id: claim.id }, data });
    res.json(updated);
  } catch (e) { next(e); }
}

// Add a bill line (+ optional receipt data URL). Returns the LIVE policy verdict so the
// ESS shows "within budget / over by ₹X / not allowed" the moment a line is added.
async function addLine(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const claim = await prisma.expenseClaim.findFirst({
      where: { id: req.params.id, businessId, employeeId, deletedAt: null },
      include: { travelRequest: true },
    });
    if (!claim) return res.status(404).json({ message: 'Expense claim not found' });
    if (claim.status !== 'DRAFT') return res.status(409).json({ message: `Cannot add a bill to a claim in status ${claim.status}` });

    const b = req.body || {};
    const amount = Number(b.amount);
    if (b.amount === undefined || b.amount === null || b.amount === '' || Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: 'amount must be a positive number' });
    }
    if (b.categoryId) {
      const cat = await prisma.expenseCategory.findFirst({ where: { id: b.categoryId, businessId, deletedAt: null } });
      if (!cat) return res.status(400).json({ message: 'categoryId does not reference a valid category' });
    }

    // Receipt upload (optional): validate + hash server-side, store via s3 with inline fallback.
    let receiptUrl = null; let fileHash = null; let mimeType = null;
    if (b.fileBase64) {
      const check = validateDocDataUrl(b.fileBase64);
      if (!check.ok) return res.status(check.status).json({ message: check.message });
      fileHash = sha256(check.buffer);
      mimeType = check.mime;
      if (s3.isConfigured()) {
        const up = await s3.uploadDataUrl({ dataUrl: b.fileBase64, businessId, scope: `expense-${claim.id}` });
        receiptUrl = up.url;
      } else {
        receiptUrl = b.fileBase64; // inline-data-URL fallback (receiptUrl nullable)
      }
    }

    // The cap-driving dimensions (nights / distanceKm / durationBand) are CLIENT-supplied
    // and feed straight into the policy caps, so derive/bound them against the trip BEFORE
    // they touch the engine or the DB. An inflated band/nights/distance is rejected here —
    // it can never be persisted, so it can never later read "within policy" at submit.
    const sane = service.sanitizeTripDimensions(
      { distanceKm: b.distanceKm, nights: b.nights, durationBand: b.durationBand },
      claim.travelRequest,
    );
    if (!sane.ok) return res.status(400).json({ message: sane.reason, reason: 'POLICY_DIMENSION_INVALID' });

    // Evaluate the line against the active policy (live verdict) using the SANITISED dims.
    const ctx = await policyCtx(businessId, employeeId, claim.travelRequest);
    const lineForEval = {
      amount, categoryId: b.categoryId || null,
      transportMode: b.transportMode || null,
      distanceKm: sane.value.distanceKm,
      nights: sane.value.nights,
      durationBand: sane.value.durationBand,
      receiptUrl,
    };
    const verdict = await service.evaluateOneLine(businessId, employeeId, lineForEval, ctx);

    const line = await prisma.expenseClaimLine.create({
      data: {
        businessId, claimId: claim.id,
        description: b.description || null,
        amount: String(amount),
        receiptUrl, fileHash, mimeType,
        categoryId: b.categoryId || null,
        expenseDate: b.expenseDate ? new Date(b.expenseDate) : null,
        transportMode: b.transportMode || null,
        distanceKm: sane.value.distanceKm != null ? String(sane.value.distanceKm) : null,
        nights: sane.value.nights,
        durationBand: sane.value.durationBand,
        policyStatus: verdict.verdict,
        policyReason: verdict.reason,
        appliedCap: verdict.appliedCap != null ? String(verdict.appliedCap) : null,
      },
    });
    res.status(201).json({ line, verdict });
  } catch (e) { next(e); }
}

async function removeLine(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const claim = await prisma.expenseClaim.findFirst({ where: { id: req.params.id, businessId, employeeId, deletedAt: null } });
    if (!claim) return res.status(404).json({ message: 'Expense claim not found' });
    if (claim.status !== 'DRAFT') return res.status(409).json({ message: `Cannot edit a claim in status ${claim.status}` });
    const line = await prisma.expenseClaimLine.findFirst({ where: { id: req.params.lineId, businessId, claimId: claim.id } });
    if (!line) return res.status(404).json({ message: 'Bill line not found' });
    if (line.receiptUrl && s3.isOurUrl(line.receiptUrl)) await s3.deleteByUrl(line.receiptUrl).catch(() => {});
    await prisma.expenseClaimLine.delete({ where: { id: line.id } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// Submit a DRAFT claim. Re-validates EVERY line, snapshots the policy onto the claim,
// sets the header amount = sum of lines, sets the rollup verdict, and — if any line is
// AUTO_REJECTED (a HARD over-cap) — BLOCKS submit with the reason (server-side, 400).
// Otherwise flips DRAFT→SUBMITTED + opens the F10 EXPENSE request in the SAME tx.
async function submitClaim(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const claim = await prisma.expenseClaim.findFirst({
      where: { id: req.params.id, businessId, employeeId, deletedAt: null },
      include: { lines: true, travelRequest: true },
    });
    if (!claim) return res.status(404).json({ message: 'Expense claim not found' });
    if (claim.status !== 'DRAFT') return res.status(409).json({ message: `Claim is ${claim.status}, cannot submit` });
    if (!claim.lines.length) return res.status(400).json({ message: 'Add at least one bill before submitting' });

    // Single-currency invariant.
    const currencies = new Set(claim.lines.map((l) => claim.currencyCode));
    if (currencies.size > 1) return res.status(400).json({ message: 'A claim must be single-currency' });

    // Re-evaluate every line against the policy (the authoritative server-side pass).
    const ctx = await policyCtx(businessId, employeeId, claim.travelRequest);
    const evaluated = [];
    let total = 0;
    for (const l of claim.lines) {
      // RE-DERIVE (never re-trust) the cap-driving dimensions from the trip. A persisted
      // line whose band/nights/distance no longer fits the trip (trip changed after the
      // line was added, or a line minted before this guard existed) is treated as a HARD
      // blocker here — the over-cap bill can never enter the chain flagged "within policy".
      const sane = service.sanitizeTripDimensions(
        { distanceKm: l.distanceKm != null ? Number(l.distanceKm) : null, nights: l.nights, durationBand: l.durationBand },
        claim.travelRequest,
      );
      if (!sane.ok) {
        evaluated.push({ lineId: l.id, verdict: 'AUTO_REJECTED', appliedCap: null, reason: sane.reason });
        continue;
      }
      const lineForEval = {
        amount: Number(l.amount), categoryId: l.categoryId,
        transportMode: l.transportMode, distanceKm: sane.value.distanceKm,
        nights: sane.value.nights, durationBand: sane.value.durationBand, receiptUrl: l.receiptUrl,
      };
      const v = await service.evaluateOneLine(businessId, employeeId, lineForEval, ctx);
      evaluated.push({ lineId: l.id, ...v });
      // Only OK + FLAGGED lines count toward the claim total (AUTO_REJECTED never reaches the chain under HARD).
      total += Number(l.amount || 0);
    }
    const blockers = evaluated.filter((e) => e.verdict === 'AUTO_REJECTED');
    if (blockers.length) {
      return res.status(400).json({
        message: 'Some bills exceed a hard policy cap and cannot be submitted',
        reason: 'POLICY_HARD_BLOCK',
        blockers: blockers.map((bk) => ({ lineId: bk.lineId, reason: bk.reason })),
      });
    }
    const rollup = rollupVerdict(evaluated.map((e) => e.verdict));
    const snapshot = service.buildPolicySnapshot(ctx.policy, evaluated);

    const updated = await prisma.$transaction(async (tx) => {
      // persist per-line verdicts
      for (const ev of evaluated) {
        await tx.expenseClaimLine.update({
          where: { id: ev.lineId },
          data: { policyStatus: ev.verdict, policyReason: ev.reason, appliedCap: ev.appliedCap != null ? String(ev.appliedCap) : null },
        });
      }
      const flip = await tx.expenseClaim.updateMany({
        where: { id: claim.id, status: 'DRAFT' },
        data: {
          status: 'SUBMITTED', submittedAt: new Date(),
          amount: String(total),
          policyVerdict: rollup,
          policyId: ctx.policy ? ctx.policy.id : null,
          policySnapshotJson: snapshot,
        },
      });
      if (flip.count === 0) { const err = new Error('Claim changed concurrently'); err.code = 'DECISION_RACE'; throw err; }
      const fresh = await tx.expenseClaim.findUnique({ where: { id: claim.id } });
      await service.openClaimApproval(tx, { businessId, claim: fresh });
      return tx.expenseClaim.findUnique({ where: { id: claim.id } });
    });
    res.json(updated);
  } catch (e) {
    if (e && (e.code === 'DECISION_RACE' || e.code === 'P2025' || e.code === 'CONCURRENT_UPDATE')) {
      return res.status(409).json({ message: 'Claim changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    }
    next(e);
  }
}

// Withdraw own DRAFT/SUBMITTED claim. A SUBMITTED claim with an open chain cancels it.
async function cancelClaim(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const claim = await prisma.expenseClaim.findFirst({ where: { id: req.params.id, businessId, employeeId, deletedAt: null } });
    if (!claim) return res.status(404).json({ message: 'Expense claim not found' });
    if (!['DRAFT', 'SUBMITTED'].includes(claim.status)) return res.status(409).json({ message: `Cannot cancel a claim in status ${claim.status}` });
    const open = await prisma.approvalRequest.findFirst({ where: { businessId, module: 'EXPENSE', entityType: 'ExpenseClaim', entityId: claim.id, status: { in: ['PENDING', 'ESCALATED'] } } });
    if (open) {
      await engine.cancel({ approvalRequestId: open.id, actorUserId: req.user?.id || 'REQUESTER' });
    } else {
      await prisma.expenseClaim.updateMany({ where: { id: claim.id, status: claim.status }, data: { status: 'CANCELLED' } });
    }
    res.json(await prisma.expenseClaim.findUnique({ where: { id: claim.id } }));
  } catch (e) { next(e); }
}

// ═══ TRIPS (outdoor duty / travel) ══════════════════════════════════════════════

async function listTrips(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return res.json({ items: [], total: 0 });
    const { businessId } = req.customer;
    const where = { businessId, employeeId };
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.travelRequest.findMany({
      where, include: { _count: { select: { claims: true } } }, orderBy: { createdAt: 'desc' }, take: 200,
    });
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

async function getTrip(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const trip = await prisma.travelRequest.findFirst({
      where: { id: req.params.id, businessId, employeeId },
      include: { claims: { select: { id: true, claimNumber: true, amount: true, status: true, policyVerdict: true } } },
    });
    if (!trip) return res.status(404).json({ message: 'Travel request not found' });
    res.json(trip);
  } catch (e) { next(e); }
}

// Apply for outdoor duty / travel → mints a TRV-#### travel id, computes an estimate
// vs policy, and returns the trip (DRAFT). The employee submits it for pre-trip approval.
async function createTrip(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const b = req.body || {};
    if (!b.purpose) return res.status(400).json({ message: 'purpose is required' });
    if (!b.startAt || !b.endAt) return res.status(400).json({ message: 'startAt and endAt are required' });
    const startAt = new Date(b.startAt); const endAt = new Date(b.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt < startAt) {
      return res.status(400).json({ message: 'endAt must be on or after startAt' });
    }
    const durationHours = Math.max(1, Math.round((endAt - startAt) / 3600000));

    const policy = await service.loadActivePolicy(businessId, {});
    const destTier = await service.resolveCityTier(businessId, b.destCity, policy ? policy.countryCode : null, policy ? policy.defaultTier : 'TIER_3');
    const gradeRank = await service.gradeRankOf(businessId, employeeId);
    const currencyCode = (policy && policy.currencyCode) || b.currencyCode || 'INR';

    // Estimate (advisory) — per-diem band + hotel cap for the destination/level.
    const band = service.bandFromHours(durationHours);
    const estimate = { band, destTier, gradeRank, currencyCode, note: 'Indicative caps shown by the policy preview' };

    const trip = await prisma.$transaction(async (tx) => {
      const travelNumber = await service.mintTravelNumber(tx, businessId);
      return tx.travelRequest.create({
        data: {
          businessId, employeeId, travelNumber, status: 'DRAFT',
          purpose: b.purpose, isOutdoorDuty: !!b.isOutdoorDuty,
          originCity: b.originCity || null, destCity: b.destCity || null, destTier,
          startAt, endAt, durationHours,
          estimateJson: estimate,
          advanceAmount: b.advanceAmount != null && b.advanceAmount !== '' ? String(b.advanceAmount) : null,
          currencyCode,
          policyId: policy ? policy.id : null,
        },
      });
    });
    res.status(201).json(trip);
  } catch (e) { next(e); }
}

// Submit a DRAFT trip for pre-trip approval → opens the F10 TRAVEL request.
async function submitTrip(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const trip = await prisma.travelRequest.findFirst({ where: { id: req.params.id, businessId, employeeId } });
    if (!trip) return res.status(404).json({ message: 'Travel request not found' });
    if (trip.status !== 'DRAFT') return res.status(409).json({ message: `Trip is ${trip.status}, cannot submit` });
    const updated = await prisma.$transaction(async (tx) => {
      const flip = await tx.travelRequest.updateMany({ where: { id: trip.id, status: 'DRAFT' }, data: { status: 'SUBMITTED', submittedAt: new Date() } });
      if (flip.count === 0) { const err = new Error('Trip changed concurrently'); err.code = 'DECISION_RACE'; throw err; }
      const fresh = await tx.travelRequest.findUnique({ where: { id: trip.id } });
      await service.openTripApproval(tx, { businessId, trip: fresh, estimateAmount: fresh.advanceAmount });
      return tx.travelRequest.findUnique({ where: { id: trip.id } });
    });
    res.json(updated);
  } catch (e) {
    if (e && (e.code === 'DECISION_RACE' || e.code === 'P2025' || e.code === 'CONCURRENT_UPDATE')) {
      return res.status(409).json({ message: 'Trip changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    }
    next(e);
  }
}

async function cancelTrip(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const trip = await prisma.travelRequest.findFirst({ where: { id: req.params.id, businessId, employeeId } });
    if (!trip) return res.status(404).json({ message: 'Travel request not found' });
    if (!['DRAFT', 'SUBMITTED'].includes(trip.status)) return res.status(409).json({ message: `Cannot cancel a trip in status ${trip.status}` });
    const open = await prisma.approvalRequest.findFirst({ where: { businessId, module: 'TRAVEL', entityType: 'TravelRequest', entityId: trip.id, status: { in: ['PENDING', 'ESCALATED'] } } });
    if (open) await engine.cancel({ approvalRequestId: open.id, actorUserId: req.user?.id || 'REQUESTER' });
    else await prisma.travelRequest.updateMany({ where: { id: trip.id, status: trip.status }, data: { status: 'CANCELLED' } });
    res.json(await prisma.travelRequest.findUnique({ where: { id: trip.id } }));
  } catch (e) { next(e); }
}

// ═══ POLICY PREVIEW (live "within / over budget" badge for a draft line) ════════
async function previewPolicy(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const b = req.body || {};
    let trip = null;
    if (b.travelRequestId) {
      trip = await prisma.travelRequest.findFirst({ where: { id: b.travelRequestId, businessId, employeeId } });
    }
    const ctx = await policyCtx(businessId, employeeId, trip);
    // Preview must not lie: sanitise the cap-driving dims exactly as add/submit will, so the
    // badge reflects the server truth. An out-of-bounds dim surfaces as an AUTO_REJECTED
    // verdict (the same block submit applies) rather than a falsely "within policy" preview.
    const sane = service.sanitizeTripDimensions(
      { distanceKm: b.distanceKm, nights: b.nights, durationBand: b.durationBand },
      trip,
    );
    if (!sane.ok) {
      return res.json({
        verdict: { verdict: 'AUTO_REJECTED', appliedCap: null, reason: sane.reason },
        cityTier: ctx.cityTier, gradeRank: ctx.gradeRank, currencyCode: ctx.currencyCode,
      });
    }
    const line = {
      amount: b.amount != null ? Number(b.amount) : null,
      categoryId: b.categoryId || null,
      transportMode: b.transportMode || null,
      distanceKm: sane.value.distanceKm,
      nights: sane.value.nights,
      durationBand: sane.value.durationBand,
      receiptUrl: b.hasReceipt ? 'present' : null,
    };
    const verdict = await service.evaluateOneLine(businessId, employeeId, line, ctx);
    res.json({ verdict, cityTier: ctx.cityTier, gradeRank: ctx.gradeRank, currencyCode: ctx.currencyCode });
  } catch (e) { next(e); }
}

// Reference data the ESS forms need: categories + active policy summary.
async function reference(req, res, next) {
  try {
    const { businessId } = req.customer;
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return res.json({ categories: [], policy: null });
    const categories = await prisma.expenseCategory.findMany({ where: { businessId, deletedAt: null, isActive: true }, select: { id: true, name: true, code: true }, orderBy: { name: 'asc' } });
    const policy = await service.loadActivePolicy(businessId, {});
    res.json({
      categories,
      policy: policy ? { id: policy.id, name: policy.name, currencyCode: policy.currencyCode, enforcement: policy.enforcement, defaultTier: policy.defaultTier } : null,
    });
  } catch (e) { next(e); }
}

module.exports = {
  // claims
  listClaims, getClaim, createClaim, updateClaim, addLine, removeLine, submitClaim, cancelClaim,
  // trips
  listTrips, getTrip, createTrip, submitTrip, cancelTrip,
  // policy / reference
  previewPolicy, reference,
};
