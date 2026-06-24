'use strict';
// HR vertical API aggregator — mounted at /api/hr in backend/src/index.js.
// Each sub-router owns one HR domain area; controllers are tenant-scoped by
// req.user.businessId. Payroll + compliance register here as they are built
// (see docs/19-delivery-plan.md phasing).
const express = require('express');
const router = express.Router();

// Feature 10 slice 10c — register the LEAVE + EXPENSE approval-engine consumers once
// at boot (idempotent, side-effect-free), so `consumers.get('LEAVE'|'EXPENSE')`
// resolves when the engine fires onApprove/onReject/onCancel. Required here because
// this aggregator is loaded exactly once from backend/src/index.js at app start.
require('../approvals/registerConsumers');

// FLAG (Feature 14 — shared edit): tenant single-country mode. The operator
// surface — POST /setup/country (set the HR country ONCE, the only writer) +
// GET /country-context (capability matrix the hr-admin app gates every
// country-specific surface off). Mounted at the aggregator root so the paths are
// /api/hr/setup/country and /api/hr/country-context.
router.use('/', require('./countryContext.routes'));

router.use('/employees', require('./employee.routes'));
// Company Profile settings — business legal/registration profile, the OPTIONAL
// company-document vault (licences/tax reports/financials/registration+GST
// certificates), and the auto employee-number scheme. Gated on
// canManageCompanyProfile (Owner + HR-Admin); tenant-scoped + audited.
router.use('/company-profile', require('./companyProfile.routes'));
router.use('/org', require('./org.routes'));
router.use('/leave', require('./leave.routes'));
router.use('/attendance', require('./attendance.routes'));
router.use('/compensation', require('./compensation.routes'));
// FLAG (Feature 17 — NEW mount): the friendly CTC-policy builder (reusable,
// CTC-agnostic salary templates) + a pure preview (compile → deriveBreakup →
// waterfall + India 50% verdict) + a sample CTC-statement PDF. Reads gated on
// canViewCompensation, writes on canManageCompensation; countryCode is server
// -stamped from the tenant (single-country invariant). Policies carry NO person
// money, so no per-employee scope/masking applies.
router.use('/ctc-policies', require('./ctcPolicy.routes'));
// FLAG (Feature 17 — NEW mount): Onboard-by-CTC — POST /api/hr/onboard/by-ctc
// creates an Employee + a CompensationRevision(HIRE,EFFECTIVE) from { policyId,
// ctcAnnual, dateOfJoining } in ONE transaction, reusing the SHARED hire-pay math
// (buildHireRevisionLines) so a direct hire matches an ATS hire to the paise.
router.use('/onboard', require('./onboard.routes'));
router.use('/documents', require('./documents.routes'));
// FLAG (Feature 20 — NEW mount): Investment-proof workflow (India year-end §192(2D)/
// Rule 26C/Form 12BB). Operator surfaces: the per-FY declaration WINDOW admin
// (canManageStatutory) + the HR proof-VERIFICATION console (canManageEmployees, F1-
// scoped, SoD on verify). The ESS upload + Form 12BB live under /me/proofs (below).
router.use('/tax-windows', require('./taxWindow.routes'));
router.use('/proofs', require('./proofs.routes'));
router.use('/assets', require('./assets.routes'));
router.use('/expenses', require('./expenses.routes'));
router.use('/loans', require('./loans.routes'));
// FLAG (Cycle 1 — NEW mount): HR Helpdesk operator console. canManageHelpdesk-gated
// (Owner + HR-Admin); tenant-walled. Ticket queue + categories + assign + reply +
// status lifecycle. The ESS self-service surface mounts at /me/helpdesk below.
router.use('/helpdesk', require('./helpdesk.routes'));
// Feature 18 — Data Migration / Bulk Import (CSV-Excel) + back-dated autogen.
// FLAG: new router mount. canManageImports-gated; payroll autogen also needs canRunPayroll.
router.use('/imports', require('../migration/imports.routes'));
router.use('/letters/templates', require('../letters/routes/templates.routes'));

// Employee lifecycle (Feature 4) — onboarding pipeline + checklist tasks. RBAC:
// reads/task actions are F1-scoped (canViewEmployees; manager sees only sub-tree
// hires), HR pipeline actions require canManageOnboarding. Separation/e-sign land
// in later slices (4d/4f).
router.use('/onboarding', require('../lifecycle/routes/onboarding.routes'));
router.use('/separations', require('../lifecycle/routes/offboarding.routes'));
router.use('/esign', require('../lifecycle/routes/esign.routes'));

// Letters & Communication (Feature 9). Mount the specific config routers BEFORE
// the base issuance router so /letters/letterheads (+ /letters/templates above) are
// not swallowed by the issuance /:id route. RBAC: config (letterheads/templates) →
// canManageLetters; issuance/register/download → canGenerateLetters (+withEmployeeScope
// for a named subject → out-of-band 404); revoke → canManageLetters (SoD).
router.use('/letters/letterheads', require('../letters/routes/letterheads.routes'));
router.use('/letters', require('../letters/routes/issuance.routes'));

// Talent (recruitment/ATS + performance). RBAC: recruitment -> canManageEmployees;
// performance -> canViewEmployees (read) / canManageEmployees (write). The offer
// pre-flight reuses the payroll engine's India 50% wage check.
const talent = require('../talent/routes');
router.use('/recruitment', talent.recruitment);
router.use('/performance', talent.performance);
// Feature 8 ESS — employee self-service performance (customer session, self-only).
router.use('/ess/performance', talent.essPerformance);

// Approval-Workflow engine + RBAC/hierarchy admin (Feature 10). Operator session.
//   /api/hr/approvals  → workflow CRUD/publish/preview (canManageApprovalWorkflows)
//                        + unified inbox + /:id/decide (any approver; the engine's
//                        resolved approver set is the real gate) + reassign (admin).
//   /api/hr/rbac       → permissions catalog + role CRUD/grants (canManageRoles),
//                        org-tree (canViewEmployees), re-parent (canManageHierarchy),
//                        assign-role. Backend-only in 10a/10b; no live consumer yet
//                        (leave/expense wire onto the engine in 10c).
router.use('/approvals', require('./approvals.routes'));
router.use('/rbac', require('./rbac.routes'));
// FLAG (Feature 13 — shared edit): HR-admin profile surface — the field-policy map,
// the profile change-request approval queue (F1-scoped + SoD, drives the F10
// PROFILE_CHANGE engine), and the rich sectioned profile for any in-scope employee.
router.use('/profile', require('../profile/profile.routes'));

// Payroll orchestration — operator API (RBAC: canRunPayroll / canApprovePayroll
// / canViewPayrollReports) and the ESS payslip API (customer session). The
// /me/payslips router uses the customer-auth middleware internally.
router.use('/payroll', require('../payroll/payroll.routes'));
router.use('/me/payslips', require('../payroll/mePayslips.routes'));
// Feature 22 — Statutory Bonus (operator) + ESS self-view. India-gated in service.
router.use('/bonus', require('../payroll/bonus.routes'));
router.use('/me/bonus', require('../payroll/meBonus.routes'));
// FLAG (Feature 23 — NEW mount): Statutory Compliance Calendar + reminder cron.
// Read = canViewPayrollReports; mark-filed/proof/waive/obligations/seed/sweep =
// canManageStatutory. Reuses the StatutoryRemittance instance row (extended) +
// StatutoryRegistration applicability + notifyHrEvent + scheduler.js cron.
router.use('/compliance', require('../payroll/compliance/compliance.routes'));
// ESS profile/country surface — the authoritative country source for the ESS app
// (tax declaration, payslip currency, separation labels gate by it; fail-closed).
router.use('/me/profile', require('../lifecycle/routes/meProfile.routes'));
router.use('/me/onboarding', require('../lifecycle/routes/meOnboarding.routes'));
router.use('/me/separation', require('../lifecycle/routes/meSeparation.routes'));
router.use('/me/documents', require('./meDocuments.routes'));
// ESS "My Letters" (Feature 09 §4.5, slice 9F) — own ISSUED non-voided letters +
// download (self-only) + request-a-letter (DocumentRequest → HR queue). Customer session.
router.use('/me/letters', require('../letters/routes/me-letters.routes'));
// ESS compensation (CTC breakup waterfall + history + letters). Customer session;
// SELF_ONLY; no `:id` path → cross-employee leakage is structurally impossible.
router.use('/me/compensation', require('./meCompensation.routes'));
// ESS self-service surfaces (Wave G) — customer session, SELF_ONLY (the subject is
// resolved from the session; no employeeId is ever accepted from the client, so a
// cross-employee read/write is structurally impossible). These mirror the operator
// attendance/leave domains but authenticate the CUSTOMER session and derive the
// employee server-side, fixing the ESS pages that 401'd against the operator API.
router.use('/me/attendance', require('./meAttendance.routes'));
router.use('/me/leave', require('./meLeave.routes'));
// FLAG (Cycle 1 — NEW mount): ESS HR Helpdesk. Customer session, SELF_ONLY (subject
// resolved from the session). Raise a ticket / list "My tickets" / view thread / reply
// / reopen / rate. Internal HR notes are never returned on this surface.
router.use('/me/helpdesk', require('./meHelpdesk.routes'));
// FLAG (Feature 14 — shared edit): ESS capability matrix for the signed-in
// employee's tenant. Customer session; the ESS app gates onboarding statutory /
// tax / currency surfaces off it.
router.use('/me/country-context', require('./meCountryContext.routes'));
router.use('/me/tax-declaration', require('./meTax.routes'));
// FLAG (Feature 15 — new mount): ESS India income-tax PROJECTION (the IT-computation
// statement + monthly TDS projection + PDF). Customer session, SELF_ONLY (subject
// resolved from the session). India-only — the assembler 422s for non-IN tenants.
router.use('/me/tax-projection', require('./meTaxProjection.routes'));
// FLAG (Feature 20 — new mount): ESS investment-PROOF upload + Form 12BB. Customer
// session, SELF_ONLY (subject resolved from the session). Window-OPEN-gated uploads,
// withdraw-own-PENDING, per-claim declared/verified/pending rollup, Form 12BB PDF.
router.use('/me/proofs', require('./meProofs.routes'));
router.use('/me/tasks', require('./meTasks.routes'));
// FLAG (Feature 11 — shared edit): ESS reimbursement/claims + travel. Customer session,
// SELF_ONLY (subject resolved from the session). Apply for reimbursement / outdoor duty,
// submit bills against a trip, live policy verdict, submit → opens the F10 chain.
router.use('/me/expenses', require('./meExpenses.routes'));
// Feature 10 ESS — "Delegate while I'm away" (out-of-office approval delegation).
// Customer session; the delegating user is resolved from the session (self-only).
router.use('/me/delegations', require('./meDelegations.routes'));
// Feature 10 ESS (slice 10e) — unified approvals inbox + act + preview hint for
// the employee portal. Customer session; the operator inbox (/approvals/*) is
// protect-gated and unreachable from ESS, so this mirrors it for req.customer,
// reusing the same engine.recordDecision (SoD/version/active-step guards intact).
router.use('/me/approvals', require('./meApprovals.routes'));
// FLAG (Feature 13 — shared edit): Manager Self-Service. The customer session is given
// the F1 TEAM band (resolveCustomerScope) — roster/attendance/directory/org reads +
// the merged leave+reimbursement approval inbox + decide, all scoped to the manager's
// reporting sub-tree (self excluded for approvals, SoD). A non-manager gets [].
router.use('/me/team', require('../profile/meTeam.routes'));
// FLAG (Cycle 1 — new mount): ESS Company Directory. Customer session; a tenant-wide,
// searchable, paginated colleague directory exposing ONLY safe work/professional fields
// (the Prisma select is the privacy boundary — no personal email/phone, address, DOB,
// salary, or any @pii:sensitive field). Honours F13 field governance + a per-employee
// work-phone opt-out. READ-only across colleagues; the only write is the SELF opt-out.
router.use('/me/directory', require('../profile/meDirectory.routes'));

// FLAG (Engagement Cycle 1 — NEW mounts): company announcements / news feed +
// derived celebration feed (birthdays/anniversaries).
//   /api/hr/announcements        → operator authoring (protect + canManageAnnouncements):
//                                  create/edit/publish/pin/archive + audience targeting
//                                  + scheduled publishedAt; fan-out reuses notifyHrEvent.
//   /api/hr/me/engagement        → ESS (customer session, SELF_ONLY): the in-audience
//                                  news feed (published + not-expired, pinned-first,
//                                  paginated) + mark-as-read + unread count + the
//                                  privacy-aware celebration feed (no DOB-year leak).
router.use('/announcements', require('../engagement/routes/announcements.routes'));
router.use('/me/engagement', require('../engagement/routes/meEngagement.routes'));

// Reports / analytics — read-only payroll register, statutory summary,
// headcount & attrition, leave liability. RBAC: canViewPayrollReports.
router.use('/reports', require('../reports/reports.routes'));

// Integrations — accounting GL export (operator) + public read-only HR API.
//   /api/hr/integrations  → operator API (session auth + RBAC)
//   /api/hr/v1            → public read-only API (ApiKey auth, no session)
// HR notification templates (integrations/notifications.js) and webhook
// emitters (integrations/webhooks.js) are libraries invoked from domain code,
// not HTTP routers, so they are not mounted here.
router.use('/integrations', require('../integrations/integrations.routes'));
router.use('/v1', require('../integrations/publicV1.routes'));

module.exports = router;
