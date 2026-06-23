'use strict';

/**
 * delegations.controller.js — Feature 10 §7.3 "approve on my behalf" self-service.
 * Mounted at /api/hr/me/delegations (works for BOTH an operator session, req.user,
 * and an ESS/customer session, req.customer — the "from" user is resolved from
 * whichever session is present). The admin tenant-wide view lives in
 * approvals.controller#listAllDelegations.
 *
 * A delegation ADDS the stand-in to the approver set for the window; it never
 * removes the delegator (§4.3). Guards: toUser ≠ me, toUser is a real active user
 * in the SAME tenant, the window is sane (start < end), and modules (if given) are
 * valid. SoD on the original requester is still enforced at decision time.
 */

const prisma = require('../../core/lib/prisma');

const MODULES = new Set([
  'LEAVE', 'EXPENSE', 'TRAVEL', 'LOAN', 'COMPENSATION', 'OFFER', 'PROFILE_CHANGE',
  'TIMESHEET', 'ATTENDANCE_REGULARIZATION', 'SEPARATION', 'ASSET', 'DOCUMENT_SIGN', 'PAYRUN',
]);

function bad(res, message) { return res.status(400).json({ message }); }

// Resolve { businessId, userId } for the caller, from an operator OR ESS session.
async function resolveCaller(req) {
  if (req.user && req.user.id) return { businessId: req.user.businessId, userId: req.user.id };
  if (req.customer && req.customer.id) {
    // ESS: map the customer's email to the tenant operator/portal User.
    const businessId = req.customer.businessId;
    const user = req.customer.email
      ? await prisma.user.findFirst({ where: { businessId, email: req.customer.email, isActive: true }, select: { id: true } })
      : null;
    return { businessId, userId: user ? user.id : null };
  }
  return { businessId: null, userId: null };
}

async function listMine(req, res, next) {
  try {
    const { businessId, userId } = await resolveCaller(req);
    if (!userId) return res.json({ outgoing: [], incoming: [] });
    const now = new Date();
    const [outgoing, incoming] = await Promise.all([
      prisma.approvalDelegation.findMany({
        where: { businessId, fromUserId: userId, isActive: true, endsAt: { gte: now } },
        orderBy: { startsAt: 'asc' },
        include: { toUser: { select: { id: true, name: true, email: true } } },
      }),
      prisma.approvalDelegation.findMany({
        where: { businessId, toUserId: userId, isActive: true, endsAt: { gte: now } },
        orderBy: { startsAt: 'asc' },
        include: { fromUser: { select: { id: true, name: true, email: true } } },
      }),
    ]);
    res.json({ outgoing, incoming });
  } catch (e) { next(e); }
}

async function create(req, res, next) {
  try {
    const { businessId, userId } = await resolveCaller(req);
    if (!userId) return res.status(403).json({ message: 'No portal user identity for this session' });
    const { toUserId, startsAt, endsAt, modules, reason } = req.body || {};
    if (!toUserId) return bad(res, 'toUserId is required');
    if (toUserId === userId) return bad(res, 'You cannot delegate to yourself');
    const start = startsAt ? new Date(startsAt) : null;
    const end = endsAt ? new Date(endsAt) : null;
    if (!start || Number.isNaN(start.getTime())) return bad(res, 'startsAt must be a valid date');
    if (!end || Number.isNaN(end.getTime())) return bad(res, 'endsAt must be a valid date');
    if (start >= end) return bad(res, 'startsAt must be before endsAt');
    let mods = [];
    if (modules !== undefined && modules !== null) {
      if (!Array.isArray(modules)) return bad(res, 'modules must be an array');
      for (const m of modules) if (!MODULES.has(m)) return bad(res, `Unknown module "${m}"`);
      mods = modules;
    }
    // toUser must be a real active user in THIS tenant (cross-tenant ⇒ 404).
    const target = await prisma.user.findFirst({ where: { id: toUserId, businessId, isActive: true }, select: { id: true } });
    if (!target) return res.status(404).json({ message: 'Stand-in user not found in this tenant' });

    const del = await prisma.approvalDelegation.create({
      data: {
        businessId, fromUserId: userId, toUserId, modules: mods,
        startsAt: start, endsAt: end, reason: reason || null, isActive: true, createdBy: userId,
      },
      include: { toUser: { select: { id: true, name: true, email: true } } },
    });
    res.status(201).json(del);
  } catch (e) { next(e); }
}

async function revoke(req, res, next) {
  try {
    const { businessId, userId } = await resolveCaller(req);
    if (!userId) return res.status(403).json({ message: 'No portal user identity for this session' });
    const del = await prisma.approvalDelegation.findFirst({ where: { id: req.params.id, businessId } });
    if (!del) return res.status(404).json({ message: 'Not found' });
    // only the delegator (or an admin via the admin route) can revoke here.
    if (del.fromUserId !== userId) return res.status(403).json({ message: 'Only the delegator can revoke this' });
    await prisma.approvalDelegation.update({ where: { id: del.id }, data: { isActive: false } });
    res.json({ ok: true, id: del.id });
  } catch (e) { next(e); }
}

module.exports = { listMine, create, revoke };
