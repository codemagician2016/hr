'use strict';

/**
 * provision.js — provisionEmployee() orchestrator (Feature 4 §4.2, §8 slice 4c).
 *
 * THE load-bearing, security-critical core of the lifecycle: it promotes a
 * PRE_HIRE onboarding journey into a real, payroll-ready Employee in ONE atomic
 * `$transaction`. Mirrors the exact shape a demo Employee gets in prisma/seed-hr.js
 * (Employee + portal User + Customer ESS identity + BusinessRole + Compensation +
 * EmploymentRecord + LeaveBalance), so a provisioned hire is indistinguishable
 * from a seeded one.
 *
 * Two hard guarantees (QA §7 cases 1–3):
 *   ATOMIC    — every row (Employee/User/Customer/EmploymentRecord/Compensation/
 *               LeaveBalance/…) commits together or not at all. A mid-provision
 *               throw rolls the WHOLE tx back (no orphan Employee/User), then a
 *               SEPARATE write marks the PROVISION_EMPLOYEE task FAILED + the
 *               journey BLOCKED and the error is surfaced.
 *   IDEMPOTENT — keyed on the journey. If a linked Employee already exists
 *               (Application.convertedEmployeeId set OR the PROVISION_EMPLOYEE
 *               task is already DONE) → return 409 { reason:'already-provisioned',
 *               employeeId } and do NOTHING. Concurrent double-submit is caught by
 *               a row-lock SELECT on the journey + the unique on Employee.userId /
 *               Employee.code (the loser's tx aborts on P2002 → re-resolves to 409).
 *
 * Reuses: NumberSequence allocator (lib/codes — EMPLOYEE scope), the recruitment
 * offerWageCheck (India 50% Basic+DA guard), the pure journeyEngine.advanceJourney
 * (PROVISIONING → DAY_ONE), and the seed-hr Customer/User ESS pattern.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const livePrisma = require('../../core/lib/prisma');
const { advanceJourney } = require('./journeyEngine');
const { allocateCode } = require('./lib/codes');
// offerWageCheck (the India Code-on-Wages 50% Basic+DA guard) is exported under
// the recruitment controller's `_internals` (see its module.exports). Reused —
// NOT re-implemented — so provisioning enforces the same wage floor as the offer.
const { _internals: recruitmentInternals } = require('../talent/controllers/recruitment.controller');
const { offerWageCheck } = recruitmentInternals;
// Feature 5 — materialize the offer/structure into resolved SalaryComponentLine
// rows so the HIRE revision carries REAL lines (the engine then computes a real
// gross; FnF reads a real Basic+DA). Without this the HIRE revision had zero
// lines → every provisioned hire computed zero gross. Pure; no DB.
const { materializeRevisionLines } = require('../compensation/deriveBreakup');

// A structured error the controller maps to an HTTP status. `reason` is a stable
// machine code; `status` the HTTP code; `employeeId` the already-linked id (409).
class ProvisionError extends Error {
  constructor(message, { status = 422, reason, employeeId } = {}) {
    super(message);
    this.name = 'ProvisionError';
    this.status = status;
    this.reason = reason;
    if (employeeId) this.employeeId = employeeId;
  }
}

// @db.Date wants a UTC-midnight instant.
function toDateOnly(x) {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDaysDate(base, days) {
  return new Date(base.getTime() + Number(days || 0) * 86400000);
}
// Tax/leave period code matching the seed convention ("2026-27", fiscal Apr start).
function periodCodeFor(date, startMonth = 4) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const startY = m >= startMonth ? y : y - 1;
  return `${startY}-${String((startY + 1) % 100).padStart(2, '0')}`;
}

// Feature 5 — Decimal|number|string → integer minor units (paise/cents) for the
// CTC materializer. Reuses payroll money (string math, no float drift).
const provMoney = require('../payroll/money');
function mtoMinor(value, scale = 2) {
  if (value == null || value === '') return 0;
  let s;
  if (typeof value === 'object' && typeof value.toFixed === 'function') s = value.toFixed(scale);
  else if (typeof value === 'number') s = value.toFixed(scale);
  else s = String(value);
  return provMoney.toMinor(s, scale);
}
// YYYY-MM-DD from a Date | string (for the wage-rule effective-dating).
function isoDateOnly(x) {
  if (!x) return new Date().toISOString().slice(0, 10);
  const d = x instanceof Date ? x : new Date(x);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// The PROVISION_EMPLOYEE checklist task for a journey (the one we mark DONE/FAILED).
async function findProvisionTask(client, journeyId) {
  return client.lifecycleTask.findFirst({
    where: { journeyId, taskKey: 'PROVISION_EMPLOYEE' },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * resolveOfferApproverUserId(client, offer) -> userId | null
 *
 * The Offer carries no approver column; the approver (if the offer went through
 * an approval gate) is the User who APPROVED its ApprovalRequest. Returns the
 * approving user's id, or null when the offer was never formally approved (then
 * the SoD guard falls back to the requisition recruiter — see resolveSodSubject).
 */
async function resolveOfferApproverUserId(client, offer) {
  if (!offer || !offer.approvalRequestId) return null;
  const action = await client.approvalAction.findFirst({
    where: {
      businessId: offer.businessId,
      approvalRequestId: offer.approvalRequestId,
      decision: 'APPROVED',
    },
    orderBy: { actedAt: 'asc' },
    select: { approverUserId: true },
  });
  return action ? action.approverUserId : null;
}

/**
 * resolveSodSubjectUserIds(client, offer) -> Set<userId>
 *
 * The set of users the provisioner must NOT be (separation of duties). The Offer
 * model carries NO createdByUserId/sentByUserId column (grep confirms only
 * approvalRequestId), so the only signal that EXISTS in production is the
 * requisition's recruiter/hiring manager on the linked Job (Job.hiringManagerId,
 * an Employee id → its portal User). We block when the provisioner is:
 *   (a) the offer's APPROVED approver (approval-gate path, if any), OR
 *   (b) the requisition's hiring manager (the person who owns the hire) —
 *       a signal that is set in prod (seedOnboardingJourney already resolves it).
 * Returning a Set (not a single id) so the M1 guard never ships a precondition
 * that is never true. Empty set = no SoD subject resolvable (guard is a no-op).
 */
async function resolveSodSubjectUserIds(client, offer) {
  const out = new Set();
  if (!offer) return out;
  // (a) Approval-gate path (when the offer went through an ApprovalRequest).
  const approverUserId = await resolveOfferApproverUserId(client, offer);
  if (approverUserId) out.add(approverUserId);
  // (b) Requisition recruiter / hiring manager (Job.hiringManagerId is an
  //     Employee id; map it to the portal User so we can compare against
  //     req.user.id). This field is populated in production.
  if (offer.applicationId) {
    const application = await client.application.findFirst({
      where: { id: offer.applicationId, businessId: offer.businessId },
      include: { job: { select: { hiringManagerId: true } } },
    });
    const hiringManagerId = application && application.job ? application.job.hiringManagerId : null;
    if (hiringManagerId) {
      const mgr = await client.employee.findFirst({
        where: { id: hiringManagerId, businessId: offer.businessId },
        select: { userId: true },
      });
      if (mgr && mgr.userId) out.add(mgr.userId);
    }
  }
  return out;
}

// ── component kinds that count toward the India Code-on-Wages "Basic+DA" floor ──
const BASIC_DA_KINDS = new Set(['BASIC', 'DEARNESS_ALLOWANCE']);

/**
 * resolveBasicDaMonthly(client, { offer, businessId, compSplit }) ->
 *   { basicMonthly, daMonthly } | null
 *
 * The AUTHORITATIVE Basic+DA monthly amounts for the 50% wage guard (H1). NEVER
 * defaults Basic to Gross (that fallback makes the guard a no-op). Resolution
 * order, most-authoritative first:
 *   1. The offer's proposed SalaryStructure (offer.structureId) component lines,
 *      summing amountMonthly for components whose kind ∈ {BASIC, DEARNESS_ALLOWANCE}.
 *   2. The staged compensation split (selfServiceJson.comp.basicMonthly/daMonthly),
 *      when HR captured an explicit split for the hire.
 * Returns null when no split is resolvable — the caller FAILS an INR provision
 * (reason 'wage-rule') rather than silently passing Basic==Gross.
 */
async function resolveBasicDaMonthly(client, { offer, businessId, compSplit }) {
  // 1) Authoritative: the proposed structure's component lines.
  if (offer && offer.structureId) {
    const lines = await client.salaryComponentLine.findMany({
      where: { businessId, structureId: offer.structureId },
      include: { component: { select: { kind: true } } },
    });
    if (lines.length) {
      let basic = 0;
      let da = 0;
      let sawBasicDa = false;
      for (const ln of lines) {
        const kind = ln.component && ln.component.kind;
        if (!BASIC_DA_KINDS.has(kind)) continue;
        const amt = ln.amountMonthly != null ? Number(ln.amountMonthly) : null;
        if (amt == null || Number.isNaN(amt)) continue;
        sawBasicDa = true;
        if (kind === 'BASIC') basic += amt;
        else da += amt;
      }
      if (sawBasicDa) return { basicMonthly: String(basic), daMonthly: da ? String(da) : null };
    }
  }
  // 2) Explicit staged split captured by HR on the journey.
  const split = compSplit || {};
  if (split.basicMonthly != null) {
    return { basicMonthly: String(split.basicMonthly), daMonthly: split.daMonthly != null ? String(split.daMonthly) : null };
  }
  return null;
}

/**
 * provisionEmployee({ journeyId, actorId }, prismaOrTx) -> { employee, journey, created }
 *
 * Runs the whole promotion inside ONE `prisma.$transaction` (120s budget). If a
 * live `prisma` client is passed (default), it opens the tx itself; the caller
 * may also pass a tx handle (then we assume it is already inside a transaction —
 * used by tests that want to compose). On any step failure the tx rolls back and
 * we mark task FAILED + journey BLOCKED in a SEPARATE write, then rethrow.
 *
 * Throws ProvisionError:
 *   - { status:409, reason:'already-provisioned', employeeId } when a linked
 *     Employee already exists (idempotent no-op).
 *   - { status:422, reason:'precondition' } when the journey isn't provisionable.
 */
async function provisionEmployee({ journeyId, actorId } = {}, prismaOrTx) {
  if (!journeyId) throw new ProvisionError('journeyId is required', { status: 400, reason: 'bad-request' });
  const prisma = prismaOrTx || livePrisma;

  // The core body — everything below runs inside ONE transaction.
  const run = async (tx) => {
    // ── Row-lock the journey FIRST (serializes concurrent double-submit). The
    //    second caller blocks here until the first commits, then re-reads the
    //    now-linked journey and short-circuits to the 409 idempotency path. ──
    const locked = await tx.$queryRaw`
      SELECT id FROM "LifecycleJourney" WHERE id = ${journeyId} FOR UPDATE
    `;
    if (!locked || locked.length === 0) {
      throw new ProvisionError('Journey not found', { status: 404, reason: 'not-found' });
    }

    const journey = await tx.lifecycleJourney.findUnique({ where: { id: journeyId } });
    if (!journey || journey.deletedAt) {
      throw new ProvisionError('Journey not found', { status: 404, reason: 'not-found' });
    }
    if (journey.direction !== 'ONBOARDING') {
      throw new ProvisionError('Not an onboarding journey', { status: 422, reason: 'precondition' });
    }

    const provisionTask = await findProvisionTask(tx, journeyId);

    // ── IDEMPOTENCY: a linked Employee already exists → 409, do nothing. We
    //    check three independent ledgers (any one is proof of prior success):
    //    journey.employeeId, the PROVISION_EMPLOYEE task DONE w/ a recorded id,
    //    and Application.convertedEmployeeId. ──
    if (journey.employeeId) {
      throw new ProvisionError('Employee already provisioned', {
        status: 409, reason: 'already-provisioned', employeeId: journey.employeeId,
      });
    }
    if (provisionTask && provisionTask.status === 'DONE') {
      const linkedId = provisionTask.resultJson && provisionTask.resultJson.employeeId;
      throw new ProvisionError('Employee already provisioned', {
        status: 409, reason: 'already-provisioned', employeeId: linkedId || null,
      });
    }

    // The accepted Offer is the source of truth (gross/structure/joining date).
    if (!journey.offerId) {
      throw new ProvisionError('Journey has no linked offer', { status: 422, reason: 'precondition' });
    }
    const offer = await tx.offer.findFirst({ where: { id: journey.offerId, businessId: journey.businessId } });
    if (!offer) throw new ProvisionError('Offer not found', { status: 422, reason: 'precondition' });
    if (offer.status !== 'ACCEPTED') {
      throw new ProvisionError(`Offer is not ACCEPTED (status ${offer.status})`, { status: 422, reason: 'precondition' });
    }

    const application = offer.applicationId
      ? await tx.application.findFirst({
          where: { id: offer.applicationId, businessId: journey.businessId },
          include: { job: true },
        })
      : null;
    if (application && application.convertedEmployeeId) {
      throw new ProvisionError('Employee already provisioned', {
        status: 409, reason: 'already-provisioned', employeeId: application.convertedEmployeeId,
      });
    }
    const job = application && application.job ? application.job : null;

    const { businessId } = journey;
    const self = (journey.selfServiceJson && typeof journey.selfServiceJson === 'object') ? journey.selfServiceJson : {};
    const personal = self.personal || {};
    const statutory = self.statutory || {};
    const bank = self.bank || {};

    // Resolve the hiring entity (EmploymentRecord/Compensation require a non-null
    // entityId). Journey → Job → any active entity for the tenant (last resort).
    let entityId = journey.entityId || (job && job.entityId) || null;
    let entity = entityId
      ? await tx.entity.findFirst({ where: { id: entityId, businessId } })
      : await tx.entity.findFirst({ where: { businessId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
    if (!entity) throw new ProvisionError('No entity resolved for the hire', { status: 422, reason: 'precondition' });
    entityId = entity.id;
    const countryCode = (entity.countryCode || (job && job.countryCode) || 'IN').toUpperCase();
    const currencyCode = offer.currencyCode || entity.payCurrency || (countryCode === 'NZ' ? 'NZD' : 'INR');

    // Dates + status. PROBATION when a probation window applies (default 90d for
    // a permanent hire unless the offer/journey says otherwise), else ACTIVE.
    const joinDate = toDateOnly(journey.joinDate || offer.joiningDate) || toDateOnly(new Date());
    const probationDays = Number(
      (self.probationDays != null ? self.probationDays : null)
      ?? (offer.probationDays != null ? offer.probationDays : null)
      ?? 90,
    );
    const employmentType = (job && job.employmentType) || personal.employmentType || 'FULL_TIME';
    // Interns/contractors are not on probation; permanent staff are.
    const onProbation = probationDays > 0 && ['FULL_TIME', 'PART_TIME', 'FIXED_TERM'].includes(employmentType);
    const status = onProbation ? 'PROBATION' : 'ACTIVE';
    const probationEndDate = onProbation ? addDaysDate(joinDate, probationDays) : null;

    // Identity for the portal User / Customer (ESS login).
    const firstName = personal.firstName || (application && application.candidate && application.candidate.firstName) || offer.firstName || 'New';
    const lastName = personal.lastName || (application && application.candidate && application.candidate.lastName) || offer.lastName || 'Hire';
    const email = (personal.workEmail || personal.email || (application && application.candidate && application.candidate.email) || '').trim().toLowerCase() || null;

    // ── PRE-WRITE PRECONDITION: India 50% wage rule (H1). ──
    // Run the Code-on-Wages 50% guard BEFORE creating any row so a breach (or an
    // unresolvable Basic/DA split for an INR hire) is a clean PRE_WRITE failure
    // (reason 'wage-rule') that never half-provisions / never flips the journey to
    // BLOCKED. Basic+DA comes from the AUTHORITATIVE source (offer structure lines,
    // else the staged comp split) — NEVER defaulted to gross.
    const grossMonthly = offer.grossMonthly != null ? String(offer.grossMonthly) : null;
    const compSplit = self.comp || {};
    const isIndiaHire = countryCode === 'IN' || String(currencyCode || '').toUpperCase() === 'INR';
    if (grossMonthly != null && isIndiaHire) {
      const basicDa = await resolveBasicDaMonthly(tx, { offer, businessId, compSplit });
      if (!basicDa) {
        throw new ProvisionError(
          'Cannot validate the India 50% wage rule: no Basic/DA split is resolvable from the offer structure or the staged compensation split.',
          { status: 422, reason: 'wage-rule' },
        );
      }
      const wage = offerWageCheck({
        countryCode,
        currencyCode,
        grossMonthly,
        basicMonthly: basicDa.basicMonthly,
        daMonthly: basicDa.daMonthly,
        joiningDate: joinDate,
      });
      if (!wage.ok) {
        throw new ProvisionError(
          (wage.error && wage.error.message) || 'Offer violates the India 50% wage rule',
          { status: 422, reason: 'wage-rule' },
        );
      }
    }

    // ── PRE-WRITE PRECONDITION: portal email uniqueness (H2). ──
    // User.email is GLOBALLY @unique. Resolve a pre-existing User up-front so a
    // collision is a clean decision, not a P2002 rollback that BLOCKS the journey:
    //   - same tenant + not yet linked to an Employee → REUSE it (link below);
    //   - same tenant + already linked to a DIFFERENT Employee → email-in-use 409;
    //   - a DIFFERENT tenant → email-in-use 409 (PRE_WRITE, journey NOT blocked).
    let reusableUser = null;
    if (email) {
      const existingUser = await tx.user.findUnique({ where: { email } });
      if (existingUser) {
        if (existingUser.businessId !== businessId) {
          throw new ProvisionError(
            'A portal account with this email already exists for another tenant.',
            { status: 409, reason: 'email-in-use' },
          );
        }
        const linkedEmp = await tx.employee.findFirst({
          where: { businessId, userId: existingUser.id, deletedAt: null },
          select: { id: true },
        });
        if (linkedEmp) {
          throw new ProvisionError(
            'A portal account with this email is already linked to another employee.',
            { status: 409, reason: 'email-in-use' },
          );
        }
        reusableUser = existingUser; // same tenant, unlinked → reuse it.
      }
    }

    // ── STEP 1: allocate EMP code + create the Employee (PRE_HIRE → real row). ──
    const code = await allocateCode(tx, { businessId, entityId, scope: 'EMPLOYEE', prefix: 'EMP-', padding: 6 });
    let employee = await tx.employee.create({
      data: {
        businessId, code,
        firstName, lastName,
        middleName: personal.middleName || null,
        preferredName: personal.preferredName || null,
        dateOfBirth: toDateOnly(personal.dateOfBirth),
        gender: personal.gender || undefined,
        maritalStatus: personal.maritalStatus || undefined,
        nationality: personal.nationality || null,
        personalEmail: personal.personalEmail || email,
        workEmail: email,
        phone: personal.phone || null,
        countryCode,
        stateCode: personal.stateCode || entity.stateCode || null,
        city: personal.city || entity.city || null,
        isActive: true,
        status,
        hireDate: joinDate,
        probationEndDate,
        // Manager: the Job's hiring manager (F1 hierarchy anchor). The journey
        // carries no manager column, so the requisition's hiringManagerId — the
        // same anchor the MANAGER-owned tasks resolved to in seedOnboardingJourney
        // — is the source of truth; selfServiceJson.managerEmployeeId can override.
        managerEmployeeId: self.managerEmployeeId || (job && job.hiringManagerId) || null,
        preferredLanguage: personal.preferredLanguage || 'en',
      },
    });

    // ── STEP 2: portal User + Customer (ESS identity) — mirrors seed-hr.js. ──
    // A temp password (the invite flow resets it). Email is required to mint a
    // login; without one we skip the portal identity (HR can add it later).
    let userId = null;
    if (email) {
      const tempPassword = crypto.randomBytes(18).toString('base64url');
      const passwordHash = bcrypt.hashSync(tempPassword, 10);
      const name = `${firstName} ${lastName}`.trim();
      // REUSE a pre-existing same-tenant, unlinked User (resolved pre-write, H2)
      // rather than creating one that would P2002 on the global email @unique and
      // BLOCK the journey. We reset it to the temp invite (the new hire claims it).
      if (reusableUser) {
        await tx.user.update({
          where: { id: reusableUser.id },
          data: { password: passwordHash, name, role: 'USER', businessId, isActive: true },
        });
        userId = reusableUser.id;
      } else {
        const user = await tx.user.create({
          data: {
            email, password: passwordHash, name,
            role: 'USER', businessId,
            emailVerified: false, isActive: true,
          },
        });
        userId = user.id;
      }
      // Customer ESS identity (M2): do NOT blindly upsert/clobber a shared
      // multi-product Customer row. Look it up first; only UPDATE when it is
      // unambiguously THIS employee's ESS identity (same tenant, not anonymised,
      // not already an unrelated principal's login). NEVER auto-clear
      // anonymisedAt during provisioning (re-activation must be explicit).
      const existingCustomer = await tx.customer.findUnique({
        where: { businessId_email: { businessId, email } },
        select: { id: true, anonymisedAt: true },
      });
      if (!existingCustomer) {
        await tx.customer.create({
          data: { businessId, email, password: passwordHash, name, emailVerified: false, isActive: true },
        });
      } else if (existingCustomer.anonymisedAt) {
        // A GDPR-anonymised row — leave it untouched (do NOT un-anonymise here).
        // The new hire gets a portal User login; HR re-activates the Customer
        // explicitly if needed. We intentionally write nothing.
      } else {
        // A live same-tenant ESS identity for this email → refresh the invite
        // credentials only. anonymisedAt is never set/cleared here.
        await tx.customer.update({
          where: { id: existingCustomer.id },
          data: { password: passwordHash, name, isActive: true },
        });
      }
      // Link the portal identity. The Employee.userId @unique is the concurrency
      // backstop: a racing second provision that reused this email aborts here.
      employee = await tx.employee.update({ where: { id: employee.id }, data: { userId } });
    }

    // ── STEP 3 + 5: assign the default employee BusinessRole (F1 SELF band). ──
    // The offer carries no role; we attach the tenant's default employee role
    // (SELF scope) so the new hire's ESS session resolves to themselves only.
    // Managers keep their TEAM role; a regular hire floors at SELF.
    if (userId) {
      const role = await resolveDefaultEmployeeRole(tx, businessId);
      if (role) await tx.user.update({ where: { id: userId }, data: { businessRoleId: role.id } });
    }

    // ── STEP 4: EmploymentRecord (changeReason HIRE, current). ──
    const empRec = await tx.employmentRecord.create({
      data: {
        businessId, employeeId: employee.id, entityId,
        locationId: (job && job.locationId) || null,
        departmentId: (job && job.departmentId) || null,
        designationId: (job && job.designationId) || null,
        gradeId: null,
        managerEmployeeId: employee.managerEmployeeId || null,
        employmentType,
        workerCategory: 'STAFF',
        payCalendarId: null,
        noticeDays: (job && job.noticeDays != null) ? job.noticeDays : null,
        fteRatio: '1.0000',
        effectiveFrom: joinDate,
        changeReason: 'HIRE',
        isCurrent: true,
      },
    });
    employee = await tx.employee.update({
      where: { id: employee.id },
      data: { currentEmploymentRecordId: empRec.id },
    });

    // ── STEP 6: StatutoryProfile from selfServiceJson (best-effort, country-shaped). ──
    const statData = countryCode === 'NZ'
      ? {
          countryCode: 'NZ',
          irdNumber: statutory.irdNumber || null,
          taxCode: statutory.taxCode || 'M',
          kiwiSaverStatus: statutory.kiwiSaverStatus || 'NOT_ENROLLED',
          kiwiSaverEmployeeRate: statutory.kiwiSaverEmployeeRate || null,
        }
      : {
          countryCode: 'IN',
          pan: statutory.pan || null,
          uan: statutory.uan || null,
          pfOptIn: statutory.pfOptIn != null ? !!statutory.pfOptIn : false,
          taxRegime: statutory.taxRegime || 'NEW',
          ptStateCode: statutory.ptStateCode || entity.stateCode || null,
        };
    await tx.statutoryProfile.upsert({
      where: { employeeId: employee.id },
      update: statData,
      create: { businessId, employeeId: employee.id, ...statData },
    });

    // ── STEP 7: primary BankAccount + EmergencyContacts (from staged self-service). ──
    if (bank && (bank.accountNumber || bank.nzBankAccount)) {
      await tx.bankAccount.create({
        data: {
          businessId, employeeId: employee.id,
          accountName: bank.accountName || `${firstName} ${lastName}`.trim(),
          accountNumber: bank.accountNumber || bank.nzBankAccount,
          ifsc: countryCode === 'IN' ? (bank.ifsc || null) : null,
          nzBankAccount: countryCode === 'NZ' ? (bank.nzBankAccount || bank.accountNumber) : null,
          bankName: bank.bankName || null,
          currencyCode, isPrimary: true,
        },
      });
    }
    const emergency = Array.isArray(self.emergency) ? self.emergency : (self.emergency ? [self.emergency] : []);
    for (const ec of emergency) {
      if (!ec || !ec.name || !ec.phone) continue;
      await tx.emergencyContact.create({
        data: {
          businessId, employeeId: employee.id,
          name: ec.name, relationship: ec.relationship || 'OTHER', phone: ec.phone,
          email: ec.email || null, isPrimary: ec.isPrimary === true,
        },
      });
    }

    // ── STEP 8: CompensationRevision (HIRE). The India 50% wage rule was already
    //    validated PRE-WRITE (see the precondition block above), so by here a
    //    breach has already aborted the provision without writing any row. ──
    //
    // Feature 5 BUG FIX: materialize the offer's SalaryStructure into RESOLVED
    // SalaryComponentLine rows on the revision. Previously the revision carried
    // NO lines → resolveCurrentCompensation found none → componentsForEngine=[]
    // → EVERY provisioned hire computed zero gross, and offboarding read Basic+DA=0
    // → gratuity/encashment=0. We derive the breakup from the structure + the
    // offer target (CTC for IN, gross for NZ) and nest the lines in the SAME tx.
    const basis = countryCode === 'IN' ? 'CTC' : 'GROSS';
    let revisionLineCreates = null;
    if (offer.structureId) {
      const structure = await tx.salaryStructure.findFirst({
        where: { id: offer.structureId, businessId },
        include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
      });
      if (structure && Array.isArray(structure.lines) && structure.lines.length) {
        // Target: prefer CTC (IN), else monthly gross (NZ). minor units.
        const target = {};
        if (basis === 'CTC' && offer.ctcAnnual != null) {
          target.ctcAnnualMinor = mtoMinor(offer.ctcAnnual);
        } else if (grossMonthly != null) {
          target.grossMonthlyMinor = mtoMinor(grossMonthly);
        }
        try {
          const { lines: matLines } = materializeRevisionLines(
            { lines: structure.lines, basis },
            {
              target,
              basis,
              countryCode,
              asOf: isoDateOnly(joinDate),
              esiApplicable: false,
            },
          );
          if (matLines.length) {
            revisionLineCreates = matLines.map((l) => ({ ...l, businessId }));
          }
        } catch (err) {
          // A structurally-infeasible structure is a hard provisioning failure
          // (we will not silently write a zero-line revision again).
          throw new ProvisionError(
            `Cannot materialize the offer salary structure: ${err.message}`,
            { status: 422, reason: 'comp-structure' },
          );
        }
      }
    }

    const comp = await tx.compensationRevision.create({
      data: {
        businessId, employeeId: employee.id, entityId,
        structureId: offer.structureId || null,
        currencyCode,
        basis,
        ctcAnnual: offer.ctcAnnual != null ? String(offer.ctcAnnual) : null,
        grossMonthly,
        effectiveFrom: joinDate,
        isCurrent: true,
        revisionReason: 'HIRE',
        status: 'EFFECTIVE',
        ...(revisionLineCreates ? { lines: { create: revisionLineCreates } } : {}),
      },
    });
    employee = await tx.employee.update({
      where: { id: employee.id },
      data: { currentCompensationId: comp.id },
    });

    // ── STEP 10: seed a LeaveBalance per applicable LeaveType (opening 0). ──
    const periodCode = periodCodeFor(joinDate, entity.taxYearStartMonth || 4);
    const leaveTypes = await tx.leaveType.findMany({
      where: {
        businessId, isActive: true, deletedAt: null,
        OR: [{ countryCode: null }, { countryCode }],
      },
    });
    let leaveBalanceCount = 0;
    for (const lt of leaveTypes) {
      await tx.leaveBalance.upsert({
        where: {
          businessId_employeeId_leaveTypeId_periodCode: {
            businessId, employeeId: employee.id, leaveTypeId: lt.id, periodCode,
          },
        },
        update: {},
        create: {
          businessId, employeeId: employee.id, leaveTypeId: lt.id, periodCode,
          unit: lt.unit || 'DAYS',
          opening: '0.0000', accrued: '0.0000', taken: '0.0000', closing: '0.0000',
        },
      });
      leaveBalanceCount += 1;
    }

    // ── STEP 12: close the ATS loop — Application.convertedEmployeeId. ──
    if (application) {
      await tx.application.update({
        where: { id: application.id },
        data: { convertedEmployeeId: employee.id },
      });
    }

    // The id ledger recorded on the task.resultJson (audit + idempotency proof).
    const resultJson = {
      employeeId: employee.id,
      employeeCode: code,
      userId,
      employmentRecordId: empRec.id,
      compensationId: comp.id,
      leaveBalanceCount,
      provisionedAt: new Date().toISOString(),
      provisionedByUserId: actorId || null,
    };

    // ── STEP 13a: bind the journey to the new Employee + mark the task DONE. ──
    if (provisionTask) {
      await tx.lifecycleTask.update({
        where: { id: provisionTask.id },
        data: {
          status: 'DONE',
          completedAt: new Date(),
          completedByUserId: actorId || null,
          resultJson,
          version: { increment: 1 },
        },
      });
    }
    await tx.lifecycleJourney.update({
      where: { id: journey.id },
      data: {
        employeeId: employee.id,
        // INVALIDATE the pre-join magic-link token on provisioning: once the hire
        // is a real Employee with a portal login, the pre-join link must no longer
        // resolve the journey (a replayed token 401s). Null the hash + past expiry.
        preJoinTokenHash: null,
        preJoinTokenExpiresAt: new Date(0),
        version: { increment: 1 },
      },
    });

    // ── STEP 13b: re-run the pure engine to move PROVISIONING → DAY_ONE. ──
    const refreshedJourney = await tx.lifecycleJourney.findUnique({ where: { id: journey.id } });
    const tasks = await tx.lifecycleTask.findMany({ where: { journeyId: journey.id } });
    const advance = advanceJourney(refreshedJourney, tasks);
    if (advance.currentStage !== refreshedJourney.currentStage || advance.status !== refreshedJourney.status) {
      await tx.lifecycleJourney.update({
        where: { id: journey.id },
        data: { currentStage: advance.currentStage, status: advance.status, version: { increment: 1 } },
      });
    }

    return {
      employee,
      journey: { id: journey.id, currentStage: advance.currentStage, status: advance.status },
      resultJson,
      created: true,
    };
  };

  // If the caller already handed us a tx handle, run inline (no nested tx). The
  // FAILED/BLOCKED bookkeeping path is the live-client responsibility, so when a
  // tx handle is supplied we let the error propagate (the caller owns rollback).
  if (prismaOrTx && typeof prismaOrTx.$transaction !== 'function') {
    return run(prismaOrTx);
  }

  try {
    return await prisma.$transaction(run, { timeout: 120000 });
  } catch (err) {
    // Pre-write GUARDS (idempotency 409 / not-found / precondition / bad-request)
    // are detected BEFORE any row is created — they never started a partial
    // provision, so we surface them verbatim and leave the task/journey untouched.
    if (err instanceof ProvisionError && PRE_WRITE_REASONS.has(err.reason)) throw err;

    // Anything else (a DB error mid-write, etc.) threw AFTER provisioning began:
    // the tx has already rolled back (no partial Employee/User/EmploymentRecord/
    // LeaveBalance), and we record the failure in a SEPARATE write so the FAILED
    // task + BLOCKED journey persist (QA §7.1). M3: AWAIT it (it is intentionally
    // its own tx) and log if the bookkeeping itself throws, but always surface the
    // ORIGINAL, actionable error to the controller.
    try {
      await markProvisionFailed(prisma, journeyId, err);
    } catch (markErr) {
      // The BLOCKED-marking itself failed — never swallow it silently.
      console.error('[provision] markProvisionFailed failed for journey', journeyId, markErr && markErr.message ? markErr.message : markErr);
    }
    if (err instanceof ProvisionError) throw err;
    throw new ProvisionError(err && err.message ? err.message : 'Provisioning failed', {
      status: 500, reason: 'provision-failed',
    });
  }
}

// ProvisionError reasons raised by the pre-write guards (idempotency /
// precondition checks that run before any row is created). These must NOT flip
// the task to FAILED or the journey to BLOCKED — nothing was attempted. This
// includes 'wage-rule' (H1 — validated PRE-WRITE) and 'email-in-use' (H2 — the
// portal-email collision resolved PRE-WRITE), so neither flips a journey BLOCKED.
const PRE_WRITE_REASONS = new Set([
  'bad-request', 'not-found', 'precondition', 'already-provisioned', 'wage-rule', 'email-in-use',
]);

/**
 * markProvisionFailed(prisma, journeyId, err) — POST-ROLLBACK bookkeeping.
 * Sets the PROVISION_EMPLOYEE task FAILED and the journey BLOCKED in its own
 * transaction (so it survives even though the provision tx rolled back).
 */
async function markProvisionFailed(prisma, journeyId, err) {
  await prisma.$transaction(async (tx) => {
    const task = await findProvisionTask(tx, journeyId);
    if (task && !['DONE', 'SKIPPED', 'NOT_APPLICABLE'].includes(task.status)) {
      await tx.lifecycleTask.update({
        where: { id: task.id },
        data: {
          status: 'FAILED',
          resultJson: { error: err && err.message ? String(err.message).slice(0, 500) : 'provision failed', failedAt: new Date().toISOString() },
          version: { increment: 1 },
        },
      });
    }
    const journey = await tx.lifecycleJourney.findUnique({ where: { id: journeyId } });
    if (journey && !['COMPLETED', 'CANCELLED', 'RESCINDED', 'NO_SHOW'].includes(journey.status)) {
      await tx.lifecycleJourney.update({
        where: { id: journeyId },
        data: { status: 'BLOCKED', version: { increment: 1 } },
      });
    }
  });
}

/**
 * resolveDefaultEmployeeRole(client, businessId) -> BusinessRole | null
 * The default role for a freshly-provisioned hire: an explicit "Employee" role
 * when the tenant has seeded one. Returns null otherwise — which is SAFE because
 * the portal User is minted with role=USER, and the F1 LEGACY_ROLE_SCOPE already
 * floors a USER at the SELF band (so ESS resolves to themselves only without a
 * custom BusinessRole). We deliberately match on `name` only and never read
 * `BusinessRole.defaultScope`: that column is part of schema.prisma but is not
 * yet present in every migrated DB, and a default-role assignment is a nice-to-
 * have here, not a provisioning blocker.
 */
async function resolveDefaultEmployeeRole(client, businessId) {
  try {
    // Select only the id — a full row would pull BusinessRole.defaultScope, which
    // is absent from some migrated DBs; we only need the id to link the User.
    return (await client.businessRole.findFirst({ where: { businessId, name: 'Employee' }, select: { id: true } })) || null;
  } catch (_e) {
    return null;
  }
}

/**
 * confirmProbation({ employeeId, actorId }, prismaOrTx) — probation → ACTIVE.
 *
 * Writes an EmploymentRecord(changeReason PROBATION_CONFIRM, effective today),
 * flips Employee.status PROBATION→ACTIVE (clearing probationEndDate), and — when
 * the employee has an active onboarding journey at the PROBATION stage — marks
 * the PROBATION_REVIEW task DONE and advances PROBATION → COMPLETED. Atomic.
 * Idempotent: an already-ACTIVE employee is a no-op (returns { changed:false }).
 */
async function confirmProbation({ employeeId, actorId } = {}, prismaOrTx) {
  if (!employeeId) throw new ProvisionError('employeeId is required', { status: 400, reason: 'bad-request' });
  const prisma = prismaOrTx || livePrisma;

  const run = async (tx) => {
    const employee = await tx.employee.findUnique({ where: { id: employeeId } });
    if (!employee || employee.deletedAt) {
      throw new ProvisionError('Employee not found', { status: 404, reason: 'not-found' });
    }
    if (employee.status !== 'PROBATION') {
      // Already confirmed / never on probation → idempotent no-op.
      return { employee, changed: false };
    }

    const effectiveFrom = toDateOnly(new Date());
    // The current employment segment (snapshot terms forward onto the new record).
    const current = employee.currentEmploymentRecordId
      ? await tx.employmentRecord.findUnique({ where: { id: employee.currentEmploymentRecordId } })
      : await tx.employmentRecord.findFirst({ where: { employeeId, isCurrent: true }, orderBy: { effectiveFrom: 'desc' } });

    // Append a PROBATION_CONFIRM record (skip if one already lands on the same day).
    const dup = await tx.employmentRecord.findFirst({
      where: { employeeId, effectiveFrom },
    });
    let newRec = current;
    if (!dup && current) {
      await tx.employmentRecord.updateMany({ where: { employeeId, isCurrent: true }, data: { isCurrent: false, effectiveTo: effectiveFrom } });
      newRec = await tx.employmentRecord.create({
        data: {
          businessId: employee.businessId, employeeId, entityId: current.entityId,
          locationId: current.locationId, departmentId: current.departmentId,
          designationId: current.designationId, gradeId: current.gradeId,
          managerEmployeeId: current.managerEmployeeId,
          employmentType: current.employmentType, workerCategory: current.workerCategory,
          payCalendarId: current.payCalendarId, noticeDays: current.noticeDays,
          fteRatio: current.fteRatio,
          effectiveFrom, changeReason: 'PROBATION_CONFIRM', isCurrent: true,
        },
      });
    }

    const updated = await tx.employee.update({
      where: { id: employeeId },
      data: {
        status: 'ACTIVE',
        probationEndDate: null,
        currentEmploymentRecordId: newRec ? newRec.id : employee.currentEmploymentRecordId,
        version: { increment: 1 },
      },
    });

    // Advance the onboarding journey (PROBATION_REVIEW done → PROBATION → COMPLETED).
    const journey = await tx.lifecycleJourney.findFirst({
      where: { businessId: employee.businessId, employeeId, direction: 'ONBOARDING', deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (journey) {
      const reviewTask = await tx.lifecycleTask.findFirst({
        where: { journeyId: journey.id, taskKey: 'PROBATION_REVIEW' },
      });
      if (reviewTask && !['DONE', 'SKIPPED', 'NOT_APPLICABLE'].includes(reviewTask.status)) {
        await tx.lifecycleTask.update({
          where: { id: reviewTask.id },
          data: { status: 'DONE', completedAt: new Date(), completedByUserId: actorId || null, version: { increment: 1 } },
        });
      }
      const tasks = await tx.lifecycleTask.findMany({ where: { journeyId: journey.id } });
      const advance = advanceJourney(journey, tasks);
      if (advance.currentStage !== journey.currentStage || advance.status !== journey.status) {
        await tx.lifecycleJourney.update({
          where: { id: journey.id },
          data: { currentStage: advance.currentStage, status: advance.status, version: { increment: 1 } },
        });
      }
    }

    return { employee: updated, changed: true };
  };

  if (prismaOrTx && typeof prismaOrTx.$transaction !== 'function') return run(prismaOrTx);
  return prisma.$transaction(run, { timeout: 60000 });
}

/**
 * dueProbations(prisma, businessId, { asOf } = {}) — employees whose probation
 * window is at/over T-15 (a small query the cron can drive; §4.2). Returns the
 * employees still in PROBATION with probationEndDate within 15 days of `asOf`.
 */
async function dueProbations(prisma, businessId, { asOf = new Date(), withinDays = 15 } = {}) {
  const horizon = addDaysDate(toDateOnly(asOf), withinDays);
  return prisma.employee.findMany({
    where: {
      businessId, status: 'PROBATION', deletedAt: null,
      probationEndDate: { not: null, lte: horizon },
    },
    select: { id: true, code: true, firstName: true, lastName: true, probationEndDate: true, managerEmployeeId: true },
    orderBy: { probationEndDate: 'asc' },
  });
}

module.exports = {
  provisionEmployee,
  confirmProbation,
  dueProbations,
  resolveOfferApproverUserId,
  resolveSodSubjectUserIds,
  markProvisionFailed,
  ProvisionError,
  // exported for unit tests
  _internals: { toDateOnly, periodCodeFor, resolveDefaultEmployeeRole, resolveBasicDaMonthly },
};
