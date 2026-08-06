'use strict';

/**
 * notifications.js — HR event notification templates + a thin send helper.
 *
 * This DOES NOT introduce a new transport. It registers HR-specific message
 * templates into the EXISTING notification/template system
 * (core/lib/notifications/templates.js + router.js) so HR events can be sent
 * over the existing email/SMS/WhatsApp cascade.
 *
 * Two pieces:
 *   1. HR_TEMPLATES — the canonical registry of HR templates (same shape as
 *      core templates: key/displayName/category/vertical/body/variables/channels).
 *   2. seedHrTemplates() — upserts them into the MessageTemplate table, reusing
 *      the SAME upsert logic the core seeder uses (so DLT/Twilio provider IDs and
 *      approval status set by super-admins are preserved on re-seed).
 *
 * Sending re-uses router.sendNotification() unchanged — see notifyHrEvent().
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { render, registerTemplates } = require('../../core/lib/notifications/templates');
const { sendNotification } = require('../../core/lib/notifications/router');

// Domain event name → template key. The webhook/event layer emits these event
// names; this map lets a single dispatcher fan out to both webhooks and
// templated notifications.
const HR_EVENT_TEMPLATES = Object.freeze({
  'payslip.published': 'HR_PAYSLIP_PUBLISHED',
  'leave.approved':    'HR_LEAVE_APPROVED',
  'payrun.computed':   'HR_PAYRUN_COMPUTED',
  'filing.due':        'HR_FILING_DUE',
  // Feature 23 — Statutory Compliance Calendar reminder cron (beside filing.due).
  'compliance.reminder': 'HR_COMPLIANCE_REMINDER', // T-7/T-3/T-1/due nudges
  'compliance.overdue':  'HR_COMPLIANCE_OVERDUE',  // past-due escalation
  'offer.sent':        'HR_OFFER_SENT',
  // Cycle 0 — approval/SLA fan-out events.
  'approval.pending':  'HR_APPROVAL_PENDING',
  'approval.decided':  'HR_APPROVAL_DECIDED',
  'approval.reminder': 'HR_APPROVAL_REMINDER',
  // Cycle 1 — HR Helpdesk ticket lifecycle fan-out.
  'helpdesk.created':  'HR_HELPDESK_CREATED',   // → assignee (or HR) on raise
  'helpdesk.assigned': 'HR_HELPDESK_ASSIGNED',  // → new assignee on (re)assignment
  'helpdesk.replied':  'HR_HELPDESK_REPLIED',   // → the OTHER party on a new reply
  'helpdesk.resolved': 'HR_HELPDESK_RESOLVED',  // → requester on resolve/close
  // Cycle 1 — engagement: announcements + celebrations.
  'announcement.published': 'HR_ANNOUNCEMENT_PUBLISHED',
  'celebration.birthday':   'HR_BIRTHDAY',
  'celebration.anniversary':'HR_ANNIVERSARY',
  // Feature 22 — Statutory Bonus fan-out (operator on compute, employee on publish).
  'bonus.computed':  'HR_BONUS_COMPUTED',   // → operator when a cycle's awards are computed
  'bonus.published': 'HR_BONUS_PUBLISHED',  // → employee when their bonus slip is published
  // Program P1.4 — probation sweep fan-out.
  'probation.ending':    'HR_PROBATION_ENDING',    // → manager/HR N days before end date
  'probation.confirmed': 'HR_PROBATION_CONFIRMED', // → employee on (auto-)confirmation
  // Program P1.7 — document expiry sweep (passport/visa/licence + company docs).
  'document.expiring':   'HR_DOCUMENT_EXPIRING_SOON', // → employee + HR at T-30/7/1/0
  // Program Phase 2 — approval-gated e-sign dispatch: signer invite links.
  'esign.invite':        'HR_ESIGN_INVITE', // → each signer when an approved envelope dispatches
  // Feature 4 — Employee portal invitation (welcome + set-password link).
  'portal.invite':   'HR_PORTAL_INVITE',    // → new hire to claim their ESS login
  // Feature 20 — Investment-proof workflow fan-out (window lifecycle + verdicts + reminders).
  'proof.window-open': 'HR_PROOF_WINDOW_OPEN',   // → OLD-regime employees when the window opens
  'proof.reminder':    'HR_PROOF_REMINDER',      // → employees with PENDING/missing proofs (T-14/T-3)
  'proof.deadline':    'HR_PROOF_DEADLINE',      // → employees with verified<declared at the deadline
  'proof.accepted':    'HR_PROOF_ACCEPTED',      // → employee when HR accepts a proof
  'proof.rejected':    'HR_PROOF_REJECTED',      // → employee when HR rejects a proof
  // Feature 30 — Comp-off lifecycle fan-out.
  'comp-off.earned':        'HR_COMP_OFF_EARNED',        // → employee when a credit becomes ACTIVE
  'comp-off.earn-pending':  'HR_COMP_OFF_EARN_PENDING',  // → manager when a credit awaits approval
  'comp-off.expiring-soon': 'HR_COMP_OFF_EXPIRING_SOON', // → employee N days before a credit lapses
  'comp-off.lapsed':        'HR_COMP_OFF_LAPSED',        // → employee when a credit expires unused
  // Feature 31 — In-service leave encashment fan-out.
  'leave-encash.requested': 'HR_LEAVE_ENCASH_REQUESTED', // → approver when a request is raised
  'leave-encash.approved':  'HR_LEAVE_ENCASH_APPROVED',  // → employee on approval (days + amount)
  'leave-encash.rejected':  'HR_LEAVE_ENCASH_REJECTED',  // → employee on rejection
  'leave-encash.paid':      'HR_LEAVE_ENCASH_PAID',       // → employee when the payout rides a payslip
  // Feature 28 — Biometric ingestion watchdog fan-out (→ canManageAttendance ops).
  'biometric.device_silent': 'HR_BIOMETRIC_DEVICE_SILENT', // a registered device went quiet past expectedSilenceMin
  'biometric.high_unmapped': 'HR_BIOMETRIC_HIGH_UNMAPPED', // a batch parked >X% UNMAPPED (likely re-numbering / new joiner)
  // Feature 37 — LMS (Learning) lifecycle fan-out (assignment → completion → cert).
  'learning.assigned':   'HR_LEARNING_ASSIGNED',   // → learner when a course is assigned (mandatory + due date)
  'learning.due-soon':   'HR_LEARNING_DUE_SOON',   // → learner at T-7/T-1 before a mandatory course is due
  'learning.overdue':    'HR_LEARNING_OVERDUE',    // → learner when a mandatory course is past its due date
  'learning.completed':  'HR_LEARNING_COMPLETED',  // → learner when a course reaches COMPLETED
  'learning.cert-ready': 'HR_LEARNING_CERT_READY', // → learner when the completion certificate is minted to the vault
  // Feature 33 — Pulse Surveys + eNPS listening fan-out.
  'survey.invited':  'HR_SURVEY_INVITED',  // → each audience employee when an occurrence opens
  'survey.reminder': 'HR_SURVEY_REMINDER', // → non-responders past ~50% of an open window
  'survey.closed':   'HR_SURVEY_CLOSED',   // → the author when a survey/occurrence closes (with tally)
  // Feature 35 — Rewards & Recognition lifecycle fan-out.
  'recognition.received':        'HR_RECOGNITION_RECEIVED',        // → each recipient when a recognition posts
  'recognition.points-posted':   'HR_RECOGNITION_POINTS_POSTED',   // → employee on a non-recognition points credit (award / adjustment)
  'recognition.budget-low':      'HR_RECOGNITION_BUDGET_LOW',      // → giver when their period budget runs low
  'award.nomination-submitted':  'HR_AWARD_NOMINATION_SUBMITTED',  // → nominator confirmation on submit
  'award.won':                   'HR_AWARD_WON',                   // → the winner (with certificate note)
  'redemption.approved':         'HR_REDEMPTION_APPROVED',         // → employee when points are debited (approved)
  'redemption.fulfilled':        'HR_REDEMPTION_FULFILLED',        // → employee when the reward is fulfilled (voucher/perk)
  // Feature 36 — Candidate Communication (ATS polish). Candidate-facing stage
  // messages (fan out via candidateNotify.js) + the interview panel/feedback keys.
  'candidate.applied':          'HR_CAND_APPLIED',            // → candidate acknowledgement on public apply
  'candidate.shortlisted':      'HR_CAND_SHORTLISTED',        // → candidate on a shortlist/interview move
  'candidate.interview_invite': 'HR_CAND_INTERVIEW_INVITE',   // → candidate when invited to interview (replaces interview_invitation)
  'candidate.slot_request':     'HR_CAND_SLOT_REQUEST',       // → candidate to pick a proposed interview slot
  'candidate.rejected':         'HR_CAND_REJECTED',           // → candidate on rejection (auto-send OFF by default)
  'candidate.offer':            'HR_CAND_OFFER',              // → candidate when an offer is sent (fires from sendOffer)
  'interview.panel_notice':     'HR_INTERVIEW_PANEL',         // → each panellist Employee (replaces interview_panel_notice)
  'interview.feedback_nudge':   'HR_INTERVIEW_FEEDBACK_NUDGE', // → panellist with an un-submitted scorecard past the grace window
});

// HR template registry. vertical: 'HR' so listTemplates({vertical:'HR'}) scopes
// them. All keep a sender tag so the recipient can identify the business.
const HR_TEMPLATES = Object.freeze([
  // Feature 36 — the interview invite/panel keys are now the proper HR_* templates
  // (HR_CAND_INTERVIEW_INVITE + HR_INTERVIEW_PANEL, defined below). The former
  // lowercase 'interview_invitation'/'interview_panel_notice' stubs are retired:
  // inviteInterview() has been repointed at the new event keys (§4.1/§5).
  {
    key: 'HR_PAYSLIP_PUBLISHED',
    displayName: 'Payslip published',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your payslip for {PERIOD} is ready. Net pay {AMT}. View: {LINK} - {BIZ}',
    variables: ['NAME', 'PERIOD', 'AMT', 'LINK', 'BIZ'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_LEAVE_APPROVED',
    displayName: 'Leave request approved',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your {TYPE} leave from {START} to {END} ({DAYS} day(s)) is approved by {APPROVER}. - {BIZ}',
    variables: ['NAME', 'TYPE', 'START', 'END', 'DAYS', 'APPROVER', 'BIZ'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_PAYRUN_COMPUTED',
    displayName: 'Pay run computed (operator)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: '{BIZ}: Pay run {RUN} for {PERIOD} computed. {HEADCOUNT} employees, net {AMT}. Review + approve: {LINK}',
    variables: ['BIZ', 'RUN', 'PERIOD', 'HEADCOUNT', 'AMT', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_FILING_DUE',
    displayName: 'Statutory filing due',
    category: 'SERVICE',
    vertical: 'HR',
    body: '{BIZ}: {FILING} filing for {PERIOD} is due on {DUE}. Generate + file: {LINK}',
    variables: ['BIZ', 'FILING', 'PERIOD', 'DUE', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  // ─── Feature 23 — Statutory Compliance Calendar reminder cron ───
  {
    key: 'HR_COMPLIANCE_REMINDER',
    displayName: 'Statutory compliance reminder (T-minus)',
    category: 'SERVICE',
    vertical: 'HR',
    body: '{BIZ}: {FORM} for {PERIOD} is due on {DUE} ({DAYS} day(s) left). Mark filed: {LINK}',
    variables: ['BIZ', 'FORM', 'PERIOD', 'DUE', 'DAYS', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_COMPLIANCE_OVERDUE',
    displayName: 'Statutory compliance OVERDUE',
    category: 'SERVICE',
    vertical: 'HR',
    body: '{BIZ}: {FORM} for {PERIOD} is OVERDUE (was due {DUE}). Interest/penalty accrues. File now: {LINK}',
    variables: ['BIZ', 'FORM', 'PERIOD', 'DUE', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_OFFER_SENT',
    displayName: 'Offer letter sent',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, {BIZ} has sent you an offer for {ROLE}. Review + accept by {EXPIRY}: {LINK}',
    variables: ['NAME', 'BIZ', 'ROLE', 'EXPIRY', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  // ─── Feature 22 — Statutory Bonus ───
  {
    key: 'HR_BONUS_COMPUTED',
    displayName: 'Statutory bonus computed (operator)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: '{BIZ}: Statutory bonus for {YEAR} computed. {COUNT} eligible, total {AMT}. Review + approve: {LINK}',
    variables: ['BIZ', 'YEAR', 'COUNT', 'AMT', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_BONUS_PUBLISHED',
    displayName: 'Statutory bonus published (employee)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your statutory bonus for {YEAR} is {AMT}. View your bonus slip: {LINK} - {BIZ}',
    variables: ['NAME', 'YEAR', 'AMT', 'LINK', 'BIZ'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  // ─── Cycle 0 — approval engine + SLA fan-out (India-first copy) ───────────
  {
    key: 'HR_APPROVAL_PENDING',
    displayName: 'Approval pending (to approver)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, a {MODULE} request from {REQUESTER} is awaiting your approval on {BIZ}. Review + decide: {LINK}',
    variables: ['NAME', 'MODULE', 'REQUESTER', 'BIZ', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_APPROVAL_DECIDED',
    displayName: 'Approval decided (to requester)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your {MODULE} request has been {OUTCOME} by {DECIDER} on {BIZ}. Details: {LINK}',
    variables: ['NAME', 'MODULE', 'OUTCOME', 'DECIDER', 'BIZ', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_APPROVAL_REMINDER',
    displayName: 'Approval SLA reminder (to approver)',
    category: 'SERVICE',
    vertical: 'HR',
    body: 'Reminder from {BIZ}: a {MODULE} request from {REQUESTER} is still awaiting your approval. Please act: {LINK}',
    variables: ['MODULE', 'REQUESTER', 'BIZ', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  // ─── Cycle 1 — HR Helpdesk ticket lifecycle (India-first copy) ────────────
  {
    key: 'HR_HELPDESK_CREATED',
    displayName: 'Helpdesk ticket created (to HR/assignee)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'New {PRIORITY} support ticket {CODE} from {REQUESTER} on {BIZ}: "{SUBJECT}". Pick it up: {LINK}',
    variables: ['PRIORITY', 'CODE', 'REQUESTER', 'BIZ', 'SUBJECT', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_HELPDESK_ASSIGNED',
    displayName: 'Helpdesk ticket assigned (to assignee)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, support ticket {CODE} ("{SUBJECT}") was assigned to you on {BIZ}. Open it: {LINK}',
    variables: ['NAME', 'CODE', 'SUBJECT', 'BIZ', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_HELPDESK_REPLIED',
    displayName: 'Helpdesk ticket new reply (to the other party)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, there is a new reply on support ticket {CODE} ("{SUBJECT}") from {BIZ}. Read + respond: {LINK}',
    variables: ['NAME', 'CODE', 'SUBJECT', 'BIZ', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_HELPDESK_RESOLVED',
    displayName: 'Helpdesk ticket resolved/closed (to requester)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your support ticket {CODE} ("{SUBJECT}") is now {STATUS} on {BIZ}. View + rate: {LINK}',
    variables: ['NAME', 'CODE', 'SUBJECT', 'STATUS', 'BIZ', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  // ─── Cycle 1 — engagement: announcements + celebrations (India-first copy) ────
  {
    key: 'HR_ANNOUNCEMENT_PUBLISHED',
    displayName: 'New announcement published',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, {BIZ} posted a new announcement: "{TITLE}". Read it on your portal: {LINK}',
    variables: ['NAME', 'BIZ', 'TITLE', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_BIRTHDAY',
    displayName: 'Birthday wishes',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Happy Birthday {NAME}! Wishing you a wonderful year ahead. - {BIZ}',
    variables: ['NAME', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_ANNIVERSARY',
    displayName: 'Work anniversary wishes',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Congratulations {NAME} on {YEARS} year(s) with {BIZ}! Thank you for everything you do.',
    variables: ['NAME', 'YEARS', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  // ─── Program P1.4 — probation sweep ───
  {
    key: 'HR_PROBATION_ENDING',
    displayName: 'Probation ending soon (manager/HR)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Probation review due: {employeeName} completes probation on {endDate} ({days} days from now). Please confirm or extend from the HR console.',
    variables: ['employeeName', 'endDate', 'days'],
    channels: { sms: false, whatsapp: false, email: true },
  },
  {
    key: 'HR_PROBATION_CONFIRMED',
    displayName: 'Probation confirmed (employee)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Congratulations {employeeName}! Your probation has been successfully completed and your employment is confirmed effective {effectiveDate}.',
    variables: ['employeeName', 'effectiveDate'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  // ─── Program Phase 2 — e-sign signer invite (approval-gated dispatch) ───
  {
    key: 'HR_ESIGN_INVITE',
    displayName: 'E-sign invitation (signer)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {signerName}, you have a document to sign: "{subject}". Sign here: {link}',
    variables: ['signerName', 'subject', 'link'],
    channels: { sms: false, whatsapp: false, email: true },
  },
  // ─── Program P1.7 — document expiry sweep ───
  {
    key: 'HR_DOCUMENT_EXPIRING_SOON',
    displayName: 'Document expiring soon',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Document expiry notice: {docName} for {employeeName} expires on {expiryDate} ({days} day(s) from now). Please renew and upload the updated document.',
    variables: ['employeeName', 'docName', 'expiryDate', 'days'],
    channels: { sms: false, whatsapp: false, email: true },
  },
  // ─── Feature 4 — Employee portal invitation ───
  // Welcome + set-password link for a new hire to claim their ESS login. India
  // -first copy (warm, direct); the link is the tenant set-password page carrying
  // the single-use token. {EMAIL} reminds them their login IS their work email.
  {
    key: 'HR_PORTAL_INVITE',
    displayName: 'Employee portal invite',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Welcome to {BIZ}, {NAME}! Set your password to access your employee portal: {LINK} — Your login is {EMAIL}. This link expires on {EXPIRY}.',
    variables: ['NAME', 'BIZ', 'EMAIL', 'LINK', 'EXPIRY'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  // ─── Feature 20 — Investment-proof workflow ───
  {
    key: 'HR_PROOF_WINDOW_OPEN',
    displayName: 'Investment-proof window open',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, the investment-proof window for FY {FY} is now open at {BIZ}. Upload your 80C/HRA/home-loan proofs by {DEADLINE}: {LINK}',
    variables: ['NAME', 'FY', 'BIZ', 'DEADLINE', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_PROOF_REMINDER',
    displayName: 'Investment-proof reminder',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Reminder {NAME}: submit your investment proofs for FY {FY} by {DEADLINE}. Unverified investments will be excluded from your TDS. {LINK} — {BIZ}',
    variables: ['NAME', 'FY', 'DEADLINE', 'LINK', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_PROOF_DEADLINE',
    displayName: 'Investment-proof deadline passed',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, the proof deadline for FY {FY} has passed. Only HR-verified investments now reduce your TDS — {AMOUNT} of declared investments remains unverified and is excluded. Your March salary may have higher tax. {BIZ}',
    variables: ['NAME', 'FY', 'AMOUNT', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_PROOF_ACCEPTED',
    displayName: 'Investment proof accepted',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your {CLAIM} proof for FY {FY} was verified by HR for {AMOUNT}. {BIZ}',
    variables: ['NAME', 'CLAIM', 'FY', 'AMOUNT', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_PROOF_REJECTED',
    displayName: 'Investment proof rejected',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your {CLAIM} proof for FY {FY} was not accepted: {REASON}. Please re-upload before the deadline so it counts toward your TDS. {LINK} — {BIZ}',
    variables: ['NAME', 'CLAIM', 'FY', 'REASON', 'LINK', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  // ─── Feature 30 — Comp-off lifecycle ───
  {
    key: 'HR_COMP_OFF_EARNED',
    displayName: 'Comp-off earned',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, you earned {DAYS} comp-off day(s) for working {SOURCE} on {DATE}. Use them by {EXPIRES}. — {BIZ}',
    variables: ['NAME', 'DAYS', 'SOURCE', 'DATE', 'EXPIRES', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_COMP_OFF_EARN_PENDING',
    displayName: 'Comp-off awaiting approval (manager)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: '{BIZ}: {EMP} worked {SOURCE} on {DATE} and a {DAYS}-day comp-off credit awaits your approval. Review: {LINK}',
    variables: ['BIZ', 'EMP', 'SOURCE', 'DATE', 'DAYS', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_COMP_OFF_EXPIRING_SOON',
    displayName: 'Comp-off expiring soon',
    category: 'SERVICE',
    vertical: 'HR',
    body: 'Hi {NAME}, {DAYS} comp-off day(s) expire on {EXPIRES} ({LEFT} day(s) left). Apply soon so you do not lose them. — {BIZ}',
    variables: ['NAME', 'DAYS', 'EXPIRES', 'LEFT', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_COMP_OFF_LAPSED',
    displayName: 'Comp-off lapsed',
    category: 'SERVICE',
    vertical: 'HR',
    body: 'Hi {NAME}, {DAYS} unused comp-off day(s) lapsed on {EXPIRES}. — {BIZ}',
    variables: ['NAME', 'DAYS', 'EXPIRES', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  // ─── Feature 31 — In-service leave encashment ───
  {
    key: 'HR_LEAVE_ENCASH_REQUESTED',
    displayName: 'Leave encashment requested (approver)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: '{BIZ}: {NAME} requested to encash {DAYS} {TYPE} day(s) (≈ {AMT}, taxable). Review + approve: {LINK}',
    variables: ['BIZ', 'NAME', 'DAYS', 'TYPE', 'AMT', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_LEAVE_ENCASH_APPROVED',
    displayName: 'Leave encashment approved',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your encashment of {DAYS} {TYPE} day(s) is approved (≈ {AMT}, fully taxable — TDS applies). It pays in your next payslip. — {BIZ}',
    variables: ['NAME', 'DAYS', 'TYPE', 'AMT', 'BIZ'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_LEAVE_ENCASH_REJECTED',
    displayName: 'Leave encashment rejected',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your request to encash {DAYS} {TYPE} day(s) was not approved. Your leave balance is unchanged. — {BIZ}',
    variables: ['NAME', 'DAYS', 'TYPE', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_LEAVE_ENCASH_PAID',
    displayName: 'Leave encashment paid',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, {AMT} leave encashment was paid in your {PERIOD} payslip (taxable as salary; Section 89 relief may apply). View: {LINK} — {BIZ}',
    variables: ['NAME', 'AMT', 'PERIOD', 'LINK', 'BIZ'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  // ─── Feature 28 — Biometric ingestion watchdog ───
  {
    key: 'HR_BIOMETRIC_DEVICE_SILENT',
    displayName: 'Biometric device silent',
    category: 'SERVICE',
    vertical: 'HR',
    body: '{BIZ}: biometric device {DEVICE} ({SITE}) has sent no punches for {MINUTES} min (last seen {LASTSEEN}). Check the terminal: {LINK}',
    variables: ['BIZ', 'DEVICE', 'SITE', 'MINUTES', 'LASTSEEN', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_BIOMETRIC_HIGH_UNMAPPED',
    displayName: 'Biometric high unmapped rate',
    category: 'SERVICE',
    vertical: 'HR',
    body: '{BIZ}: {PCT}% of a punch batch from {DEVICE} ({COUNT} rows) had no employee mapping. Map the codes + reprocess: {LINK}',
    variables: ['BIZ', 'DEVICE', 'PCT', 'COUNT', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  // Feature 37 — LMS (Learning) lifecycle templates.
  {
    key: 'HR_LEARNING_ASSIGNED',
    displayName: 'Training assigned',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, you have been assigned the training "{COURSE}". Due by {DUE}. Start now: {LINK} - {BIZ}',
    variables: ['NAME', 'COURSE', 'DUE', 'LINK', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_LEARNING_DUE_SOON',
    displayName: 'Training due soon',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Reminder {NAME}: your training "{COURSE}" is due on {DUE}. Please complete it: {LINK} - {BIZ}',
    variables: ['NAME', 'COURSE', 'DUE', 'LINK', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_LEARNING_OVERDUE',
    displayName: 'Training overdue',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Action needed {NAME}: your mandatory training "{COURSE}" was due on {DUE} and is now overdue. Complete it: {LINK} - {BIZ}',
    variables: ['NAME', 'COURSE', 'DUE', 'LINK', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_LEARNING_COMPLETED',
    displayName: 'Training completed',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Well done {NAME}! You have completed the training "{COURSE}". - {BIZ}',
    variables: ['NAME', 'COURSE', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_LEARNING_CERT_READY',
    displayName: 'Training certificate ready',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your certificate for "{COURSE}" (Ref {REF}) is ready in your document vault. Download: {LINK} - {BIZ}',
    variables: ['NAME', 'COURSE', 'REF', 'LINK', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  // ─── Feature 33 — Pulse Surveys + eNPS (employee listening) ───
  // Lowercase variable names (probation-template convention). {anonymityNote} carries
  // the "your responses are anonymous…" line only for anonymous surveys.
  {
    key: 'HR_SURVEY_INVITED',
    displayName: 'Survey invitation (employee)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {employeeName}, {businessName} invites you to a short survey: "{surveyTitle}". It closes on {closesOn}. {anonymityNote} Fill it here: {link}',
    variables: ['employeeName', 'businessName', 'surveyTitle', 'closesOn', 'anonymityNote', 'link'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_SURVEY_REMINDER',
    displayName: 'Survey reminder (non-responder)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Reminder {employeeName}: the survey "{surveyTitle}" closes on {closesOn}. It only takes a few minutes: {link}',
    variables: ['employeeName', 'surveyTitle', 'closesOn', 'link'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_SURVEY_CLOSED',
    displayName: 'Survey closed (author)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Survey "{surveyTitle}" (run #{occurrenceSeq}) has closed with {responseCount} response(s) — {responseRate}% of {invitedCount} invited. View the results: {link}',
    variables: ['surveyTitle', 'occurrenceSeq', 'responseCount', 'responseRate', 'invitedCount', 'link'],
    channels: { sms: false, whatsapp: false, email: true },
  },
  // ─── Feature 35 — Rewards & Recognition ───
  {
    key: 'HR_RECOGNITION_RECEIVED',
    displayName: 'Recognition received (kudos)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, {GIVER} recognised you{VALUE}{POINTS} at {BIZ}: "{MESSAGE}". See it on the wall: {LINK}',
    variables: ['NAME', 'GIVER', 'VALUE', 'POINTS', 'MESSAGE', 'BIZ', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_RECOGNITION_POINTS_POSTED',
    displayName: 'Points credited to wallet',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, {POINTS} point(s) were credited to your rewards wallet ({REASON}). Balance: {BALANCE}. {LINK} - {BIZ}',
    variables: ['NAME', 'POINTS', 'REASON', 'BALANCE', 'LINK', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_RECOGNITION_BUDGET_LOW',
    displayName: 'Recognition budget running low (giver)',
    category: 'SERVICE',
    vertical: 'HR',
    body: 'Hi {NAME}, your recognition budget for this {PERIOD} is running low: {REMAINING} of {ALLOCATED} point(s) left. - {BIZ}',
    variables: ['NAME', 'PERIOD', 'REMAINING', 'ALLOCATED', 'BIZ'],
    channels: { sms: false, whatsapp: false, email: true },
  },
  {
    key: 'HR_AWARD_NOMINATION_SUBMITTED',
    displayName: 'Award nomination submitted (nominator)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your nomination of {NOMINEE} for "{AWARD}" was submitted. The committee will review it after nominations close on {CLOSES}. - {BIZ}',
    variables: ['NAME', 'NOMINEE', 'AWARD', 'CLOSES', 'BIZ'],
    channels: { sms: false, whatsapp: false, email: true },
  },
  {
    key: 'HR_AWARD_WON',
    displayName: 'Award won (winner)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Congratulations {NAME}! You have won "{AWARD}"{POINTS} at {BIZ}. {CERT} {LINK}',
    variables: ['NAME', 'AWARD', 'POINTS', 'CERT', 'BIZ', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_REDEMPTION_APPROVED',
    displayName: 'Redemption approved (points debited)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your redemption of "{ITEM}" ({POINTS} points) is approved. You will be notified when it is fulfilled. Balance: {BALANCE}. - {BIZ}',
    variables: ['NAME', 'ITEM', 'POINTS', 'BALANCE', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_REDEMPTION_FULFILLED',
    displayName: 'Redemption fulfilled (voucher/perk delivered)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, your reward "{ITEM}" is ready{REF}. Enjoy! - {BIZ}',
    variables: ['NAME', 'ITEM', 'REF', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  // ─── Feature 36 — Candidate Communication (ATS polish) ───
  // Candidate-facing stage messages + interview panel/feedback nudges. Copy is
  // market-agnostic; {LINK} is the tokenised public status page (…/careers/:slug
  // /c/:token). These 8 keys are the candidate-template library (HR-editable copy;
  // system templates, editable but not deletable). HR_CAND_INTERVIEW_INVITE +
  // HR_INTERVIEW_PANEL REPLACE the unregistered interview_invitation /
  // interview_panel_notice keys that were silently failing UNKNOWN_TEMPLATE.
  {
    key: 'HR_CAND_APPLIED',
    displayName: 'Candidate — application received',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: "Hi {NAME}, thanks for applying to {ROLE} at {BIZ}. We've received your application — track it here: {LINK}",
    variables: ['NAME', 'ROLE', 'BIZ', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_CAND_SHORTLISTED',
    displayName: 'Candidate — shortlisted',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: "Hi {NAME}, good news — you've been shortlisted for {ROLE} at {BIZ}. We'll be in touch about next steps. {LINK}",
    variables: ['NAME', 'ROLE', 'BIZ', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_CAND_INTERVIEW_INVITE',
    displayName: 'Candidate — interview invitation',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: "Hi {NAME}, you're invited to interview for {ROLE} at {BIZ} ({MODE}). {SLOTLINE} Details + calendar: {LINK}",
    variables: ['NAME', 'ROLE', 'BIZ', 'MODE', 'SLOTLINE', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_CAND_SLOT_REQUEST',
    displayName: 'Candidate — pick an interview slot',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, please pick an interview slot for {ROLE} at {BIZ}: {LINK}',
    variables: ['NAME', 'ROLE', 'BIZ', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_CAND_REJECTED',
    displayName: 'Candidate — not selected',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: "Hi {NAME}, thank you for your interest in {ROLE} at {BIZ}. We won't be moving forward this time. We wish you the best.",
    variables: ['NAME', 'ROLE', 'BIZ'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_CAND_OFFER',
    displayName: 'Candidate — offer sent',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: 'Hi {NAME}, {BIZ} has sent you an offer for {ROLE}. Review + respond by {EXPIRY}: {LINK}',
    variables: ['NAME', 'BIZ', 'ROLE', 'EXPIRY', 'LINK'],
    channels: { sms: true, whatsapp: true, email: true },
  },
  {
    key: 'HR_INTERVIEW_PANEL',
    displayName: 'Interview panel notice (interviewer)',
    category: 'TRANSACTIONAL',
    vertical: 'HR',
    body: "Hi {NAME}, you're on the panel for {ROLE} on {WHEN}. Open scorecard: {LINK}",
    variables: ['NAME', 'ROLE', 'WHEN', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
  {
    key: 'HR_INTERVIEW_FEEDBACK_NUDGE',
    displayName: 'Interview feedback nudge (interviewer)',
    category: 'SERVICE',
    vertical: 'HR',
    body: 'Reminder: your scorecard for {CANDIDATE} ({ROLE}, interviewed {WHEN}) is still pending. Submit: {LINK}',
    variables: ['CANDIDATE', 'ROLE', 'WHEN', 'LINK'],
    channels: { sms: false, whatsapp: true, email: true },
  },
]);

// Register HR templates into the SHARED core registry so the router's
// getTemplate()/render() resolve HR keys (without forking the router). Idempotent —
// safe to run at every module load. This is the single fix that lets ANY HR templated
// notification (the original 5 + the 3 new approval ones) actually leave the router
// instead of failing UNKNOWN_TEMPLATE.
registerTemplates(HR_TEMPLATES);

// ---------------------------------------------------------------------------
//  DB sync — same shape/semantics as core seedTemplates(), HR-scoped.
//  Preserves provider IDs + approval status set externally (DLT/Twilio).
// ---------------------------------------------------------------------------
async function seedHrTemplates({ logger = console } = {}) {
  let created = 0;
  let updated = 0;

  for (let i = 0; i < HR_TEMPLATES.length; i++) {
    const t = HR_TEMPLATES[i];
    const existing = await prisma.messageTemplate.findUnique({ where: { templateKey: t.key } });
    const data = {
      templateKey:     t.key,
      displayName:     t.displayName,
      category:        t.category,
      vertical:        t.vertical,
      body:            t.body,
      variables:       t.variables,
      smsEnabled:      t.channels.sms,
      whatsappEnabled: t.channels.whatsapp,
      emailEnabled:    t.channels.email,
      // Offset sortOrder so HR templates sit after core ones.
      sortOrder:       1000 + i,
      isActive:        true,
    };
    if (existing) {
      await prisma.messageTemplate.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.messageTemplate.create({ data: { ...data, approvalStatus: 'DRAFT' } });
      created++;
    }
  }

  logger.log?.(`[hr-templates] seedHrTemplates: created=${created} updated=${updated}`);
  return { created, updated };
}

// ---------------------------------------------------------------------------
//  Registry access (mirrors core templates.js helpers, HR-scoped)
// ---------------------------------------------------------------------------
function listHrTemplates() {
  return HR_TEMPLATES.slice();
}

function templateKeyForEvent(event) {
  return HR_EVENT_TEMPLATES[event] || null;
}

/** Render an HR template body (pure). Throws on unknown key / missing vars —
 *  delegates to the core renderer once templates are registered in-process. */
function renderHr({ key, vars }) {
  // The core render() reads from its own TEMPLATES registry which won't have HR
  // keys at module-eval time. Render directly from HR_TEMPLATES for purity.
  const tpl = HR_TEMPLATES.find((t) => t.key === key);
  if (!tpl) {
    const err = new Error(`Unknown HR template key: ${key}`);
    err.code = 'UNKNOWN_TEMPLATE';
    throw err;
  }
  const missing = tpl.variables.filter((v) => !(v in (vars || {})));
  if (missing.length) {
    const err = new Error(`Missing variables for ${key}: ${missing.join(', ')}`);
    err.code = 'MISSING_VARIABLES';
    err.missing = missing;
    throw err;
  }
  let body = tpl.body;
  for (const [name, value] of Object.entries(vars)) {
    body = body.split(`{${name}}`).join(String(value));
  }
  return body;
}

/**
 * notifyHrEvent — send a templated HR notification via the EXISTING router.
 * Never throws (router doesn't); returns the router result.
 *
 * @param {object} args
 *   { businessId, event, recipientPhone, recipientEmail, recipientCountry,
 *     variables, triggeredBy }
 */
async function notifyHrEvent({
  businessId,
  event,
  templateKey,
  recipientPhone,
  recipientEmail,
  recipientCountry,
  variables = {},
  triggeredBy,
}) {
  const key = templateKey || templateKeyForEvent(event);
  if (!key) {
    // This function NEVER THROWS by design, so a failure comes back as a result
    // object — and no caller anywhere inspects it. ~40 call sites wrap it in
    // `.catch(() => {})`, which is harmless (nothing is thrown) but also means a
    // notification that was never sent leaves no trace at all.
    //
    // The people who notice are the ones who never got told: an employee whose
    // comp-off is about to lapse, a manager sitting on an unapproved request, a
    // candidate waiting on an interview invite. Log it here, once, rather than at
    // every call site.
    console.warn(`[notify] no template for event "${event}" (business ${businessId}) — NOTHING WAS SENT to ${recipientEmail || recipientPhone || 'unknown recipient'}`);
    return { ok: false, reason: 'NO_TEMPLATE_FOR_EVENT' };
  }
  const result = await sendNotification({
    businessId,
    recipientPhone,
    recipientEmail,
    recipientCountry,
    templateKey: key,
    variables,
    triggeredBy: triggeredBy || `HR_${(event || key).toUpperCase()}`,
  });
  if (result && result.ok === false) {
    console.warn(`[notify] event "${event}" for business ${businessId} was NOT delivered: ${result.reason || 'unknown reason'}`);
  }
  return result;
}

module.exports = {
  HR_TEMPLATES,
  HR_EVENT_TEMPLATES,
  seedHrTemplates,
  listHrTemplates,
  templateKeyForEvent,
  renderHr,
  notifyHrEvent,
  // re-export the core renderer for callers that have seeded both registries
  render,
};
