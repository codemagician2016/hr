'use strict';

/**
 * meHelpdesk.controller.js — HR Helpdesk EMPLOYEE SELF-SERVICE (Cycle 1).
 *
 * Mounted at /api/hr/me/helpdesk on the CUSTOMER session. SELF-ONLY by construction:
 * the subject employee is resolved ENTIRELY from the session (resolveSelfEmployee) —
 * NO employeeId is accepted from any path/body, so a USER can only ever see / act on
 * their OWN tickets (IDOR-safe). A cross-employee read 404s because the where-clause
 * is always { businessId, employeeId: <self>, ... }. Terminated/inactive employees are
 * locked out (404), matching the F4 ESS-lockout pattern.
 *
 * Internal HR notes (HelpdeskMessage.isInternal) are NEVER returned on this surface.
 * The status lifecycle is the SAME table the operator uses (helpdesk.service), so a
 * self-service reopen / close-on-rate can never violate it.
 */

const prisma = require('../../core/lib/prisma');
const payrollService = require('../payroll/service');
const { writeAudit } = require('../../core/lib/audit');
const svc = require('./helpdesk.service');
const notify = require('./helpdesk.notify');

async function resolveActiveSelfId(req) {
  const { businessId } = req.customer;
  const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null }, select: { id: true, isActive: true } });
  if (!emp || emp.isActive === false) return null;
  return emp.id;
}
const noEmployee = (res) => res.status(404).json({ message: 'No active employee record for this account' });

// Reference data the raise form needs: the active categories (name + sla only).
async function reference(req, res, next) {
  try {
    const { businessId } = req.customer;
    const categories = await prisma.helpdeskCategory.findMany({
      where: { businessId, isActive: true },
      select: { id: true, name: true, slaHours: true },
      orderBy: { name: 'asc' },
    });
    res.json({ categories, priorities: svc.VALID_PRIORITIES });
  } catch (e) { next(e); }
}

// Raise a ticket. Mints HD-###### + computes the SLA due-at from the category (or the
// priority default). If the category carries a defaultAssigneeId it is pre-assigned
// (and the assignee is notified).
async function createTicket(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const b = req.body || {};
    const subject = String(b.subject || '').trim();
    if (!subject) return res.status(400).json({ message: 'subject is required' });
    if (subject.length > 200) return res.status(400).json({ message: 'subject is too long (max 200)' });
    const priority = svc.VALID_PRIORITIES.includes(b.priority) ? b.priority : 'NORMAL';

    let category = null;
    if (b.categoryId) {
      category = await prisma.helpdeskCategory.findFirst({ where: { id: b.categoryId, businessId, isActive: true }, select: { id: true, slaHours: true, defaultAssigneeId: true } });
      if (!category) return res.status(400).json({ message: 'categoryId does not reference an active category' });
    }
    const slaDueAt = svc.computeSlaDueAt({ priority, categorySlaHours: category ? category.slaHours : null });

    // Mint the HD code atomically; P2002 on (businessId, code) → bump + retry.
    let ticket;
    for (let attempt = 0; ; attempt += 1) {
      try {
        ticket = await prisma.$transaction(async (tx) => {
          const code = await svc.mintTicketCode(tx, businessId);
          const created = await tx.helpdeskTicket.create({
            data: {
              businessId, code, employeeId,
              categoryId: category ? category.id : null,
              subject,
              description: b.description ? String(b.description) : null,
              priority, status: 'OPEN',
              assigneeId: category ? category.defaultAssigneeId || null : null,
              slaDueAt,
            },
          });
          // The opening description, if any, is ALSO the first thread message (employee-authored).
          if (b.description && String(b.description).trim()) {
            await tx.helpdeskMessage.create({ data: { businessId, ticketId: created.id, authorUserId: req.customer.id || employeeId, body: String(b.description).trim(), isInternal: false } });
          }
          return created;
        });
        break;
      } catch (e) {
        if (e.code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    await writeAudit({ businessId, actorId: req.customer.id || null, action: 'helpdesk.ticket.create', entityType: 'HelpdeskTicket', entityId: ticket.id, meta: { code: ticket.code, priority, categoryId: ticket.categoryId } });
    // Notify the pre-assigned agent, if any.
    if (ticket.assigneeId) { try { await notify.onCreated({ businessId, ticket, requesterName: req.customer.name || null }); } catch (_) {} }
    res.status(201).json(ticket);
  } catch (e) { next(e); }
}

async function listMyTickets(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return res.json({ items: [], total: 0 });
    const { businessId } = req.customer;
    const where = { businessId, employeeId, deletedAt: null };
    if (req.query.status) where.status = { in: String(req.query.status).split(',') };
    const rows = await prisma.helpdeskTicket.findMany({
      where,
      include: { category: { select: { id: true, name: true } }, _count: { select: { messages: { where: { isInternal: false } } } } },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
    const now = new Date();
    const items = rows.map((t) => ({ ...t, breached: svc.isBreached(t, now) }));
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

async function getMyTicket(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const ticket = await prisma.helpdeskTicket.findFirst({
      where: { id: req.params.id, businessId, employeeId, deletedAt: null },
      include: {
        category: { select: { id: true, name: true, slaHours: true } },
        messages: { where: { isInternal: false }, orderBy: { createdAt: 'asc' } }, // internal notes hidden
      },
    });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    res.json({ ...ticket, breached: svc.isBreached(ticket) });
  } catch (e) { next(e); }
}

// Employee reply to their own ticket. A reply while WAITING_ON_EMPLOYEE pulls the
// ticket back to IN_PROGRESS; the assigned agent is notified.
async function replyMyTicket(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const ticket = await prisma.helpdeskTicket.findFirst({ where: { id: req.params.id, businessId, employeeId, deletedAt: null } });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (svc.TERMINAL.has(ticket.status)) return res.status(409).json({ message: `Ticket is ${ticket.status}; reopen it before replying` });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ message: 'body is required' });

    const message = await prisma.$transaction(async (tx) => {
      const msg = await tx.helpdeskMessage.create({ data: { businessId, ticketId: ticket.id, authorUserId: req.customer.id || employeeId, body, isInternal: false } });
      if (ticket.status === 'WAITING_ON_EMPLOYEE') await tx.helpdeskTicket.update({ where: { id: ticket.id }, data: { status: 'IN_PROGRESS' } });
      return msg;
    });
    await writeAudit({ businessId, actorId: req.customer.id || null, action: 'helpdesk.reply.add', entityType: 'HelpdeskTicket', entityId: ticket.id, meta: { messageId: message.id, by: 'employee' } });
    try { await notify.onReplied({ businessId, ticket, authorIsEmployee: true, messageId: message.id }); } catch (_) {}
    res.status(201).json(message);
  } catch (e) { next(e); }
}

// Reopen a RESOLVED or CLOSED ticket (employee disagrees the issue is fixed).
async function reopenMyTicket(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const ticket = await prisma.helpdeskTicket.findFirst({ where: { id: req.params.id, businessId, employeeId, deletedAt: null } });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (!svc.canTransition(ticket.status, 'REOPENED')) {
      return res.status(409).json({ message: `Only a resolved/closed ticket can be reopened (it is ${ticket.status})` });
    }
    const reason = req.body && req.body.reason ? String(req.body.reason).trim() : null;
    const updated = await prisma.$transaction(async (tx) => {
      const t = await tx.helpdeskTicket.update({ where: { id: ticket.id }, data: { status: 'REOPENED', resolvedAt: null, closedAt: null } });
      if (reason) await tx.helpdeskMessage.create({ data: { businessId, ticketId: ticket.id, authorUserId: req.customer.id || employeeId, body: `Reopened: ${reason}`, isInternal: false } });
      return t;
    });
    await writeAudit({ businessId, actorId: req.customer.id || null, action: 'helpdesk.ticket.reopen', entityType: 'HelpdeskTicket', entityId: ticket.id, meta: { from: ticket.status } });
    try { await notify.onReplied({ businessId, ticket: updated, authorIsEmployee: true, messageId: `reopen:${ticket.id}` }); } catch (_) {}
    res.json({ ...updated, breached: svc.isBreached(updated) });
  } catch (e) { next(e); }
}

// Rate a RESOLVED ticket (1–5) — this is the "satisfaction on close" signal and it
// CLOSES the ticket (RESOLVED → CLOSED). Rating an already-CLOSED ticket just records
// the score without re-transitioning.
async function rateMyTicket(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const ticket = await prisma.helpdeskTicket.findFirst({ where: { id: req.params.id, businessId, employeeId, deletedAt: null } });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (ticket.status !== 'RESOLVED' && ticket.status !== 'CLOSED') {
      return res.status(409).json({ message: 'Only a resolved or closed ticket can be rated' });
    }
    const rating = parseInt((req.body && req.body.rating), 10);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: 'rating must be an integer 1–5' });
    const comment = req.body && req.body.comment ? String(req.body.comment).trim() : null;
    const data = { satisfactionRating: rating, satisfactionComment: comment };
    // Rating a RESOLVED ticket closes it.
    if (ticket.status === 'RESOLVED') { data.status = 'CLOSED'; data.closedAt = new Date(); }
    const updated = await prisma.helpdeskTicket.update({ where: { id: ticket.id }, data });
    await writeAudit({ businessId, actorId: req.customer.id || null, action: 'helpdesk.ticket.rate', entityType: 'HelpdeskTicket', entityId: ticket.id, meta: { rating } });
    res.json({ ...updated, breached: false });
  } catch (e) { next(e); }
}

module.exports = { reference, createTicket, listMyTickets, getMyTicket, replyMyTicket, reopenMyTicket, rateMyTicket };
