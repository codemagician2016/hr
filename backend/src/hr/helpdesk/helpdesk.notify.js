'use strict';

/**
 * helpdesk.notify.js — best-effort F10 notification fan-out for helpdesk ticket
 * events. Wraps notifyHrEvent (integrations/notifications.js) with the helpdesk
 * variables + a deep link. NEVER throws into the request path (mirrors the approvals
 * fan-out contract); a recipient lookup / send failure is swallowed so a ticket
 * action always succeeds even if the notice cannot leave.
 *
 * Events (registered in HR_EVENT_TEMPLATES):
 *   helpdesk.created  → the assignee (or HR queue contact) on raise
 *   helpdesk.assigned → the new assignee on (re)assignment
 *   helpdesk.replied  → the OTHER party (requester ↔ assignee) on a new reply
 *   helpdesk.resolved → the requester on resolve / close
 */

// Import the MODULE (not a destructured ref) so the dispatcher is resolved late —
// keeps notifyHrEvent spy-able in tests and consistent with a future re-export swap.
const notifications = require('../integrations/notifications');
const svc = require('./helpdesk.service');

const BIZ = 'DriftHR';

// Deep links — the ESS app routes /helpdesk; the operator console routes /helpdesk.
const essLink = (id) => `/helpdesk?ticket=${id}`;
const adminLink = (id) => `/helpdesk/${id}`;

async function send(recipient, { businessId, event, variables, token }) {
  if (!recipient || (!recipient.email && !recipient.phone)) return { ok: false, reason: 'NO_CONTACT' };
  try {
    return await notifications.notifyHrEvent({
      businessId,
      event,
      recipientEmail: recipient.email || null,
      recipientPhone: recipient.phone || null,
      recipientCountry: recipient.country || undefined,
      variables,
      triggeredBy: token,
    });
  } catch (e) {
    return { ok: false, reason: 'DISPATCH_ERROR', error: e && e.message };
  }
}

/** A ticket was raised — notify the assignee (named) if one is set; otherwise this is
 *  a no-op (the queue is polled). Best-effort. */
async function onCreated({ businessId, ticket, requesterName }) {
  if (!ticket.assigneeId) return { ok: false, reason: 'NO_ASSIGNEE' };
  const recipient = await svc.recipientForUser(businessId, ticket.assigneeId);
  return send(recipient, {
    businessId, event: 'helpdesk.created',
    variables: { PRIORITY: ticket.priority, CODE: ticket.code, REQUESTER: requesterName || 'an employee', BIZ, SUBJECT: ticket.subject, LINK: adminLink(ticket.id) },
    token: `HR_HD_NEW:${ticket.id}`,
  });
}

/** Ticket (re)assigned — notify the new assignee. */
async function onAssigned({ businessId, ticket }) {
  if (!ticket.assigneeId) return { ok: false, reason: 'NO_ASSIGNEE' };
  const recipient = await svc.recipientForUser(businessId, ticket.assigneeId);
  return send(recipient, {
    businessId, event: 'helpdesk.assigned',
    variables: { NAME: (recipient && recipient.name) || 'there', CODE: ticket.code, SUBJECT: ticket.subject, BIZ, LINK: adminLink(ticket.id) },
    token: `HR_HD_ASSIGN:${ticket.id}:${ticket.assigneeId}`,
  });
}

/** New reply — notify the OTHER party. authorIsEmployee=true → notify assignee;
 *  false (HR replied) → notify the requester employee. Internal notes never notify. */
async function onReplied({ businessId, ticket, authorIsEmployee, messageId }) {
  let recipient = null;
  let link = adminLink(ticket.id);
  if (authorIsEmployee) {
    // employee → notify the HR assignee
    if (!ticket.assigneeId) return { ok: false, reason: 'NO_ASSIGNEE' };
    recipient = await svc.recipientForUser(businessId, ticket.assigneeId);
  } else {
    // HR → notify the requester (ESS deep link)
    recipient = await svc.recipientForEmployee(businessId, ticket.employeeId);
    link = essLink(ticket.id);
  }
  return send(recipient, {
    businessId, event: 'helpdesk.replied',
    variables: { NAME: (recipient && recipient.name) || 'there', CODE: ticket.code, SUBJECT: ticket.subject, BIZ, LINK: link },
    token: `HR_HD_REPLY:${messageId || ticket.id}`,
  });
}

/** Resolved / closed — notify the requester (ESS, so they can rate). */
async function onResolved({ businessId, ticket }) {
  const recipient = await svc.recipientForEmployee(businessId, ticket.employeeId);
  return send(recipient, {
    businessId, event: 'helpdesk.resolved',
    variables: { NAME: (recipient && recipient.name) || 'there', CODE: ticket.code, SUBJECT: ticket.subject, STATUS: ticket.status, BIZ, LINK: essLink(ticket.id) },
    token: `HR_HD_RESOLVE:${ticket.id}:${ticket.status}`,
  });
}

module.exports = { onCreated, onAssigned, onReplied, onResolved };
