'use strict';

/**
 * registerConsumers.js — Feature 10 slice 10c boot wiring. Required ONCE from the HR
 * bootstrap (hr/routes/index.js) so `consumers.get('LEAVE'|'EXPENSE')` resolves at
 * the moment the engine fires a callback.
 *
 * Registration is idempotent + side-effect-free at module load (it only populates an
 * in-memory Map keyed by WorkflowModule), so requiring this module repeatedly is
 * harmless. A module without a registered consumer still routes through the engine;
 * its callbacks are simply no-ops (the registry's `fire` swallows "not registered").
 */

const { registerLeaveConsumer } = require('./consumers.leave');
const { registerExpenseConsumer } = require('./consumers.expense');
// FLAG (Feature 13 — shared edit): the PROFILE_CHANGE consumer (rich-profile gated
// field → HR approval). Self-registers on load like leave/expense; wired here too so
// the explicit boot path stays the single source of truth.
const { registerProfileChangeConsumer } = require('./consumers.profileChange');
// FLAG (Feature 11 — shared edit): the TRAVEL consumer (pre-trip approval → flips
// TravelRequest.status). Self-registers on load like the others; wired here too so
// the explicit boot path stays the single source of truth.
const { registerTravelConsumer } = require('./consumers.travel');
// FLAG (Feature 30 — shared edit): the COMP_OFF consumer (comp-off EARN approval →
// finalizeCredit / void). Self-registers on load like the others; wired here too so
// the explicit boot path stays the single source of truth.
const { registerCompOffConsumer } = require('./consumers.compOff');
// FLAG (Feature 29 — shared edit): the SHIFT_SWAP consumer (roster-cell trade on
// manager approval → atomic versioned swap + re-derive both days). Self-registers on
// load like the others; wired here too so the explicit boot path stays the single
// source of truth.
const { registerShiftSwapConsumer } = require('./consumers.shiftSwap');
// FLAG (Feature 31 — shared edit): the LEAVE_ENCASHMENT consumer (in-service
// encashment APPROVE → debit the leave balance via a ENCASHMENT LeaveTransaction +
// snapshot the taxable amount). Self-registers on load like the others; wired here
// too so the explicit boot path stays the single source of truth.
const { registerEncashmentConsumer } = require('./consumers.encashment');
// FLAG (Feature 39 — shared edit): the FACE_ENROLLMENT consumer (HR approves a face
// reference → PENDING→ACTIVE flip so face punching goes live). Self-registers on
// load like the others; wired here too so the explicit boot path stays the single
// source of truth.
const { registerFaceEnrollmentConsumer } = require('./consumers.faceEnrollment');
// Program Phase 2 — the previously-direct modules ride the engine: LOAN (EMI
// schedule on approve), TIMESHEET (stamp flips), ATTENDANCE_REGULARIZATION
// (punch materialize + recompute), COMPENSATION (PROPOSED→EFFECTIVE
// supersession), ASSET (assignment created on approve; AUTO default),
// DOCUMENT_SIGN (envelope dispatch gate; AUTO default).
const { registerLoanConsumer } = require('./consumers.loan');
const { registerTimesheetConsumer } = require('./consumers.timesheet');
const { registerRegularizationConsumer } = require('./consumers.regularization');
const { registerCompensationConsumer } = require('./consumers.compensation');
const { registerAssetConsumer } = require('./consumers.asset');
const { registerDocumentSignConsumer } = require('./consumers.documentSign');
// Wave 2B — the maker-checker heavies: SEPARATION (FnF mint via the shared
// core, idempotent on fnfPayRunId), PAYRUN (delegates to service.approveRun
// guards), OFFER (dormant PENDING_APPROVAL/APPROVED states activated).
const { registerSeparationConsumer } = require('./consumers.separation');
const { registerPayrunConsumer } = require('./consumers.payrun');
const { registerOfferConsumer } = require('./consumers.offer');
// FLAG (Feature 35 — shared edit): the R&R trio. RECOGNITION (governed give →
// POSTED + points + feed projection), AWARD (committee approve → WON + points +
// certificate), REDEMPTION (approve → in-tx debit + stock + APPROVED). Each
// self-registers on load like the others; wired here too so the explicit boot
// path stays the single source of truth.
const { registerRecognitionConsumer } = require('./consumers.recognition');
const { registerAwardConsumer } = require('./consumers.award');
const { registerRedemptionConsumer } = require('./consumers.redemption');
// OT pre-approval — the OVERTIME consumer (manager authorizes overtime minutes →
// flips OvertimeRequest.status). Self-registers on load like the others; wired here
// too so the explicit boot path stays the single source of truth.
const { registerOvertimeConsumer } = require('./consumers.overtime');

let done = false;

function registerConsumers() {
  if (done) return;
  registerLeaveConsumer();
  registerExpenseConsumer();
  registerProfileChangeConsumer();
  registerTravelConsumer();
  registerCompOffConsumer();
  registerShiftSwapConsumer();
  registerEncashmentConsumer();
  registerFaceEnrollmentConsumer();
  registerLoanConsumer();
  registerTimesheetConsumer();
  registerRegularizationConsumer();
  registerCompensationConsumer();
  registerAssetConsumer();
  registerDocumentSignConsumer();
  registerSeparationConsumer();
  registerPayrunConsumer();
  registerOfferConsumer();
  registerRecognitionConsumer();
  registerAwardConsumer();
  registerRedemptionConsumer();
  registerOvertimeConsumer();
  done = true;
}

// Register on first require so the boot graph wires the consumers as a side effect of
// loading the HR API (see hr/routes/index.js). Also exported for explicit calls/tests.
registerConsumers();

module.exports = { registerConsumers };
