'use strict';
// nineBox.controller.js — Feature 34 Slices 2–4: 9-box placements, the scope-bound
// board, drag-moves (version + append-only ledger + ninebox.calibrate SoD), the
// placement state machine, calibration mode (REUSES CalibrationSession + the F8
// roster CTE + calibration.distributionWarning), talent-pool/succession tags, and
// the competency rollup join. One tenant boundary (req.user.businessId), the F1
// scope chokepoint ANDed into every read/write, optimistic concurrency on every
// mutation. The performance axis is DERIVED from the F8 review — never re-rated here.
const prisma = require('../../../core/lib/prisma');
const { scopeWhere, scopeAllows, resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');
const { effectivePermissions } = require('../../../core/lib/rbac');
const { ROLES } = require('../../../core/lib/roles');
const { writeAudit } = require('../../../core/lib/audit');
const { num } = require('../performance/goalRollup');
const nb = require('../performance/nineBox');
const { evaluate } = require('../performance/placementStateMachine');
const { competencyGap, COMPETENCY_SECTION } = require('../performance/competencyRollup');
const { serializeNineBox } = require('../performance/serializers');
const notifications = require('../../integrations/notifications');

const STALE_MSG = 'This record was updated elsewhere — reload and try again';

function actorEmployeeId(req) { return req.user && req.user.employeeId ? req.user.employeeId : null; }
function hasPerm(req, key) {
  if (req.user && req.user.role === ROLES.SUPER_ADMIN) return true;
  const perms = effectivePermissions(req.user) || {};
  return !!perms[key];
}
function isHr(req) { return hasPerm(req, 'canManagePerformanceCycle'); }

async function locked(tx, model, id, expected, data) {
  const r = await tx[model].updateMany({ where: { id, version: expected }, data: { ...data, version: { increment: 1 } } });
  if (r.count === 0) return null;
  return tx[model].findUnique({ where: { id } });
}

// Viewer relationship for the confidentiality serializer (mirrors performance.controller).
function viewerFor(req, employeeId) {
  const me = actorEmployeeId(req);
  if (isHr(req)) return 'HR';
  if (me && employeeId === me) return 'SELF';
  return 'MANAGER'; // a scoped non-HR viewer is, by construction, the subject's manager-chain
}

// Per-cycle 9-box config: { perfBands, potentialScaleId, gridTargetJson }.
function cycleConfig(cycle) {
  const cfg = (cycle && cycle.nineBoxConfigJson) || {};
  return {
    perfBands: Array.isArray(cfg.perfBands) && cfg.perfBands.length ? cfg.perfBands : nb.DEFAULT_PERF_BANDS,
    potentialBands: Array.isArray(cfg.potentialBands) && cfg.potentialBands.length ? cfg.potentialBands : nb.DEFAULT_PERF_BANDS,
    potentialScaleId: cfg.potentialScaleId || null,
    gridTargetJson: cfg.gridTargetJson || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PLACEMENTS — seed (perf axis), board read, author potential, recompute
// ─────────────────────────────────────────────────────────────────────────────

// POST /ninebox/cycles/:cycleId/seed — mint a DRAFT placement per reviewed subject in
// the cycle, snapshotting the DERIVED performance band from the F8 effective rating.
// Idempotent (skips employees who already have a placement). HR config grant.
async function seedPlacements(req, res, next) {
  try {
    const { businessId } = req.user;
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: req.params.cycleId, businessId } });
    if (!cycle) return res.status(404).json({ message: 'Review cycle not found' });
    const cfg = cycleConfig(cycle);
    // Only subjects whose review has a perf axis (manager has rated) are placeable.
    const reviews = await prisma.performanceReview.findMany({
      where: { businessId, reviewCycleId: cycle.id, status: { in: ['MANAGER_SUBMITTED', 'CALIBRATED', 'ACKNOWLEDGED', 'CLOSED'] } },
      select: { id: true, employeeId: true, calibratedRating: true, finalRating: true, managerRating: true },
    });
    const existing = await prisma.nineBoxPlacement.findMany({ where: { businessId, cycleId: cycle.id }, select: { employeeId: true } });
    const have = new Set(existing.map((p) => p.employeeId));
    const created = [];
    const skipped = [];
    for (const rv of reviews) {
      if (have.has(rv.employeeId)) { skipped.push({ employeeId: rv.employeeId, reason: 'already_placed' }); continue; }
      const rating = nb.effectiveRating(rv);
      const perfBand = nb.bandFromRating(rating, cfg.perfBands);
      if (perfBand == null) { skipped.push({ employeeId: rv.employeeId, reason: 'unrated' }); continue; }
      try {
        const row = await prisma.nineBoxPlacement.create({
          data: {
            businessId, cycleId: cycle.id, employeeId: rv.employeeId, reviewInstanceId: rv.id,
            performanceBand: perfBand, status: 'DRAFT', potentialScaleId: cfg.potentialScaleId,
          },
        });
        created.push(row.id);
      } catch (err) {
        if (err.code === 'P2002') { skipped.push({ employeeId: rv.employeeId, reason: 'already_placed' }); continue; }
        throw err;
      }
    }
    await writeAudit({ businessId, actorId: req.user.id, action: 'ninebox.seed', entityType: 'ReviewCycle', entityId: cycle.id, meta: { created: created.length, skipped: skipped.length } });
    res.json({ created: created.length, skipped });
  } catch (e) { next(e); }
}

// GET /ninebox/board?cycleId=… — the grid cohort, scope-bound. HR = all; Manager =
// their TEAM sub-tree (the board fetch is scope-bound server-side; a peer's report is
// unreachable). Returns placements bucketed into the 9 cells + the concentration warning.
async function board(req, res, next) {
  try {
    const { businessId } = req.user;
    if (!req.query.cycleId) return res.status(400).json({ message: 'cycleId is required' });
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: req.query.cycleId, businessId } });
    if (!cycle) return res.status(404).json({ message: 'Review cycle not found' });
    const cfg = cycleConfig(cycle);
    const where = { businessId, cycleId: cycle.id, ...scopeWhere(req.scope, 'employeeId') };
    const placements = await prisma.nineBoxPlacement.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } } },
    });
    const viewer = isHr(req) ? 'HR' : 'MANAGER';
    const serialized = placements.map((p) => ({ ...serializeNineBox(p, viewer), employee: p.employee }));
    const { distribution, warning } = nb.gridConcentration(placements, cfg.gridTargetJson);
    // Bucket into the 9 cells + an "unplaced" tray (potential not yet authored).
    const cells = {};
    for (let b = 1; b <= 9; b += 1) cells[b] = [];
    const unplaced = [];
    for (const p of serialized) {
      if (p.box == null) unplaced.push(p); else cells[p.box].push(p);
    }
    res.json({ cycleId: cycle.id, cells, unplaced, distribution, warning, boxLabels: nb.BOX_LABELS });
  } catch (e) { next(e); }
}

// Load a placement the actor may act on (scope keyed on the SUBJECT). `scopeAction`
// controls SoD (ninebox.calibrate subtracts self). HR bypasses the band, tenant-bound.
async function loadActable(req, res, scopeAction) {
  const { businessId } = req.user;
  const placement = await prisma.nineBoxPlacement.findFirst({ where: { id: req.params.id, businessId } });
  if (!placement) { res.status(404).json({ message: 'Not found' }); return null; }
  if (!isHr(req)) {
    const scope = await resolveAccessibleEmployeeIds(req.user, scopeAction);
    if (!scopeAllows(scope, placement.employeeId)) { res.status(404).json({ message: 'Not found' }); return null; }
  }
  return { placement };
}

// Build the state-machine ctx from the placement + actor + linked review + session.
async function buildCtx(req, placement, { sessionOpen = undefined } = {}) {
  const { businessId } = req.user;
  const me = actorEmployeeId(req);
  // Manager-of-subject: the actor is the subject's direct manager.
  const subject = await prisma.employee.findFirst({ where: { id: placement.employeeId, businessId }, select: { managerEmployeeId: true } });
  const isManagerOfSubject = !!(me && subject && subject.managerEmployeeId === me);
  // Skip-level: the actor is the subject's manager's manager.
  let isSkipLevel = false;
  if (me && subject && subject.managerEmployeeId) {
    const mgr = await prisma.employee.findFirst({ where: { id: subject.managerEmployeeId, businessId }, select: { managerEmployeeId: true } });
    isSkipLevel = !!(mgr && mgr.managerEmployeeId === me);
  }
  // Linked review status = perf-axis existence.
  let reviewStatus = null;
  if (placement.reviewInstanceId) {
    const rv = await prisma.performanceReview.findFirst({ where: { id: placement.reviewInstanceId, businessId }, select: { status: true } });
    reviewStatus = rv && rv.status;
  }
  const hr = isHr(req);
  return {
    actorEmployeeId: me,
    subjectEmployeeId: placement.employeeId,
    isHr: hr,
    isManagerOfSubject: isManagerOfSubject || hr,
    isSkipLevel: isSkipLevel || hr,
    canSucceed: hasPerm(req, 'canManageSuccession'),
    reviewStatus,
    sessionOpen: sessionOpen !== undefined ? sessionOpen : true,
  };
}

// POST /ninebox/placements/:id/author-potential — the manager (or HR) authors the
// potential rating on their report → bands it → box set → PROPOSED. canViewTeamPerformance.
async function authorPotential(req, res, next) {
  try {
    const loaded = await loadActable(req, res, 'canViewTeamPerformance');
    if (!loaded) return undefined;
    const { placement } = loaded;
    if (req.body.potentialRating === undefined || req.body.potentialRating === null) {
      return res.status(400).json({ message: 'potentialRating is required' });
    }
    const ctx = await buildCtx(req, placement);
    const verdict = evaluate('authorPotential', placement.status, ctx);
    if (!verdict.ok) return res.status(verdict.code).json({ message: verdict.message });
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: placement.cycleId, businessId: req.user.businessId } });
    const cfg = cycleConfig(cycle);
    const potBand = nb.bandFromRating(req.body.potentialRating, cfg.potentialBands);
    const box = nb.computeBox(placement.performanceBand, potBand);
    const expected = req.body.version !== undefined ? Number(req.body.version) : placement.version;
    const out = await prisma.$transaction(async (tx) => {
      const data = {
        potentialRating: req.body.potentialRating, potentialBand: potBand, box, status: 'PROPOSED',
        potentialScaleId: req.body.potentialScaleId || placement.potentialScaleId || cfg.potentialScaleId,
      };
      if (req.body.idpNote !== undefined) data.idpNote = req.body.idpNote;
      const updated = await locked(tx, 'nineBoxPlacement', placement.id, expected, data);
      if (!updated) return { stale: true };
      // Ledger the initial placement as a move (fromBox null → toBox).
      await tx.nineBoxMove.create({
        data: {
          businessId: req.user.businessId, placementId: placement.id, sessionId: null,
          fromBox: placement.box, toBox: box, fromPotential: placement.potentialRating,
          toPotential: req.body.potentialRating, reason: req.body.reason || 'potential authored',
          byEmployeeId: actorEmployeeId(req) || updated.employeeId,
        },
      });
      await writeAudit({ businessId: req.user.businessId, actorId: req.user.id, action: 'ninebox.authorPotential', entityType: 'NineBoxPlacement', entityId: placement.id, meta: { box, potentialBand: potBand } });
      return { updated };
    });
    if (out.stale) return res.status(409).json({ message: STALE_MSG });
    res.json(serializeNineBox(out.updated, viewerFor(req, out.updated.employeeId)));
  } catch (e) { next(e); }
}

// POST /ninebox/placements/:id/recompute-performance — re-derive the perf band from the
// (possibly re-calibrated) F8 rating, pre-FINALIZE only. Never hand-edited. HR.
async function recomputePerformance(req, res, next) {
  try {
    const { businessId } = req.user;
    const placement = await prisma.nineBoxPlacement.findFirst({ where: { id: req.params.id, businessId } });
    if (!placement) return res.status(404).json({ message: 'Not found' });
    if (placement.status === 'FINALIZED') return res.status(409).json({ message: 'Placement is finalized — the performance band is frozen' });
    if (!placement.reviewInstanceId) return res.status(422).json({ message: 'No linked review instance to recompute from' });
    const rv = await prisma.performanceReview.findFirst({ where: { id: placement.reviewInstanceId, businessId }, select: { calibratedRating: true, finalRating: true, managerRating: true } });
    if (!rv) return res.status(404).json({ message: 'Linked review not found' });
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: placement.cycleId, businessId } });
    const cfg = cycleConfig(cycle);
    const perfBand = nb.bandFromRating(nb.effectiveRating(rv), cfg.perfBands);
    if (perfBand == null) return res.status(422).json({ message: 'Linked review is no longer rated' });
    const box = nb.computeBox(perfBand, placement.potentialBand);
    const expected = req.body.version !== undefined ? Number(req.body.version) : placement.version;
    const updated = await locked(prisma, 'nineBoxPlacement', placement.id, expected, { performanceBand: perfBand, box });
    if (!updated) return res.status(409).json({ message: STALE_MSG });
    await writeAudit({ businessId, actorId: req.user.id, action: 'ninebox.recomputePerformance', entityType: 'NineBoxPlacement', entityId: placement.id, meta: { performanceBand: perfBand, box } });
    res.json(serializeNineBox(updated, viewerFor(req, updated.employeeId)));
  } catch (e) { next(e); }
}

// GET /ninebox/placements/:id — single placement (scope-keyed on subject), with the
// competency rollup for the cell drill-down. Confidentiality-serialized for the viewer.
async function getPlacement(req, res, next) {
  try {
    const { businessId } = req.user;
    const placement = await prisma.nineBoxPlacement.findFirst({
      where: { id: req.params.id, businessId },
      include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } }, moves: { orderBy: { createdAt: 'desc' } } },
    });
    if (!placement) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllows(req.scope, placement.employeeId)) return res.status(404).json({ message: 'Not found' });
    const viewer = viewerFor(req, placement.employeeId);
    const rollup = await competencyRollupForSubject(businessId, placement.employeeId, placement.reviewInstanceId, { managerOnly: false });
    res.json({ placement: { ...serializeNineBox(placement, viewer), employee: placement.employee }, competency: rollup });
  } catch (e) { next(e); }
}

// Resolve the role keys a subject's competency map is keyed on. The role data
// (designation/grade) lives on the CURRENT EmploymentRecord (Employee carries only
// the denormalized pointer); we read it through that join. 'ALL' is always included
// so an org-wide competency set applies even when a role isn't mapped.
async function resolveRoleKeys(businessId, employeeId) {
  const roleKeys = ['ALL'];
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, businessId }, select: { currentEmploymentRecordId: true } });
  if (emp && emp.currentEmploymentRecordId) {
    const rec = await prisma.employmentRecord.findFirst({ where: { id: emp.currentEmploymentRecordId, businessId }, select: { designationId: true, gradeId: true } });
    if (rec && rec.designationId) roleKeys.push(rec.designationId);
    if (rec && rec.gradeId) roleKeys.push(rec.gradeId);
  }
  return roleKeys;
}

// Shared rollup helper: gaps + score for a subject from their competency ReviewResponse
// rows against their role's RoleCompetency map. Pure math via competencyRollup.js.
async function competencyRollupForSubject(businessId, employeeId, reviewInstanceId, { managerOnly = false } = {}) {
  const roleKeys = await resolveRoleKeys(businessId, employeeId);
  const roleMaps = await prisma.roleCompetency.findMany({ where: { businessId, roleKey: { in: roleKeys } } });
  if (!roleMaps.length) return { gaps: [], mappedCount: 0, ratedMappedCount: 0, scorePct: null };
  const competencyIds = [...new Set(roleMaps.map((m) => m.competencyId))];
  const comps = await prisma.competency.findMany({ where: { businessId, id: { in: competencyIds } }, select: { id: true, code: true, name: true, category: true } });
  const competencyById = Object.fromEntries(comps.map((c) => [c.id, c]));
  let responses = [];
  if (reviewInstanceId) {
    const where = { businessId, reviewInstanceId, sectionKey: COMPETENCY_SECTION };
    if (managerOnly) where.perspective = 'MANAGER';
    responses = await prisma.reviewResponse.findMany({ where, select: { sectionKey: true, itemKey: true, ratingValue: true, perspective: true } });
  }
  return competencyGap(responses, roleMaps, competencyById);
}

// ─────────────────────────────────────────────────────────────────────────────
// CALIBRATION MODE — reuse CalibrationSession (kind=NINE_BOX) + the F8 roster CTE
// ─────────────────────────────────────────────────────────────────────────────

// POST /ninebox/sessions — open a NINE_BOX calibration session rooted at a skip-level
// employee (REUSES calibration.controller.createSession semantics; F1-intersected), or
// upgrade an existing RATING session for the same root to BOTH. canCalibrateRatings.
async function createSession(req, res, next) {
  try {
    const { businessId } = req.user;
    const { cycleId, skipLevelEmployeeId } = req.body;
    if (!cycleId || !skipLevelEmployeeId) return res.status(400).json({ message: 'cycleId and skipLevelEmployeeId are required' });
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: cycleId, businessId }, select: { id: true } });
    if (!cycle) return res.status(404).json({ message: 'Review cycle not found' });
    if (!isHr(req)) {
      const actorScope = await resolveAccessibleEmployeeIds(req.user, 'canCalibrateRatings');
      if (!scopeAllows(actorScope, skipLevelEmployeeId)) return res.status(404).json({ message: 'Not found' });
    }
    // Upgrade an existing OPEN RATING session for the same root to BOTH (one meeting
    // hosts the histogram + the grid); else create a fresh NINE_BOX session.
    const existing = await prisma.calibrationSession.findFirst({ where: { businessId, cycleId, skipLevelEmployeeId, status: { in: ['OPEN', 'LOCKED'] } } });
    let item;
    if (existing && existing.kind === 'RATING') {
      item = await prisma.calibrationSession.update({ where: { id: existing.id }, data: { kind: 'BOTH', version: { increment: 1 } } });
    } else if (existing) {
      item = existing; // already NINE_BOX or BOTH
    } else {
      item = await prisma.calibrationSession.create({ data: { businessId, cycleId, skipLevelEmployeeId, status: 'OPEN', kind: 'NINE_BOX' } });
    }
    await writeAudit({ businessId, actorId: req.user.id, action: 'ninebox.session.open', entityType: 'CalibrationSession', entityId: item.id, meta: { cycleId, skipLevelEmployeeId, kind: item.kind } });
    // Notify participating managers the session opened (reuse notifyHrEvent; best-effort).
    try {
      await notifications.notifyHrEvent({ businessId, event: 'ninebox.session.opened', variables: { cycleId, sessionId: item.id }, triggeredBy: `HR_NINEBOX_SESSION_${item.id}` });
    } catch (_) { /* notifications never block the action */ }
    res.status(201).json(item);
  } catch (e) { next(e); }
}

// Resolve the skip-level cohort EXACTLY as calibration.controller.sessionRoster does
// (same CTE, same F1 intersection) so the 9-box session and the rating session resolve
// the SAME roster from one chokepoint.
async function resolveCohort(req, session) {
  const scope = await resolveAccessibleEmployeeIds(
    { ...req.user, employeeId: session.skipLevelEmployeeId, businessRole: { defaultScope: 'TEAM' }, role: 'STAFF' },
    'canCalibrateRatings',
  );
  let groupIds = scope.kind === 'IDS' ? [...scope.ids] : null;
  if (!isHr(req)) {
    const actorScope = await resolveAccessibleEmployeeIds(req.user, 'canCalibrateRatings');
    if (!scopeAllows(actorScope, session.skipLevelEmployeeId)) return { denied: true };
    if (actorScope.kind === 'IDS') {
      const allowed = actorScope.ids;
      groupIds = (groupIds || [...allowed]).filter((id) => allowed.has(id));
    } else if (actorScope.kind === 'NONE') {
      groupIds = [];
    }
  }
  return { groupIds };
}

// GET /ninebox/sessions/:id/grid — the cohort joined to their placements, bucketed
// into the 9 cells, plus the concentration warning (calibration.distributionWarning
// via nineBox.gridConcentration). canCalibrateRatings.
async function sessionGrid(req, res, next) {
  try {
    const { businessId } = req.user;
    const session = await prisma.calibrationSession.findFirst({ where: { id: req.params.id, businessId } });
    if (!session) return res.status(404).json({ message: 'Not found' });
    const { denied, groupIds } = await resolveCohort(req, session);
    if (denied) return res.status(404).json({ message: 'Not found' });
    const where = { businessId, cycleId: session.cycleId };
    if (groupIds) where.employeeId = { in: groupIds };
    const placements = await prisma.nineBoxPlacement.findMany({
      where,
      include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: session.cycleId, businessId } });
    const cfg = cycleConfig(cycle);
    const { distribution, warning } = nb.gridConcentration(placements, cfg.gridTargetJson);
    const cells = {};
    for (let b = 1; b <= 9; b += 1) cells[b] = [];
    const unplaced = [];
    for (const p of placements) {
      const ser = { ...serializeNineBox(p, isHr(req) ? 'HR' : 'MANAGER'), employee: p.employee };
      if (p.box == null) unplaced.push(ser); else cells[p.box].push(ser);
    }
    res.json({ session, cells, unplaced, distribution, warning, boxLabels: nb.BOX_LABELS });
  } catch (e) { next(e); }
}

// POST /ninebox/placements/:id/move — a drag-move during an OPEN NINE_BOX/BOTH session.
// SoD via ninebox.calibrate (self dropped). Version-checked + ledgered. canCalibrateRatings.
async function movePlacement(req, res, next) {
  try {
    const { businessId } = req.user;
    const loaded = await loadActable(req, res, 'ninebox.calibrate'); // SoD: self dropped
    if (!loaded) return undefined;
    const { placement } = loaded;
    const { sessionId } = req.body;
    if (req.body.toPotential === undefined || req.body.toPotential === null) {
      return res.status(400).json({ message: 'toPotential is required' });
    }
    if (!req.body.reason) return res.status(400).json({ message: 'reason is required (ledger)' });
    // A move requires an OPEN NINE_BOX/BOTH session covering this cohort.
    let sessionOpen = false;
    let session = null;
    if (sessionId) {
      session = await prisma.calibrationSession.findFirst({ where: { id: sessionId, businessId, cycleId: placement.cycleId } });
      sessionOpen = !!(session && session.status === 'OPEN' && (session.kind === 'NINE_BOX' || session.kind === 'BOTH'));
    }
    const ctx = await buildCtx(req, placement, { sessionOpen });
    const verdict = evaluate('move', placement.status, ctx);
    if (!verdict.ok) return res.status(verdict.code).json({ message: verdict.message });
    const cycle = await prisma.reviewCycle.findFirst({ where: { id: placement.cycleId, businessId } });
    const cfg = cycleConfig(cycle);
    const potBand = nb.bandFromRating(req.body.toPotential, cfg.potentialBands);
    const toBox = nb.computeBox(placement.performanceBand, potBand);
    // Idempotent no-op guard: same box AND same potential → reject (no junk ledger row).
    if (toBox === placement.box && num(req.body.toPotential) === num(placement.potentialRating)) {
      return res.status(409).json({ message: 'No-op move (same box and potential)' });
    }
    const actorEmp = actorEmployeeId(req);
    if (!actorEmp) return res.status(422).json({ message: 'A move requires a linked employee for ledger attribution' });
    const expected = req.body.version !== undefined ? Number(req.body.version) : placement.version;
    const out = await prisma.$transaction(async (tx) => {
      const updated = await locked(tx, 'nineBoxPlacement', placement.id, expected, {
        potentialRating: req.body.toPotential, potentialBand: potBand, box: toBox, status: 'CALIBRATED',
      });
      if (!updated) return { stale: true };
      await tx.nineBoxMove.create({
        data: {
          businessId, placementId: placement.id, sessionId: session ? session.id : null,
          fromBox: placement.box, toBox, fromPotential: placement.potentialRating, toPotential: req.body.toPotential,
          reason: req.body.reason, byEmployeeId: actorEmp,
        },
      });
      await writeAudit({ businessId, actorId: req.user.id, action: 'ninebox.move', entityType: 'NineBoxPlacement', entityId: placement.id, meta: { fromBox: placement.box, toBox, sessionId: session ? session.id : null } });
      return { updated };
    });
    if (out.stale) return res.status(409).json({ message: STALE_MSG });
    res.json(serializeNineBox(out.updated, viewerFor(req, out.updated.employeeId)));
  } catch (e) { next(e); }
}

// POST /ninebox/placements/:id/finalize — lock the placement; succession/talent
// decisions act on it. canManageSuccession. Trips the concentration warning notification.
async function finalizePlacement(req, res, next) {
  try {
    const { businessId } = req.user;
    const placement = await prisma.nineBoxPlacement.findFirst({ where: { id: req.params.id, businessId } });
    if (!placement) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllows(req.scope, placement.employeeId)) return res.status(404).json({ message: 'Not found' });
    const ctx = await buildCtx(req, placement);
    const verdict = evaluate('finalize', placement.status, ctx);
    if (!verdict.ok) return res.status(verdict.code).json({ message: verdict.message });
    const expected = req.body.version !== undefined ? Number(req.body.version) : placement.version;
    const updated = await locked(prisma, 'nineBoxPlacement', placement.id, expected, { status: 'FINALIZED' });
    if (!updated) return res.status(409).json({ message: STALE_MSG });
    await writeAudit({ businessId, actorId: req.user.id, action: 'ninebox.finalize', entityType: 'NineBoxPlacement', entityId: placement.id, meta: { box: updated.box } });
    // Concentration warning on finalize → notify HR if the grid is over target (advisory).
    try {
      const cycle = await prisma.reviewCycle.findFirst({ where: { id: placement.cycleId, businessId } });
      const cfg = cycleConfig(cycle);
      const all = await prisma.nineBoxPlacement.findMany({ where: { businessId, cycleId: placement.cycleId }, select: { box: true } });
      const { warning } = nb.gridConcentration(all, cfg.gridTargetJson);
      if (warning.hasTarget && !warning.withinTolerance) {
        await notifications.notifyHrEvent({ businessId, event: 'ninebox.concentration.tripped', variables: { cycleId: placement.cycleId }, triggeredBy: `HR_NINEBOX_CONCENTRATION_${placement.cycleId}` });
      }
    } catch (_) { /* never block finalize on a warning notification */ }
    res.json(serializeNineBox(updated, viewerFor(req, updated.employeeId)));
  } catch (e) { next(e); }
}

// POST /ninebox/placements/:id/reopen — HR returns a finalized placement to PROPOSED.
async function reopenPlacement(req, res, next) {
  try {
    const { businessId } = req.user;
    const placement = await prisma.nineBoxPlacement.findFirst({ where: { id: req.params.id, businessId } });
    if (!placement) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllows(req.scope, placement.employeeId)) return res.status(404).json({ message: 'Not found' });
    const ctx = await buildCtx(req, placement);
    const verdict = evaluate('reopen', placement.status, ctx);
    if (!verdict.ok) return res.status(verdict.code).json({ message: verdict.message });
    const expected = req.body.version !== undefined ? Number(req.body.version) : placement.version;
    const updated = await locked(prisma, 'nineBoxPlacement', placement.id, expected, { status: 'PROPOSED' });
    if (!updated) return res.status(409).json({ message: STALE_MSG });
    await writeAudit({ businessId, actorId: req.user.id, action: 'ninebox.reopen', entityType: 'NineBoxPlacement', entityId: placement.id });
    res.json(serializeNineBox(updated, viewerFor(req, updated.employeeId)));
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TALENT POOL / SUCCESSION — TalentTag CRUD (canManageSuccession)
// ─────────────────────────────────────────────────────────────────────────────
async function listTalentTags(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId, ...scopeWhere(req.scope, 'employeeId') };
    if (req.query.kind) where.kind = req.query.kind;
    if (req.query.positionRef) where.positionRef = req.query.positionRef;
    if (req.query.active !== undefined) where.isActive = req.query.active === 'true' || req.query.active === true;
    const items = await prisma.talentTag.findMany({
      where, orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
      include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } } },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function createTalentTag(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, kind } = req.body;
    if (!employeeId || !kind) return res.status(400).json({ message: 'employeeId and kind are required' });
    if (!scopeAllows(req.scope, employeeId)) return res.status(404).json({ message: 'Employee not found' });
    const emp = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null }, select: { id: true } });
    if (!emp) return res.status(404).json({ message: 'Employee not found' });
    if (kind === 'SUCCESSOR' && !req.body.positionRef) return res.status(422).json({ message: 'SUCCESSOR requires a positionRef' });
    const item = await prisma.talentTag.create({
      data: {
        businessId, employeeId, kind,
        positionRef: req.body.positionRef || null, readiness: req.body.readiness || null,
        note: req.body.note || null, cycleId: req.body.cycleId || null,
        createdByEmployeeId: actorEmployeeId(req),
      },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'talentTag.create', entityType: 'TalentTag', entityId: item.id, meta: { employeeId, kind, positionRef: item.positionRef } });
    res.status(201).json(item);
  } catch (e) { next(e); }
}

async function updateTalentTag(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.talentTag.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllows(req.scope, existing.employeeId)) return res.status(404).json({ message: 'Not found' });
    const expected = req.body.version !== undefined ? Number(req.body.version) : existing.version;
    const data = {};
    for (const f of ['positionRef', 'readiness', 'note', 'isActive']) if (req.body[f] !== undefined) data[f] = req.body[f];
    const r = await prisma.talentTag.updateMany({ where: { id: existing.id, version: expected }, data: { ...data, version: { increment: 1 } } });
    if (r.count === 0) return res.status(409).json({ message: STALE_MSG });
    const updated = await prisma.talentTag.findUnique({ where: { id: existing.id } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'talentTag.update', entityType: 'TalentTag', entityId: existing.id, meta: { isActive: updated.isActive } });
    res.json(updated);
  } catch (e) { next(e); }
}

// GET /ninebox/succession?positionRef=… — succession-by-position view (successors with
// readiness chips). Group-by position handled client-side; this returns the SUCCESSOR tags.
async function successionView(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId, kind: 'SUCCESSOR', isActive: true, ...scopeWhere(req.scope, 'employeeId') };
    if (req.query.positionRef) where.positionRef = req.query.positionRef;
    const items = await prisma.talentTag.findMany({
      where, orderBy: [{ positionRef: 'asc' }, { readiness: 'asc' }],
      include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } } },
    });
    // Group by positionRef for the succession board.
    const byPosition = {};
    for (const t of items) {
      const key = t.positionRef || 'UNSPECIFIED';
      if (!byPosition[key]) byPosition[key] = [];
      byPosition[key].push(t);
    }
    res.json({ byPosition, total: items.length });
  } catch (e) { next(e); }
}

module.exports = {
  seedPlacements, board, getPlacement, authorPotential, recomputePerformance,
  createSession, sessionGrid, movePlacement, finalizePlacement, reopenPlacement,
  listTalentTags, createTalentTag, updateTalentTag, successionView,
  _internals: { competencyRollupForSubject, resolveRoleKeys, cycleConfig, viewerFor },
};
