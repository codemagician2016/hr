'use strict';

/**
 * helpdesk.service.js — HR Helpdesk (ticketing) domain core (Cycle 1).
 *
 * Wires the previously-orphaned HelpdeskCategory / HelpdeskTicket / HelpdeskMessage
 * schema. This module holds the PURE, DB-light pieces shared by the operator console
 * (tickets.controller.js) and ESS self-service (meHelpdesk.controller.js):
 *
 *   - the status-lifecycle transition table + a guard (canTransition),
 *   - SLA due-date computation (category.slaHours, then a priority default),
 *   - HD-###### human-code minting (allocateCode scope 'HD', inside the caller tx),
 *   - recipient contact resolution for the F10 notification fan-out (notifyHrEvent),
 *   - a safe employee/assignee display label.
 *
 * Tenant isolation: every helper that touches the DB takes businessId and filters on
 * it; the controllers add the F1/SELF scope on top. SoD is NOT critical for helpdesk
 * (an HR agent may act on any in-tenant ticket; the employee is self-scoped).
 */

const prisma = require('../../core/lib/prisma');
const { allocateCode } = require('../lifecycle/lib/codes');

// ── Status lifecycle ─────────────────────────────────────────────────────────
// OPEN → IN_PROGRESS → WAITING_ON_EMPLOYEE (the "on hold / awaiting requester"
// state) → RESOLVED → CLOSED, with REOPENED + CANCELLED side paths. The owner's
// requested "ON_HOLD" maps to the schema's WAITING_ON_EMPLOYEE enum value.
const TICKET_STATUSES = Object.freeze([
  'OPEN', 'IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'RESOLVED', 'CLOSED', 'REOPENED', 'CANCELLED',
]);

// Allowed forward transitions (HR-agent driven unless noted). Self-service reopen +
// close-by-rating are handled as explicit transitions in the ESS controller using
// this same table, so the lifecycle is enforced in ONE place.
const TRANSITIONS = Object.freeze({
  OPEN:                ['IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'RESOLVED', 'CANCELLED'],
  IN_PROGRESS:         ['WAITING_ON_EMPLOYEE', 'RESOLVED', 'CANCELLED'],
  WAITING_ON_EMPLOYEE: ['IN_PROGRESS', 'RESOLVED', 'CANCELLED'],
  RESOLVED:            ['CLOSED', 'REOPENED'],
  REOPENED:            ['IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'RESOLVED', 'CANCELLED'],
  CLOSED:              ['REOPENED'],
  CANCELLED:           [], // terminal
});

const TERMINAL = Object.freeze(new Set(['CLOSED', 'CANCELLED']));

function canTransition(from, to) {
  if (!TICKET_STATUSES.includes(to)) return false;
  if (from === to) return false;
  const allowed = TRANSITIONS[from] || [];
  return allowed.includes(to);
}

// Default SLA hours by priority when a category carries no explicit slaHours.
// India-first business-clock approximation kept simple (wall-clock hours).
const PRIORITY_SLA_HOURS = Object.freeze({ URGENT: 4, HIGH: 8, NORMAL: 24, LOW: 72 });

/** Compute the SLA due timestamp from a base time. category.slaHours wins; else the
 *  per-priority default. Returns null only if priority is unknown (never, defaulted). */
function computeSlaDueAt({ priority = 'NORMAL', categorySlaHours = null, from = new Date() } = {}) {
  const hours = Number.isFinite(categorySlaHours) && categorySlaHours > 0
    ? categorySlaHours
    : (PRIORITY_SLA_HOURS[priority] || PRIORITY_SLA_HOURS.NORMAL);
  return new Date(from.getTime() + hours * 3600 * 1000);
}

/** True when a still-open ticket has blown its SLA (pure, for badge + queue filter). */
function isBreached(ticket, now = new Date()) {
  if (!ticket || !ticket.slaDueAt) return false;
  if (TERMINAL.has(ticket.status) || ticket.status === 'RESOLVED') return false;
  return new Date(ticket.slaDueAt).getTime() < now.getTime();
}

const VALID_PRIORITIES = Object.freeze(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

/** Mint the next HD-###### code for a tenant. MUST run inside the caller's tx. */
async function mintTicketCode(tx, businessId) {
  return allocateCode(tx, { businessId, scope: 'HD' });
}

// ── Notification recipient resolution (for notifyHrEvent) ────────────────────
// Resolve an Employee's contact (email/phone/country) for a templated notification.
function employeeName(emp) {
  if (!emp) return 'there';
  return [emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.code || 'there';
}

async function recipientForEmployee(businessId, employeeId) {
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, code: true, workEmail: true, personalEmail: true, phone: true, countryCode: true },
  });
  if (!emp) return null;
  return {
    employeeId: emp.id,
    name: employeeName(emp),
    email: emp.workEmail || emp.personalEmail || null,
    phone: emp.phone || null,
    country: emp.countryCode || undefined,
  };
}

// Resolve a User (HR agent) → their linked Employee contact, for assignee notices.
async function recipientForUser(businessId, userId) {
  if (!userId) return null;
  const emp = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, userId },
    select: { id: true, firstName: true, lastName: true, code: true, workEmail: true, personalEmail: true, phone: true, countryCode: true },
  });
  if (emp) {
    return { employeeId: emp.id, name: employeeName(emp), email: emp.workEmail || emp.personalEmail || null, phone: emp.phone || null, country: emp.countryCode || undefined };
  }
  // Fall back to the User's own email if there is no linked Employee row.
  const user = await prisma.user.findFirst({ where: { id: userId }, select: { email: true, name: true } });
  if (!user) return null;
  return { employeeId: null, name: user.name || 'there', email: user.email || null, phone: null, country: undefined };
}

module.exports = {
  TICKET_STATUSES,
  TRANSITIONS,
  TERMINAL,
  VALID_PRIORITIES,
  PRIORITY_SLA_HOURS,
  canTransition,
  computeSlaDueAt,
  isBreached,
  mintTicketCode,
  employeeName,
  recipientForEmployee,
  recipientForUser,
};
