'use strict';

/**
 * onboard.controller.js — Feature 17 §4.4. Onboard-by-CTC: the friendly direct-hire
 * path that, in ONE $transaction, creates an Employee AND its first
 * CompensationRevision(HIRE, EFFECTIVE) from { policyId, ctcAnnual, dateOfJoining }.
 *
 * It reuses the SHARED hire-pay math (compensation/hireComp.buildHireRevisionLines)
 * + the SAME 50% fail-closed guard + employer-cost fixed point + line math that ATS
 * provisioning uses, so a direct hire and an ATS hire produce BYTE-IDENTICAL pay FOR
 * IDENTICAL STATUTORY INPUTS (the scoped §4.1 parity contract): the ESI/PF-cap knobs
 * come from the persisted policy here and from the SHARED hireComp defaults on the ATS
 * path, which equal an ESI-less policy's knobs. The resulting revision is an ordinary
 * HIRE/EFFECTIVE revision — indistinguishable downstream from an ATS hire.
 *
 * Invariants:
 *   - SINGLE-COUNTRY: countryCode/currency from the tenant (countryContext), never
 *     the body; basis = CTC for IN.
 *   - 50% wage floor FAIL-CLOSED on the DERIVED Basic+DA (HireCompError → 422).
 *   - APPEND-ONLY: writes a fresh revision; never edits.
 *   - IDEMPOTENT (TOCTOU-SAFE — review HIGH finding): dedupe is enforced by DB-level
 *     uniqueness, not just an app pre-check. A partial-unique on
 *     (businessId, workEmail, hireDate) WHERE workEmail IS NOT NULL AND deletedAt IS
 *     NULL backs the email+DOJ key; the existing (businessId, code) unique backs a
 *     client-supplied code. The Employee.create runs INSIDE the tx; a P2002 on either
 *     constraint is translated to 409 ALREADY_ONBOARDED returning the EXISTING row, so
 *     concurrent/retried identical POSTs converge to ONE employee (never a duplicate).
 *     A null-email hire MUST carry a stable natural key (person.code or
 *     idempotencyKey) — without one we refuse (400) rather than risk a double-insert.
 *   - TENANT-ISOLATED + audited (employee.create + compensation.change).
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const { tenantCountry, tenantCurrency, CountryError } = require('../tenant/countryContext');
const { buildHireRevisionLines, HireCompError } = require('../compensation/hireComp');
const { allocateCode } = require('../lifecycle/lib/codes');
const provision = require('../lifecycle/provision');

const { periodCodeFor } = provision._internals;

// YYYY-MM-DD from a Date|string (date-only, for effectiveFrom + DOJ comparisons).
function toDateOnly(x) {
  if (!x) return null;
  if (typeof x === 'string') return new Date(`${x.slice(0, 10)}T00:00:00.000Z`);
  const d = x instanceof Date ? x : new Date(x);
  return Number.isNaN(d.getTime()) ? null : new Date(d.toISOString().slice(0, 10) + 'T00:00:00.000Z');
}

// Resolve the entityId for the hire (explicit > location's entity > the tenant's
// first ACTIVE entity), mirroring employee.controller.resolveEntityId.
async function resolveEntityId(tx, { businessId, entityId, locationId }) {
  if (entityId) {
    const e = await tx.entity.findFirst({ where: { id: entityId, businessId, deletedAt: null }, select: { id: true, taxYearStartMonth: true } });
    if (e) return e;
  }
  if (locationId) {
    const loc = await tx.location.findFirst({ where: { id: locationId, businessId, deletedAt: null }, select: { entityId: true } });
    if (loc && loc.entityId) {
      const e = await tx.entity.findFirst({ where: { id: loc.entityId, businessId }, select: { id: true, taxYearStartMonth: true } });
      if (e) return e;
    }
  }
  return tx.entity.findFirst({
    where: { businessId, status: 'ACTIVE', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, taxYearStartMonth: true },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/hr/onboard/by-ctc
// ─────────────────────────────────────────────────────────────────────────────
async function byCtc(req, res, next) {
  try {
    const { businessId } = req.user;
    const person = (req.body && req.body.person) || {};
    const { policyId, ctcAnnual, dateOfJoining } = req.body || {};

    if (!person.firstName || !person.lastName) {
      return res.status(400).json({ message: 'firstName and lastName are required.' });
    }
    if (!policyId) return res.status(400).json({ message: 'A CTC policy is required.' });
    if (ctcAnnual == null || Number(ctcAnnual) <= 0) {
      return res.status(400).json({ message: 'A positive annual CTC is required.' });
    }
    const joinDate = toDateOnly(dateOfJoining);
    if (!joinDate) return res.status(400).json({ message: 'A valid date of joining is required.' });

    // Tenant country/currency (fail-closed) — drives basis + the comp stamp.
    let countryCode;
    let currencyCode;
    try {
      countryCode = await tenantCountry(businessId);
      currencyCode = await tenantCurrency(businessId);
    } catch (e) {
      if (e instanceof CountryError) {
        return res.status(e.status || 409).json({ error: e.code, message: 'Your company HR country is not set up yet.' });
      }
      throw e;
    }
    const basis = countryCode === 'IN' ? 'CTC' : 'GROSS';

    // DOJ guard (spec §7): restrict to today-or-future; a far-past DOJ → 400 with
    // guidance to use the F05 revision/arrears flow. A DOJ in the current month is
    // allowed (today's month start is the boundary).
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    if (joinDate < monthStart) {
      return res.status(400).json({
        error: 'DOJ_TOO_OLD',
        message: 'Date of joining is in a past period. Hire the employee, then use a compensation revision for back-dated/arrears pay.',
      });
    }

    const email = person.email ? String(person.email).trim().toLowerCase() : null;

    // The client-stable natural key for null-email hires: an explicit person.code, or
    // a body idempotencyKey used AS the code when no code is given. Without email AND
    // without either of these there is NO stable key to dedupe on, so a retry could
    // double-insert (the original TOCTOU bug) — refuse rather than risk a duplicate.
    const explicitCode = person.code && String(person.code).trim() ? String(person.code).trim() : null;
    const idemKey = req.body && req.body.idempotencyKey ? String(req.body.idempotencyKey).trim() : null;
    const requestedCode = explicitCode || idemKey || null; // the code we will insert if any
    if (!email && !requestedCode) {
      return res.status(400).json({
        error: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'A work email, employee code, or idempotencyKey is required so a retry cannot create a duplicate.',
      });
    }

    // IDEMPOTENCY / dedupe FAST PATH (correctness rests on the DB constraints below,
    // not on this pre-check). An existing non-deleted employee with the same work
    // email AND hire date → 409 returning that employee.
    if (email) {
      const existing = await prisma.employee.findFirst({
        where: { businessId, deletedAt: null, workEmail: email, hireDate: joinDate },
        select: { id: true, code: true },
      });
      if (existing) {
        return res.status(409).json({ error: 'ALREADY_ONBOARDED', message: 'This person is already onboarded for that joining date.', employee: existing });
      }
    }
    // Fast path for a client-supplied code (backed by the (businessId, code) unique).
    if (requestedCode) {
      const existingByCode = await prisma.employee.findFirst({
        where: { businessId, deletedAt: null, code: requestedCode },
        select: { id: true, code: true },
      });
      if (existingByCode) {
        return res.status(409).json({ error: 'ALREADY_ONBOARDED', message: 'An employee with that code is already onboarded.', employee: existingByCode });
      }
    }

    // Validate the policy exists/active up front (clean 404 before opening the tx).
    const policy = await prisma.ctcPolicy.findFirst({ where: { id: policyId, businessId, deletedAt: null, isActive: true } });
    if (!policy) return res.status(404).json({ message: 'CTC policy not found or inactive.' });

    const result = await prisma.$transaction(async (tx) => {
      // ── 1. Resolve the hire's salary lines via the SHARED helper (compile policy
      //    → materialize → 50% fail-closed). Same code path as ATS provisioning. ──
      const { lineCreates, breakup } = await buildHireRevisionLines({
        tx,
        businessId,
        countryCode,
        policyId,
        ctcAnnual: basis === 'CTC' ? ctcAnnual : null,
        grossMonthly: basis === 'GROSS' ? (req.body.grossMonthly || null) : null,
        joinDate,
        esiApplicable: policy.esiApplicable === true,
        capPfAtCeiling: policy.capPfAtCeiling !== false,
      });
      if (!lineCreates || !lineCreates.length) {
        const e = new HireCompError('The CTC policy produced no salary lines.', { status: 422, reason: 'empty-structure' });
        throw e;
      }

      // ── 2. Resolve the org entity (for the employment segment + leave period). ──
      const entity = await resolveEntityId(tx, { businessId, entityId: person.entityId, locationId: person.locationId });

      // ── 3. Create the Employee (auto-number if no code), mirroring the
      //    employee-create service so org/number-sequence/defaults match. The create
      //    is INSIDE the tx so a P2002 on the email+DOJ partial-unique OR the
      //    (businessId, code) unique aborts the whole hire atomically (no orphan
      //    revision/leave rows) — the outer catch then resolves the existing employee
      //    and returns 409 ALREADY_ONBOARDED (TOCTOU-safe, review HIGH finding).
      const code = requestedCode || await allocateCode(tx, { businessId, scope: 'EMPLOYEE' });
      let employee;
      try {
        employee = await tx.employee.create({
          data: {
            businessId,
            code,
            firstName: person.firstName,
            lastName: person.lastName,
            workEmail: email,
            phone: person.phone || null,
            countryCode,
            status: 'ACTIVE',
            isActive: true,
            hireDate: joinDate,
            managerEmployeeId: person.managerEmployeeId || null,
          },
        });
      } catch (err) {
        if (err && err.code === 'P2002') {
          // A concurrent identical onboard already inserted this natural key. Carry the
          // collided key out so the outer catch can return the EXISTING row (idempotent).
          const e = new Error('ONBOARD_RACE');
          e.code = 'ONBOARD_RACE';
          e.dedupe = { email, hireDate: joinDate, code, target: err.meta && err.meta.target };
          throw e;
        }
        throw err;
      }

      // ── 4. Initial HIRE EmploymentRecord (org context), if we can anchor an
      //    entity (mirror of provision STEP 4 / employee-create). ──
      if (entity && entity.id) {
        const rec = await tx.employmentRecord.create({
          data: {
            businessId,
            employeeId: employee.id,
            entityId: entity.id,
            locationId: person.locationId || null,
            departmentId: person.departmentId || null,
            designationId: person.designationId || null,
            managerEmployeeId: employee.managerEmployeeId || null,
            employmentType: 'FULL_TIME',
            workerCategory: 'STAFF',
            fteRatio: '1.0000',
            effectiveFrom: joinDate,
            changeReason: 'HIRE',
            isCurrent: true,
          },
        });
        employee = await tx.employee.update({ where: { id: employee.id }, data: { currentEmploymentRecordId: rec.id } });
      }

      // ── 5. CompensationRevision(HIRE, EFFECTIVE, isCurrent) with the materialized
      //    lines — an ordinary revision, indistinguishable from an ATS hire. ──
      const comp = await tx.compensationRevision.create({
        data: {
          businessId,
          employeeId: employee.id,
          entityId: entity ? entity.id : null,
          currencyCode,
          basis,
          ctcAnnual: basis === 'CTC' ? String(ctcAnnual) : null,
          grossMonthly: basis === 'GROSS' && req.body.grossMonthly != null ? String(req.body.grossMonthly) : (breakup ? String(breakup.grossMinor / 100) : null),
          effectiveFrom: joinDate,
          isCurrent: true,
          revisionReason: 'HIRE',
          status: 'EFFECTIVE',
          lines: { create: lineCreates },
        },
      });
      employee = await tx.employee.update({ where: { id: employee.id }, data: { currentCompensationId: comp.id } });

      // ── 6. Seed leave balances (opening 0) per applicable LeaveType, so a direct
      //    hire matches an ATS hire (mirror of provision STEP 10). ──
      const periodCode = periodCodeFor(joinDate, (entity && entity.taxYearStartMonth) || 4);
      const leaveTypes = await tx.leaveType.findMany({
        where: { businessId, isActive: true, deletedAt: null, OR: [{ countryCode: null }, { countryCode }] },
      });
      for (const lt of leaveTypes) {
        await tx.leaveBalance.upsert({
          where: { businessId_employeeId_leaveTypeId_periodCode: { businessId, employeeId: employee.id, leaveTypeId: lt.id, periodCode } },
          update: {},
          create: {
            businessId, employeeId: employee.id, leaveTypeId: lt.id, periodCode,
            unit: lt.unit || 'DAYS', opening: '0.0000', accrued: '0.0000', taken: '0.0000', closing: '0.0000',
          },
        });
      }

      return { employee, revisionId: comp.id, breakup };
    }, { timeout: 60000 });

    // Audit (best-effort; outside the tx so an audit hiccup never rolls the hire back).
    await writeAudit({ businessId, actorId: req.user.id, action: 'employee.create', entityType: 'Employee', entityId: result.employee.id, meta: { via: 'onboard-by-ctc', policyId } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'compensation.change', entityType: 'CompensationRevision', entityId: result.revisionId, meta: { op: 'onboard.hire', employeeId: result.employee.id, policyId } });

    return res.status(201).json({
      employee: { id: result.employee.id, code: result.employee.code, firstName: result.employee.firstName, lastName: result.employee.lastName },
      revisionId: result.revisionId,
      breakup: result.breakup
        ? {
            grossMonthlyMinor: result.breakup.grossMinor,
            basicDaMonthlyMinor: result.breakup.basicDaMonthlyMinor,
            employerCost: result.breakup.employerCost,
            wagesVerdict: result.breakup.wagesVerdict,
          }
        : null,
    });
  } catch (e) {
    if (e instanceof HireCompError) {
      return res.status(e.status || 422).json({ error: e.reason === 'wage-rule' ? 'WAGE_RULE' : String(e.reason || 'COMP_STRUCTURE').toUpperCase().replace(/-/g, '_'), message: e.message });
    }
    // A concurrent identical onboard won the insert (the DB unique fired inside the
    // tx). Resolve the existing employee by the collided natural key and return 409
    // ALREADY_ONBOARDED — idempotent, never a second employee (review HIGH finding).
    if (e && e.code === 'ONBOARD_RACE') {
      try {
        const { businessId } = req.user;
        const d = e.dedupe || {};
        const where = d.email && d.hireDate
          ? { businessId, deletedAt: null, workEmail: d.email, hireDate: d.hireDate }
          : { businessId, deletedAt: null, code: d.code };
        const existing = await prisma.employee.findFirst({ where, select: { id: true, code: true } })
          || (d.code ? await prisma.employee.findFirst({ where: { businessId, deletedAt: null, code: d.code }, select: { id: true, code: true } }) : null);
        return res.status(409).json({ error: 'ALREADY_ONBOARDED', message: 'This person is already onboarded.', employee: existing || undefined });
      } catch (_inner) {
        return res.status(409).json({ error: 'ALREADY_ONBOARDED', message: 'This person is already onboarded.' });
      }
    }
    // A raw P2002 that escaped the tx (e.g. the code unique on a path without the
    // sentinel) — treat as already-onboarded rather than a 500.
    if (e && e.code === 'P2002') {
      return res.status(409).json({ error: 'ALREADY_ONBOARDED', message: 'An employee with that natural key is already onboarded.' });
    }
    return next(e);
  }
}

module.exports = { byCtc };
