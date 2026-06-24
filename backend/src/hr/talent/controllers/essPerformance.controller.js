'use strict';
// essPerformance.controller.js — Feature 8 §6.3: the EMPLOYEE self-service surface,
// mounted at /api/hr/ess/performance. SELF-ONLY by construction (mirror of
// meSeparation): there is NO `:employeeId` in any path. The subject is resolved
// ENTIRELY from the CUSTOMER session (workEmail/personalEmail/linked User), so a
// body/query employeeId is structurally ignored and a cross-employee read/write is
// impossible. Cross-tenant is blocked by businessId on every where.
//
// Confidentiality (§5.8): the released-rating screen is gated on releasedAt — the
// API RETURNS finalRating:null/managerComments:null pre-release (never client-hidden).
// Peer feedback the employee gives about others is never readable back to them; the
// requester sees only status.
const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');
const { evaluate } = require('../performance/reviewStateMachine');
const { objectiveProgress, num } = require('../performance/goalRollup');
const { serializeReviewInstance } = require('../performance/serializers');
const { competencyGap, COMPETENCY_SECTION } = require('../performance/competencyRollup');

const STALE_MSG = 'This record was updated elsewhere — reload and try again';
const SEPARATED = new Set(['TERMINATED', 'RETIRED']);
function isSeparated(emp) {
  if (!emp) return false;
  if (emp.isActive === false) return true;
  return SEPARATED.has(emp.status);
}

// Resolve the session customer's own Employee. Mirror of meSeparation.resolveSelfEmployee.
async function resolveSelf(businessId, customer) {
  if (!customer || !customer.email) return null;
  const select = { id: true, code: true, firstName: true, lastName: true, managerEmployeeId: true, status: true, isActive: true, hireDate: true, userId: true, workEmail: true, personalEmail: true };
  const byEmail = await prisma.employee.findFirst({ where: { businessId, deletedAt: null, OR: [{ workEmail: customer.email }, { personalEmail: customer.email }] }, select });
  if (byEmail) return byEmail;
  return prisma.employee.findFirst({ where: { businessId, deletedAt: null, user: { is: { email: customer.email } } }, select });
}

// Middleware-ish helper: load self or 404, and block separated-employee writes.
async function withSelf(req, res, { writeGuard = false } = {}) {
  const { businessId } = req.customer;
  const employee = await resolveSelf(businessId, req.customer);
  if (!employee) { res.status(404).json({ message: 'No employee record is linked to your account' }); return null; }
  if (writeGuard && isSeparated(employee)) { res.status(403).json({ message: 'Your account is no longer active; this action is unavailable', reason: 'separated' }); return null; }
  return { businessId, employee };
}

// GET /ess/performance/overview — hub payload.
async function overview(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    // Newest active cycle the employee has an instance in.
    const review = await prisma.performanceReview.findFirst({
      where: { businessId, employeeId: employee.id }, orderBy: { createdAt: 'desc' },
      include: { reviewCycle: { select: { id: true, name: true, status: true, releasedAt: true } } },
    });
    const objectives = await prisma.objective.findMany({ where: { businessId, ownerEmployeeId: employee.id }, include: { keyResults: true } });
    let onTrack = 0;
    for (const o of objectives) { if (num(objectiveProgress(o.keyResults)) >= 70) onTrack += 1; }
    const pendingFeedback = await prisma.peerFeedbackRequest.count({ where: { businessId, raterEmployeeId: employee.id, status: 'REQUESTED' } });
    const ratingReleased = !!(review && review.releasedAt);
    return res.json({
      cycle: review ? review.reviewCycle : null,
      myReviewStatus: review ? review.status : null,
      goalStats: { total: objectives.length, onTrack },
      pendingFeedback,
      ratingReleased,
    });
  } catch (e) { return next(e); }
}

// GET /ess/performance/goals — own objectives only.
async function listGoals(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const items = await prisma.objective.findMany({ where: { businessId: ctx.businessId, ownerEmployeeId: ctx.employee.id }, include: { keyResults: true }, orderBy: { createdAt: 'desc' } });
    return res.json({ items });
  } catch (e) { return next(e); }
}

// POST /ess/performance/goals — create own objective (self-owned only).
async function createGoal(req, res, next) {
  try {
    const ctx = await withSelf(req, res, { writeGuard: true }); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const { title, level, weight, dueDate } = req.body;
    if (!title || !level || weight === undefined || !dueDate) return res.status(400).json({ message: 'title, level, weight, dueDate are required' });
    const item = await prisma.objective.create({
      data: {
        businessId, ownerEmployeeId: employee.id, level, title,
        description: req.body.description || null, category: req.body.category || 'INDIVIDUAL',
        weight, dueDate: new Date(dueDate), startDate: req.body.startDate ? new Date(req.body.startDate) : null,
        cycleId: req.body.cycleId || null, visibility: req.body.visibility || 'PUBLIC', status: 'DRAFT',
      },
    });
    return res.status(201).json(item);
  } catch (e) { return next(e); }
}

// POST /ess/performance/goals/:id/key-results — KR on an OWN objective (id guarded).
async function createKeyResult(req, res, next) {
  try {
    const ctx = await withSelf(req, res, { writeGuard: true }); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const obj = await prisma.objective.findFirst({ where: { id: req.params.id, businessId, ownerEmployeeId: employee.id } });
    if (!obj) return res.status(404).json({ message: 'Not found' }); // cross-owner id → 404
    const { title, metricType, startValue, targetValue, weight } = req.body;
    if (!title || !metricType || startValue === undefined || targetValue === undefined || weight === undefined) {
      return res.status(400).json({ message: 'title, metricType, startValue, targetValue, weight are required' });
    }
    const kr = await prisma.keyResult.create({
      data: { businessId, objectiveId: obj.id, title, metricType, startValue, targetValue, currentValue: req.body.currentValue !== undefined ? req.body.currentValue : startValue, unit: req.body.unit || null, direction: req.body.direction || 'INCREASE', weight, confidence: req.body.confidence || 'ON_TRACK', status: 'ACTIVE' },
    });
    return res.status(201).json(kr);
  } catch (e) { return next(e); }
}

// POST /ess/performance/key-results/:id/check-ins — own KR only (cross-owner → 404).
async function createCheckIn(req, res, next) {
  try {
    const ctx = await withSelf(req, res, { writeGuard: true }); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const kr = await prisma.keyResult.findFirst({ where: { id: req.params.id, businessId, objective: { ownerEmployeeId: employee.id } }, include: { objective: { select: { id: true } } } });
    if (!kr) return res.status(404).json({ message: 'Not found' });
    if (req.body.newValue === undefined) return res.status(400).json({ message: 'newValue is required' });
    try {
      const out = await prisma.$transaction(async (tx) => {
        const checkIn = await tx.goalCheckIn.create({ data: { businessId, keyResultId: kr.id, authorEmployeeId: employee.id, previousValue: kr.currentValue, newValue: req.body.newValue, confidence: req.body.confidence || kr.confidence, note: req.body.note || null } });
        // Optimistic lock: guard on the version we read. A concurrent check-in that
        // already moved currentValue bumps the version → count===0 → rollback + 409
        // (no lost update / clobber). Mirror of the operator okr.createCheckIn path.
        const moved = await tx.keyResult.updateMany({ where: { id: kr.id, version: kr.version }, data: { currentValue: req.body.newValue, confidence: req.body.confidence || kr.confidence, version: { increment: 1 } } });
        if (moved.count === 0) { const err = new Error(STALE_MSG); err.stale = true; throw err; }
        const fresh = await tx.objective.findUnique({ where: { id: kr.objective.id }, include: { keyResults: true } });
        await tx.objective.update({ where: { id: kr.objective.id }, data: { progress: objectiveProgress(fresh.keyResults) } });
        return checkIn;
      });
      return res.status(201).json(out);
    } catch (e) {
      if (e && e.stale) return res.status(409).json({ message: STALE_MSG });
      throw e;
    }
  } catch (e) { return next(e); }
}

// GET /ess/performance/review — own review instance, RELEASE-GATED serialization.
async function getReview(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const review = await prisma.performanceReview.findFirst({ where: { businessId, employeeId: employee.id }, orderBy: { createdAt: 'desc' } });
    if (!review) return res.json({ review: null });
    // SELF viewer → pre-release finalRating/managerComments are ABSENT (not hidden).
    return res.json({ review: serializeReviewInstance(review, 'SELF') });
  } catch (e) { return next(e); }
}

// POST /ess/performance/review/self — submit own self-review (locks after submit).
async function submitSelf(req, res, next) {
  try {
    const ctx = await withSelf(req, res, { writeGuard: true }); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const review = await prisma.performanceReview.findFirst({ where: { businessId, employeeId: employee.id }, orderBy: { createdAt: 'desc' } });
    if (!review) return res.status(404).json({ message: 'No review to submit' });
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: review.reviewCycleId, businessId }, select: { status: true, ratingScaleJson: true } });
    const verdict = evaluate('submitSelf', review.status, {
      actorEmployeeId: employee.id, subjectEmployeeId: review.employeeId, reviewerEmployeeId: review.reviewerId,
      selfRequired: true, cycleStatus: cycle && cycle.status,
    });
    if (!verdict.ok) return res.status(verdict.code).json({ message: verdict.message });
    const data = { status: verdict.to, submittedAt: new Date() };
    if (req.body.selfRating !== undefined) data.selfRating = req.body.selfRating;
    if (req.body.selfComments !== undefined) data.selfComments = req.body.selfComments;
    // Optimistic lock (409 on a re-submit racing concurrent write).
    const r = await prisma.performanceReview.updateMany({ where: { id: review.id, version: review.version, status: 'NOT_STARTED' }, data: { ...data, version: { increment: 1 } } });
    if (r.count === 0) return res.status(409).json({ message: 'Self-review already submitted or updated elsewhere' });
    const updated = await prisma.performanceReview.findUnique({ where: { id: review.id } });
    await writeAudit({ businessId, actorId: review.id, action: 'review.transition', entityType: 'PerformanceReview', entityId: review.id, meta: { event: 'submitSelf', from: 'NOT_STARTED', to: updated.status, ess: true } });
    return res.json(serializeReviewInstance(updated, 'SELF'));
  } catch (e) { return next(e); }
}

// POST /ess/performance/review/acknowledge — acknowledge (only when released).
async function acknowledge(req, res, next) {
  try {
    const ctx = await withSelf(req, res, { writeGuard: true }); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const review = await prisma.performanceReview.findFirst({ where: { businessId, employeeId: employee.id }, orderBy: { createdAt: 'desc' } });
    if (!review) return res.status(404).json({ message: 'No review to acknowledge' });
    const verdict = evaluate('acknowledge', review.status, { actorEmployeeId: employee.id, subjectEmployeeId: review.employeeId, released: !!review.releasedAt });
    if (!verdict.ok) return res.status(verdict.code).json({ message: verdict.message });
    const data = { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() };
    if (req.body.rebuttalNote !== undefined) data.rebuttalNote = req.body.rebuttalNote;
    const r = await prisma.performanceReview.updateMany({ where: { id: review.id, version: review.version, status: 'CALIBRATED' }, data: { ...data, version: { increment: 1 } } });
    if (r.count === 0) return res.status(409).json({ message: 'Already acknowledged or updated elsewhere' });
    const updated = await prisma.performanceReview.findUnique({ where: { id: review.id } });
    return res.json(serializeReviewInstance(updated, 'SELF'));
  } catch (e) { return next(e); }
}

// GET /ess/performance/development — Feature 34 §6.4: the EMPLOYEE development surface,
// READ-ONLY and confidentiality-gated. The subject sees ONLY their own competency
// expected-vs-actual gaps + an overall competency score, and the manager-authored IDP
// note ONLY when the manager shared it (placement.sharedWithSubject). The subject
// NEVER sees their box, potential rating/band, talent tags, or successor status — none
// of those are queried here, so they cannot leak (mirror of the §5.8 serializer; the
// 9-box payload simply never reaches this self-only surface).
//
// Release-gated like the rating screen: the gaps are computed from the subject's OWN
// review, and only once that review is RELEASED (this shows their assessed competencies
// the same moment they learn their rating). Pre-release → an empty, "not yet" payload.
async function development(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    // The subject's latest review instance + its cycle (for the release gate + role map).
    const review = await prisma.performanceReview.findFirst({
      where: { businessId, employeeId: employee.id }, orderBy: { createdAt: 'desc' },
      include: { reviewCycle: { select: { id: true, name: true, releasedAt: true } } },
    });
    const released = !!(review && review.releasedAt);
    if (!review || !released) {
      // Pre-release: never expose competency assessments early (same gate as the rating).
      return res.json({ released: false, cycle: review ? review.reviewCycle : null, gaps: [], scorePct: null, idpNote: null });
    }
    // Role map for the subject — role data (designation/grade) lives on the CURRENT
    // EmploymentRecord; 'ALL' always applies for org-wide competencies.
    const roleKeys = ['ALL'];
    const empRec = await prisma.employee.findFirst({ where: { id: employee.id, businessId }, select: { currentEmploymentRecordId: true } });
    if (empRec && empRec.currentEmploymentRecordId) {
      const rec = await prisma.employmentRecord.findFirst({ where: { id: empRec.currentEmploymentRecordId, businessId }, select: { designationId: true, gradeId: true } });
      if (rec && rec.designationId) roleKeys.push(rec.designationId);
      if (rec && rec.gradeId) roleKeys.push(rec.gradeId);
    }
    const roleMaps = await prisma.roleCompetency.findMany({ where: { businessId, roleKey: { in: roleKeys } } });
    let rollup = { gaps: [], mappedCount: 0, ratedMappedCount: 0, scorePct: null };
    if (roleMaps.length) {
      const competencyIds = [...new Set(roleMaps.map((m) => m.competencyId))];
      const comps = await prisma.competency.findMany({ where: { businessId, id: { in: competencyIds } }, select: { id: true, code: true, name: true, category: true } });
      const competencyById = Object.fromEntries(comps.map((c) => [c.id, c]));
      // SHARED-visibility competency responses only (manager-only/HR-only never reach ESS).
      const responses = await prisma.reviewResponse.findMany({
        where: { businessId, reviewInstanceId: review.id, sectionKey: COMPETENCY_SECTION, visibility: 'SHARED' },
        select: { sectionKey: true, itemKey: true, ratingValue: true, perspective: true },
      });
      rollup = competencyGap(responses, roleMaps, competencyById);
    }
    // The IDP note is exposed ONLY when the manager explicitly shared the placement.
    const placement = await prisma.nineBoxPlacement.findFirst({
      where: { businessId, cycleId: review.reviewCycleId, employeeId: employee.id },
      select: { idpNote: true, sharedWithSubject: true },
    });
    const idpNote = placement && placement.sharedWithSubject ? placement.idpNote : null;
    return res.json({ released: true, cycle: review.reviewCycle, gaps: rollup.gaps, scorePct: rollup.scorePct, mappedCount: rollup.mappedCount, idpNote });
  } catch (e) { return next(e); }
}

// ── Peer feedback ─────────────────────────────────────────────────────────────
// GET /ess/performance/feedback/requests — feedback the employee owes (as rater).
async function listFeedbackRequests(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const items = await prisma.peerFeedbackRequest.findMany({
      where: { businessId: ctx.businessId, raterEmployeeId: ctx.employee.id, status: { in: ['REQUESTED'] } },
      select: { id: true, reviewInstanceId: true, requestedByEmployeeId: true, status: true, dueDate: true },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ items });
  } catch (e) { return next(e); }
}

// POST /ess/performance/feedback/requests/:id/respond — submit feedback as a rater.
async function respondFeedback(req, res, next) {
  try {
    const ctx = await withSelf(req, res, { writeGuard: true }); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const reqRow = await prisma.peerFeedbackRequest.findFirst({ where: { id: req.params.id, businessId, raterEmployeeId: employee.id } });
    if (!reqRow) return res.status(404).json({ message: 'Not found' });
    if (reqRow.status !== 'REQUESTED') return res.status(409).json({ message: `Cannot respond from status ${reqRow.status}` });
    const out = await prisma.$transaction(async (tx) => {
      await tx.peerFeedbackResponse.upsert({
        where: { requestId: reqRow.id },
        create: { businessId, requestId: reqRow.id, ratingsJson: req.body.ratingsJson || null, narrative: req.body.narrative || null, isAnonymous: req.body.isAnonymous !== false, submittedAt: new Date() },
        update: { ratingsJson: req.body.ratingsJson || null, narrative: req.body.narrative || null, isAnonymous: req.body.isAnonymous !== false, submittedAt: new Date() },
      });
      await tx.peerFeedbackRequest.updateMany({ where: { id: reqRow.id, version: reqRow.version }, data: { status: 'SUBMITTED', version: { increment: 1 } } });
      return true;
    });
    return res.json({ ok: out, status: 'SUBMITTED' });
  } catch (e) { return next(e); }
}

// POST /ess/performance/feedback/requests — request feedback about ME from a peer.
async function requestFeedback(req, res, next) {
  try {
    const ctx = await withSelf(req, res, { writeGuard: true }); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const { raterEmployeeId } = req.body;
    if (!raterEmployeeId) return res.status(400).json({ message: 'raterEmployeeId is required' });
    if (raterEmployeeId === employee.id) return res.status(422).json({ message: 'You cannot request feedback from yourself' });
    const review = await prisma.performanceReview.findFirst({ where: { businessId, employeeId: employee.id }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (!review) return res.status(404).json({ message: 'No active review instance' });
    const rater = await prisma.employee.findFirst({ where: { id: raterEmployeeId, businessId, deletedAt: null }, select: { id: true } });
    if (!rater) return res.status(404).json({ message: 'Rater not found' });
    const item = await prisma.peerFeedbackRequest.create({
      data: { businessId, reviewInstanceId: review.id, requestedByEmployeeId: employee.id, raterEmployeeId, status: 'REQUESTED', dueDate: req.body.dueDate ? new Date(req.body.dueDate) : null },
    });
    // Requester sees only status — never the eventual content.
    return res.status(201).json({ id: item.id, raterEmployeeId, status: item.status });
  } catch (e) { return next(e); }
}

// GET /ess/performance/one-on-ones — own 1:1s with privateNotes STRIPPED.
async function listOneOnOnes(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const rows = await prisma.oneOnOne.findMany({ where: { businessId: ctx.businessId, employeeEmployeeId: ctx.employee.id }, orderBy: { scheduledAt: 'desc' } });
    // privateNotes NEVER returned to the employee's ESS.
    const items = rows.map(({ privateNotes, ...rest }) => rest);
    return res.json({ items });
  } catch (e) { return next(e); }
}

module.exports = {
  overview, listGoals, createGoal, createKeyResult, createCheckIn,
  getReview, submitSelf, acknowledge,
  development, // Feature 34 — read-only development surface (own gaps + shared IDP)
  listFeedbackRequests, respondFeedback, requestFeedback,
  listOneOnOnes,
  _internals: { resolveSelf, isSeparated },
};
