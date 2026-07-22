'use strict';

/**
 * awards.service.js — Feature 35 §4.4. Nomination-based awards:
 * cycle (window + committee + prize) → nominations → shortlist → committee decides
 * (one F10 AWARD request per shortlisted nominee) → WON: points + F9 certificate +
 * celebratory feed post.
 *
 * Committee routing: the committee is PER-CYCLE (AwardCycle.committeeUserIds), which
 * a static BUILT_IN_DEFAULT chain cannot express. After engine.openRequest we PIN the
 * committee as the request's active parallel level (payloadJson._active:
 * approverUserIds = committee minus the nominee's own user, minApprovals = all-of).
 * recordDecision reads exactly that set, and the engine's SoD guard independently
 * blocks the requester (we open the request AS the nominee) — so a committee member
 * who IS the nominee can never approve their own windfall. A cycle with NO committee
 * falls through to the AWARD built-in fallback (HR).
 */

const prismaDefault = require('../../core/lib/prisma');
const engine = require('../approvals/engine');
const { issueAwardCertificate } = require('./certificate');
const { notifyHrEvent } = require('../integrations/notifications');

function err(msg) { return { error: msg }; }
function isoDate(v) { return !Number.isNaN(Date.parse(v)); }
function fullName(emp) { return emp ? ([emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.code || 'A colleague') : 'A colleague'; }
function emailOf(emp) { return emp ? (emp.workEmail || emp.personalEmail || null) : null; }

// ── cycle CRUD (operator) ────────────────────────────────────────────────────
function validateCycle(input = {}, { partial = false } = {}) {
  if (!partial) {
    if (!input.name || !String(input.name).trim()) return err('name is required');
    if (!input.awardType || !String(input.awardType).trim()) return err('awardType is required');
    if (!input.nominateOpenAt || !isoDate(input.nominateOpenAt)) return err('nominateOpenAt must be a valid ISO date');
    if (!input.nominateCloseAt || !isoDate(input.nominateCloseAt)) return err('nominateCloseAt must be a valid ISO date');
  }
  for (const k of ['nominateOpenAt', 'nominateCloseAt']) {
    if (partial && input[k] != null && !isoDate(input[k])) return err(`${k} must be a valid ISO date`);
  }
  if (input.nominateOpenAt && input.nominateCloseAt
    && Date.parse(input.nominateCloseAt) <= Date.parse(input.nominateOpenAt)) {
    return err('nominateCloseAt must be after nominateOpenAt');
  }
  if (input.pointsToWinner != null && (!Number.isInteger(input.pointsToWinner) || input.pointsToWinner < 0)) {
    return err('pointsToWinner must be a non-negative integer');
  }
  if (input.maxWinners != null && (!Number.isInteger(input.maxWinners) || input.maxWinners < 1)) {
    return err('maxWinners must be a positive integer');
  }
  if (input.committeeUserIds != null && !Array.isArray(input.committeeUserIds)) {
    return err('committeeUserIds must be an array of user ids');
  }
  return { ok: true };
}

async function tenantUserIds(businessId, userIds) {
  const ids = [...new Set((userIds || []).filter((x) => typeof x === 'string' && x))];
  if (!ids.length) return [];
  const users = await prismaDefault.user.findMany({
    where: { businessId, id: { in: ids }, isActive: true },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

async function createCycle({ businessId, actorUserId, input }) {
  const v = validateCycle(input);
  if (v.error) return v;
  const committee = await tenantUserIds(businessId, input.committeeUserIds);
  const cycle = await prismaDefault.awardCycle.create({
    data: {
      businessId,
      name: String(input.name).trim().slice(0, 200),
      awardType: String(input.awardType).trim().slice(0, 60),
      periodLabel: input.periodLabel ? String(input.periodLabel).trim().slice(0, 60) : null,
      nominateOpenAt: new Date(input.nominateOpenAt),
      nominateCloseAt: new Date(input.nominateCloseAt),
      pointsToWinner: Number.isInteger(input.pointsToWinner) ? input.pointsToWinner : 0,
      maxWinners: Number.isInteger(input.maxWinners) ? input.maxWinners : 1,
      issueCertificate: input.issueCertificate !== false,
      committeeUserIds: committee,
      createdByUserId: actorUserId || null,
    },
  });
  return { cycle };
}

async function updateCycle({ businessId, id, input }) {
  const existing = await prismaDefault.awardCycle.findFirst({ where: { id, businessId } });
  if (!existing) return { notFound: true };
  if (existing.status === 'DECIDED' || existing.status === 'ARCHIVED') {
    return { conflict: 'CYCLE_LOCKED', message: `A ${existing.status} cycle cannot be edited` };
  }
  const v = validateCycle(input, { partial: true });
  if (v.error) return v;
  const data = {};
  if (input.name != null) data.name = String(input.name).trim().slice(0, 200);
  if (input.awardType != null) data.awardType = String(input.awardType).trim().slice(0, 60);
  if (input.periodLabel !== undefined) data.periodLabel = input.periodLabel ? String(input.periodLabel).trim().slice(0, 60) : null;
  if (input.nominateOpenAt != null) data.nominateOpenAt = new Date(input.nominateOpenAt);
  if (input.nominateCloseAt != null) data.nominateCloseAt = new Date(input.nominateCloseAt);
  if (input.pointsToWinner != null) data.pointsToWinner = input.pointsToWinner;
  if (input.maxWinners != null) data.maxWinners = input.maxWinners;
  if (input.issueCertificate != null) data.issueCertificate = !!input.issueCertificate;
  if (input.committeeUserIds != null) data.committeeUserIds = await tenantUserIds(businessId, input.committeeUserIds);
  const cycle = await prismaDefault.awardCycle.update({ where: { id: existing.id }, data });
  return { cycle };
}

async function adminListCycles({ businessId, status, page = 1, pageSize = 25 }) {
  const where = { businessId };
  if (status && ['OPEN', 'CLOSED', 'DECIDED', 'ARCHIVED'].includes(status)) where.status = status;
  const take = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const [items, total] = await Promise.all([
    prismaDefault.awardCycle.findMany({
      where,
      include: { _count: { select: { nominations: true } } },
      orderBy: { createdAt: 'desc' },
      skip, take,
    }),
    prismaDefault.awardCycle.count({ where }),
  ]);
  return { items, total, page: Math.max(1, Number(page) || 1), pageSize: take };
}

const NOMINATION_INCLUDE = {
  nominator: { select: { id: true, code: true, firstName: true, lastName: true } },
  nominee: { select: { id: true, code: true, firstName: true, lastName: true } },
};

async function getCycle({ businessId, id }) {
  const cycle = await prismaDefault.awardCycle.findFirst({
    where: { id, businessId },
    include: { nominations: { include: NOMINATION_INCLUDE, orderBy: { createdAt: 'asc' } } },
  });
  if (!cycle) return { notFound: true };
  return { cycle };
}

/** Manual close (HR) — same conditional flip the lifecycle cron uses. */
async function closeCycle({ businessId, id }) {
  const flip = await prismaDefault.awardCycle.updateMany({
    where: { id, businessId, status: 'OPEN' },
    data: { status: 'CLOSED' },
  });
  if (flip.count === 0) {
    const exists = await prismaDefault.awardCycle.findFirst({ where: { id, businessId }, select: { status: true } });
    if (!exists) return { notFound: true };
    return { conflict: 'NOT_OPEN', message: `Cycle is ${exists.status}, not OPEN` };
  }
  return { closed: true };
}

/** Shortlist toggle: SUBMITTED ↔ SHORTLISTED (only while the cycle is undecided). */
async function shortlistNomination({ businessId, cycleId, nominationId, on = true }) {
  const cycle = await prismaDefault.awardCycle.findFirst({ where: { id: cycleId, businessId }, select: { status: true } });
  if (!cycle) return { notFound: true };
  if (cycle.status === 'DECIDED' || cycle.status === 'ARCHIVED') {
    return { conflict: 'CYCLE_LOCKED', message: 'This cycle has already been decided' };
  }
  const from = on ? 'SUBMITTED' : 'SHORTLISTED';
  const to = on ? 'SHORTLISTED' : 'SUBMITTED';
  const flip = await prismaDefault.awardNomination.updateMany({
    where: { id: nominationId, businessId, cycleId, status: from },
    data: { status: to },
  });
  if (flip.count === 0) {
    const nom = await prismaDefault.awardNomination.findFirst({ where: { id: nominationId, businessId, cycleId }, select: { status: true } });
    if (!nom) return { notFound: true };
    return { conflict: 'BAD_STATE', message: `Nomination is ${nom.status}, expected ${from}` };
  }
  return { shortlisted: on };
}

// ── decide: open one F10 AWARD request per shortlisted nominee ───────────────
/**
 * decideCycle({ businessId, actorUserId, id, nominationIds? }) — routes each
 * SHORTLISTED nomination (or the named subset) to the committee. Winner count is
 * capped at cycle.maxWinners. Non-selected shortlisted nominations (outside the
 * chosen subset) stay SHORTLISTED until the committee resolves the chosen ones.
 */
async function decideCycle({ businessId, actorUserId, id, nominationIds }) {
  const cycle = await prismaDefault.awardCycle.findFirst({ where: { id, businessId } });
  if (!cycle) return { notFound: true };
  if (cycle.status !== 'CLOSED') {
    return { conflict: 'NOT_CLOSED', message: `Close nominations first (cycle is ${cycle.status})` };
  }
  const where = {
    businessId,
    cycleId: cycle.id,
    status: 'SHORTLISTED',
    approvalRequestId: null,
    ...(Array.isArray(nominationIds) && nominationIds.length ? { id: { in: nominationIds } } : {}),
  };
  const shortlisted = await prismaDefault.awardNomination.findMany({
    where,
    include: { nominee: { select: { id: true, userId: true, firstName: true, lastName: true, code: true } } },
    orderBy: { createdAt: 'asc' },
    take: Math.max(1, cycle.maxWinners),
  });
  if (!shortlisted.length) return { error: 'No shortlisted nominations to decide (shortlist first)' };

  const opened = [];
  for (const nom of shortlisted) {
    // One tx per nomination so a single failure doesn't strand the batch.
    const result = await prismaDefault.$transaction(async (tx) => {
      const r = await engine.openRequest({
        businessId,
        module: 'AWARD',
        entityType: 'AwardNomination',
        entityId: nom.id,
        // Requester = the NOMINEE: the engine's SoD then hard-blocks the nominee's
        // own user from deciding, whatever the resolved approver set says.
        requesterEmployeeId: nom.nomineeEmployeeId,
        payload: {
          cycleId: cycle.id,
          cycleName: cycle.name,
          awardType: cycle.awardType,
          pointsToWinner: cycle.pointsToWinner,
          nomineeName: fullName(nom.nominee),
          citationPreview: (nom.citation || '').slice(0, 140),
        },
        ctx: { cycleId: cycle.id },
      }, tx);

      await tx.awardNomination.updateMany({
        where: { id: nom.id },
        data: { approvalRequestId: r.approvalRequest.id },
      });

      // Pin the per-cycle committee as the active parallel level (all-of).
      if (!r.terminal) {
        await pinCommitteeLevel(tx, {
          businessId,
          approvalRequestId: r.approvalRequest.id,
          committeeUserIds: cycle.committeeUserIds || [],
          excludeUserId: nom.nominee ? nom.nominee.userId : null,
        });
      }
      return r;
    });
    opened.push({ nominationId: nom.id, approvalRequestId: result.approvalRequest.id, terminal: result.terminal });
  }
  return { opened, actorUserId };
}

/**
 * Pin committeeUserIds as the request's active approver set (parallel all-of level).
 * No-ops when the committee (minus the nominee) is empty — the built-in fallback
 * chain (HR) then governs. Writes in-app "approval needed" rows for the committee.
 */
async function pinCommitteeLevel(tx, { businessId, approvalRequestId, committeeUserIds, excludeUserId }) {
  const committee = [...new Set((committeeUserIds || []).filter((u) => u && u !== excludeUserId))];
  if (!committee.length) return false;
  const request = await tx.approvalRequest.findFirst({ where: { id: approvalRequestId, businessId } });
  if (!request || request.status !== 'PENDING') return false;
  const payload = { ...(request.payloadJson || {}) };
  payload._active = {
    ...(payload._active || {}),
    stepOrder: request.currentStepOrder,
    approverUserIds: committee,
    minApprovals: committee.length, // parallel "all-of" committee level (spec §4.4)
    delegationMap: {},
    escalationReason: 'COMMITTEE_PINNED',
  };
  const flip = await tx.approvalRequest.updateMany({
    where: { id: request.id, version: request.version, status: 'PENDING' },
    data: { payloadJson: payload, version: { increment: 1 } },
  });
  if (flip.count === 0) return false;
  for (const uid of committee) {
    try {
      await tx.notification.create({
        data: {
          businessId,
          recipientUserId: uid,
          type: 'APPROVAL_PENDING',
          channel: 'IN_APP',
          title: 'Award committee review',
          body: 'An award nomination is awaiting your committee decision.',
          entityType: 'ApprovalRequest',
          entityId: request.id,
          dataJson: { module: 'AWARD', approvalRequestId: request.id },
        },
      });
    } catch (_e) { /* best-effort */ }
  }
  return true;
}

// ── ESS surfaces ─────────────────────────────────────────────────────────────
/** Open cycles an employee can nominate into (window contains now). */
async function listOpenCycles({ businessId, now = new Date() }) {
  return prismaDefault.awardCycle.findMany({
    where: { businessId, status: 'OPEN', nominateOpenAt: { lte: now }, nominateCloseAt: { gt: now } },
    select: {
      id: true, name: true, awardType: true, periodLabel: true,
      nominateOpenAt: true, nominateCloseAt: true, pointsToWinner: true,
      maxWinners: true, issueCertificate: true,
    },
    orderBy: { nominateCloseAt: 'asc' },
  });
}

/** ESS nominate — window-open + nominee-active + no-self + one-per-pair guards. */
async function nominate({ businessId, nominator, input = {}, now = new Date() }) {
  const cycleId = String(input.cycleId || '');
  const nomineeId = String(input.nomineeEmployeeId || '');
  const citation = String(input.citation || '').trim();
  if (!cycleId) return err('cycleId is required');
  if (!nomineeId) return err('nomineeEmployeeId is required');
  if (!citation) return err('citation is required — say why they deserve it');
  if (nomineeId === nominator.id) return err('You cannot nominate yourself');

  const cycle = await prismaDefault.awardCycle.findFirst({ where: { id: cycleId, businessId } });
  if (!cycle) return { notFound: true };
  if (cycle.status !== 'OPEN' || cycle.nominateOpenAt > now || cycle.nominateCloseAt <= now) {
    return { conflict: 'WINDOW_CLOSED', message: 'Nominations are not open for this award' };
  }
  const nominee = await prismaDefault.employee.findFirst({
    where: { id: nomineeId, businessId, deletedAt: null, isActive: true, status: { notIn: ['TERMINATED', 'RETIRED'] } },
    select: { id: true },
  });
  if (!nominee) return err('The nominee is not an active employee of this company');

  let valueId = null;
  if (input.valueId) {
    const v = await prismaDefault.recognitionValue.findFirst({ where: { id: String(input.valueId), businessId, isActive: true }, select: { id: true } });
    if (v) valueId = v.id;
  }

  try {
    const nomination = await prismaDefault.awardNomination.create({
      data: {
        businessId,
        cycleId: cycle.id,
        nominatorEmployeeId: nominator.id,
        nomineeEmployeeId: nominee.id,
        citation: citation.slice(0, 4000),
        valueId,
      },
      include: NOMINATION_INCLUDE,
    });
    notifyNominationSubmitted(nomination, cycle).catch(() => {});
    return { nomination };
  } catch (e) {
    if (e && e.code === 'P2002') {
      return { conflict: 'ALREADY_NOMINATED', message: 'You have already nominated this colleague for this award' };
    }
    throw e;
  }
}

async function notifyNominationSubmitted(nomination, cycle) {
  const nominator = await prismaDefault.employee.findFirst({
    where: { id: nomination.nominatorEmployeeId, businessId: nomination.businessId },
    select: { firstName: true, workEmail: true, personalEmail: true },
  });
  const email = emailOf(nominator);
  if (!email) return;
  await notifyHrEvent({
    businessId: nomination.businessId,
    event: 'award.nomination-submitted',
    recipientEmail: email,
    variables: {
      NAME: (nominator && nominator.firstName) || 'there',
      NOMINEE: fullName(nomination.nominee),
      AWARD: cycle.name,
      CLOSES: new Date(cycle.nominateCloseAt).toISOString().slice(0, 10),
      BIZ: '',
    },
    triggeredBy: `HR_AWARD_NOM:${nomination.id}`,
  });
}

/** ESS "my nominations" — made by me + (post-decision) won by me. */
async function listMyNominations({ businessId, employeeId }) {
  const made = await prismaDefault.awardNomination.findMany({
    where: { businessId, nominatorEmployeeId: employeeId },
    include: { cycle: { select: { id: true, name: true, awardType: true, periodLabel: true, status: true } }, ...NOMINATION_INCLUDE },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const won = await prismaDefault.awardNomination.findMany({
    where: { businessId, nomineeEmployeeId: employeeId, status: 'WON' },
    include: { cycle: { select: { id: true, name: true, awardType: true, periodLabel: true, status: true } }, ...NOMINATION_INCLUDE },
    orderBy: { decidedAt: 'desc' },
    take: 100,
  });
  return { made, won };
}

// ── winner side-effects (idempotent catch-up, used by consumer + cron) ───────
/**
 * Issue the certificate for any WON nomination that still lacks one (and whose
 * cycle wants one). Fail-soft per row. Returns the number issued.
 */
async function issueMissingCertificates({ businessId = null, limit = 25 } = {}) {
  const where = {
    status: 'WON',
    certificateLetterId: null,
    cycle: { issueCertificate: true },
    ...(businessId ? { businessId } : {}),
  };
  const rows = await prismaDefault.awardNomination.findMany({
    where,
    include: { cycle: true },
    take: limit,
  });
  let issued = 0;
  for (const nom of rows) {
    try {
      const r = await issueAwardCertificate({ nomination: nom, cycle: nom.cycle });
      if (r) issued += 1;
    } catch (e) {
      console.error('[awards] certificate issue failed for nomination', nom.id, e.message);
    }
  }
  return issued;
}

module.exports = {
  validateCycle,
  createCycle,
  updateCycle,
  adminListCycles,
  getCycle,
  closeCycle,
  shortlistNomination,
  decideCycle,
  pinCommitteeLevel,
  listOpenCycles,
  nominate,
  listMyNominations,
  issueMissingCertificates,
};
