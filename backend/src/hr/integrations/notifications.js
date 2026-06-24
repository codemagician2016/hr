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
});

// HR template registry. vertical: 'HR' so listTemplates({vertical:'HR'}) scopes
// them. All keep a sender tag so the recipient can identify the business.
const HR_TEMPLATES = Object.freeze([
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
  if (!key) return { ok: false, reason: 'NO_TEMPLATE_FOR_EVENT' };
  return sendNotification({
    businessId,
    recipientPhone,
    recipientEmail,
    recipientCountry,
    templateKey: key,
    variables,
    triggeredBy: triggeredBy || `HR_${(event || key).toUpperCase()}`,
  });
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
