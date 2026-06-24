'use strict';

/**
 * tickets.controller.js — HR Helpdesk OPERATOR console (Cycle 1).
 *
 * Mounted at /api/hr/helpdesk on the OPERATOR session, gated by canManageHelpdesk
 * (seeded for Owner + HR-Admin). An agent sees the WHOLE tenant queue (helpdesk is a
 * shared HR inbox, not F1 sub-tree-scoped — a ticket can be raised to "HR" by anyone),
 * can filter/paginate, open a ticket with its full thread, assign it, reply (employee-
 * visible or internal note), and drive the status lifecycle. Every query is tenant-
 * walled on businessId; SoD is not critical here.
 *
 * Status lifecycle is enforced in ONE place (helpdesk.service.canTransition) so the
 * operator + ESS surfaces can never disagree. Notifications + audit are best-effort.
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const svc = require('./helpdesk.service');
const notify = require('./helpdesk.notify');

function paginate(q) {
  const take = Math.min(Math.max(parseInt(q.pageSize, 10) || 25, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  return { take, skip: (page - 1) * take, page };
}

const REQUESTER_SELECT = { id: true, firstName: true, lastName: true, code: true, photoUrl: true, workEmail: true };

// ═══ CATEGORIES ════════════════════════════════════════════════════════════════
async function listCategories(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId };
    if (req.query.activeOnly === 'true') where.isActive = true;
    const items = await prisma.helpdeskCategory.findMany({ where, orderBy: { name: 'asc' } });
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

async function createCategory(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ message: 'name is required' });
    const slaHours = b.slaHours != null && b.slaHours !== '' ? parseInt(b.slaHours, 10) : null;
    if (slaHours != null && (!Number.isFinite(slaHours) || slaHours <= 0)) {
      return res.status(400).json({ message: 'slaHours must be a positive integer' });
    }
    let category;
    try {
      category = await prisma.helpdeskCategory.create({
        data: { businessId, name, slaHours, defaultAssigneeId: b.defaultAssigneeId || null, isActive: b.isActive !== false },
      });
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ message: 'A category with that name already exists' });
      throw e;
    }
    await writeAudit({ businessId, actorId: req.user.id, action: 'helpdesk.category.create', entityType: 'HelpdeskCategory', entityId: category.id, meta: { name } });
    res.status(201).json(category);
  } catch (e) { next(e); }
}

async function updateCategory(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.helpdeskCategory.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Category not found' });
    const b = req.body || {};
    const data = {};
    if (b.name != null) { const n = String(b.name).trim(); if (!n) return res.status(400).json({ message: 'name cannot be empty' }); data.name = n; }
    if (b.slaHours !== undefined) {
      const v = b.slaHours === null || b.slaHours === '' ? null : parseInt(b.slaHours, 10);
      if (v != null && (!Number.isFinite(v) || v <= 0)) return res.status(400).json({ message: 'slaHours must be a positive integer' });
      data.slaHours = v;
    }
    if (b.defaultAssigneeId !== undefined) data.defaultAssigneeId = b.defaultAssigneeId || null;
    if (b.isActive !== undefined) data.isActive = !!b.isActive;
    let category;
    try { category = await prisma.helpdeskCategory.update({ where: { id: existing.id }, data }); }
    catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: 'A category with that name already exists' }); throw e; }
    res.json(category);
  } catch (e) { next(e); }
}

// ═══ TICKETS — QUEUE ═════════════════════════════════════════════════════════════
// The agent queue: the whole tenant's tickets, filterable + paginated (built for 100s).
async function listTickets(req, res, next) {
  try {
    const { businessId } = req.user;
    const { take, skip, page } = paginate(req.query);
    const where = { businessId, deletedAt: null };
    if (req.query.status) where.status = { in: String(req.query.status).split(',') };
    if (req.query.priority) where.priority = { in: String(req.query.priority).split(',') };
    if (req.query.categoryId) where.categoryId = req.query.categoryId;
    if (req.query.assigneeId) where.assigneeId = req.query.assigneeId === 'UNASSIGNED' ? null : req.query.assigneeId;
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    if (req.query.q) {
      const q = String(req.query.q).trim();
      if (q) where.OR = [{ subject: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }];
    }
    // SLA: only OPEN/IN_PROGRESS/WAITING/REOPENED count as breachable (RESOLVED/CLOSED stop the clock).
    if (req.query.breached === 'true') {
      where.slaDueAt = { lt: new Date() };
      where.status = { in: ['OPEN', 'IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'REOPENED'] };
    }
    const [rows, total] = await Promise.all([
      prisma.helpdeskTicket.findMany({
        where,
        include: { employee: { select: REQUESTER_SELECT }, category: { select: { id: true, name: true } }, _count: { select: { messages: true } } },
        orderBy: [{ createdAt: 'desc' }],
        skip, take,
      }),
      prisma.helpdeskTicket.count({ where }),
    ]);
    const now = new Date();
    const items = rows.map((t) => ({ ...t, breached: svc.isBreached(t, now) }));
    res.json({ items, total, page, pageSize: take });
  } catch (e) { next(e); }
}

// Light queue counters for the console header (per-status), tenant-scoped.
async function queueStats(req, res, next) {
  try {
    const { businessId } = req.user;
    const grouped = await prisma.helpdeskTicket.groupBy({
      by: ['status'], where: { businessId, deletedAt: null }, _count: { _all: true },
    });
    const byStatus = {};
    for (const g of grouped) byStatus[g.status] = g._count._all;
    const breached = await prisma.helpdeskTicket.count({
      where: { businessId, deletedAt: null, slaDueAt: { lt: new Date() }, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'REOPENED'] } },
    });
    res.json({ byStatus, breached });
  } catch (e) { next(e); }
}

async function getTicket(req, res, next) {
  try {
    const { businessId } = req.user;
    const ticket = await loadTicketFull(businessId, req.params.id, /* includeInternal */ true);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    res.json(ticket);
  } catch (e) { next(e); }
}

async function loadTicketFull(businessId, id, includeInternal) {
  const ticket = await prisma.helpdeskTicket.findFirst({
    where: { id, businessId, deletedAt: null },
    include: {
      employee: { select: REQUESTER_SELECT },
      category: { select: { id: true, name: true, slaHours: true } },
      messages: {
        where: includeInternal ? {} : { isInternal: false },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!ticket) return null;
  return { ...ticket, breached: svc.isBreached(ticket) };
}

// ═══ TICKETS — ACTIONS ═══════════════════════════════════════════════════════════

// Assign (or reassign / unassign) a ticket to an HR agent (a User id). OPEN→IN_PROGRESS
// is auto-applied on first assignment so the queue reflects pickup.
async function assignTicket(req, res, next) {
  try {
    const { businessId } = req.user;
    const ticket = await prisma.helpdeskTicket.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (svc.TERMINAL.has(ticket.status)) return res.status(409).json({ message: `Ticket is ${ticket.status}; reopen before assigning` });
    const assigneeId = (req.body && req.body.assigneeId) || null;
    const data = { assigneeId };
    // Auto-advance OPEN → IN_PROGRESS when an assignee is set.
    if (assigneeId && ticket.status === 'OPEN') data.status = 'IN_PROGRESS';
    const updated = await prisma.helpdeskTicket.update({ where: { id: ticket.id }, data, include: { employee: { select: REQUESTER_SELECT }, category: { select: { id: true, name: true } } } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'helpdesk.ticket.assign', entityType: 'HelpdeskTicket', entityId: ticket.id, meta: { assigneeId, prevAssignee: ticket.assigneeId } });
    if (assigneeId && assigneeId !== ticket.assigneeId) { try { await notify.onAssigned({ businessId, ticket: updated }); } catch (_) {} }
    res.json({ ...updated, breached: svc.isBreached(updated) });
  } catch (e) { next(e); }
}

// Drive the status lifecycle (OPEN→IN_PROGRESS→WAITING_ON_EMPLOYEE→RESOLVED→CLOSED,
// plus REOPENED/CANCELLED). Transition validity is the single source of truth.
async function changeStatus(req, res, next) {
  try {
    const { businessId } = req.user;
    const to = String((req.body && req.body.status) || '').toUpperCase();
    const ticket = await prisma.helpdeskTicket.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (!svc.canTransition(ticket.status, to)) {
      return res.status(409).json({ message: `Cannot move ticket from ${ticket.status} to ${to || '(none)'}` });
    }
    const data = { status: to };
    const now = new Date();
    if (to === 'RESOLVED') data.resolvedAt = now;
    if (to === 'CLOSED') data.closedAt = now;
    if (to === 'REOPENED') { data.resolvedAt = null; data.closedAt = null; }
    const updated = await prisma.helpdeskTicket.update({ where: { id: ticket.id }, data, include: { employee: { select: REQUESTER_SELECT }, category: { select: { id: true, name: true } } } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'helpdesk.ticket.status', entityType: 'HelpdeskTicket', entityId: ticket.id, meta: { from: ticket.status, to } });
    if (to === 'RESOLVED' || to === 'CLOSED') { try { await notify.onResolved({ businessId, ticket: updated }); } catch (_) {} }
    res.json({ ...updated, breached: svc.isBreached(updated) });
  } catch (e) { next(e); }
}

// HR reply (employee-visible) OR internal note (isInternal=true, hidden from ESS).
// The first employee-visible reply stamps firstResponseAt (SLA first-response).
async function replyTicket(req, res, next) {
  try {
    const { businessId } = req.user;
    const ticket = await prisma.helpdeskTicket.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ message: 'body is required' });
    const isInternal = !!(req.body && req.body.isInternal);

    const message = await prisma.$transaction(async (tx) => {
      const msg = await tx.helpdeskMessage.create({
        data: { businessId, ticketId: ticket.id, authorUserId: req.user.id, body, isInternal, attachmentsJson: req.body.attachmentsJson || undefined },
      });
      const tdata = {};
      // First employee-visible HR reply → SLA first-response stamp.
      if (!isInternal && !ticket.firstResponseAt) tdata.firstResponseAt = new Date();
      // A public reply on a WAITING_ON_EMPLOYEE ticket pulls it back to IN_PROGRESS.
      if (!isInternal && ticket.status === 'OPEN') tdata.status = 'IN_PROGRESS';
      if (Object.keys(tdata).length) await tx.helpdeskTicket.update({ where: { id: ticket.id }, data: tdata });
      return msg;
    });
    await writeAudit({ businessId, actorId: req.user.id, action: isInternal ? 'helpdesk.note.add' : 'helpdesk.reply.add', entityType: 'HelpdeskTicket', entityId: ticket.id, meta: { messageId: message.id } });
    // Only a public reply notifies the requester.
    if (!isInternal) { try { await notify.onReplied({ businessId, ticket, authorIsEmployee: false, messageId: message.id }); } catch (_) {} }
    res.status(201).json(message);
  } catch (e) { next(e); }
}

module.exports = {
  listCategories, createCategory, updateCategory,
  listTickets, queueStats, getTicket, assignTicket, changeStatus, replyTicket,
};
