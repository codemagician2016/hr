// Super-admin endpoints for managing per-tenant notification access:
//   - List tenants + their gate status (managedSmsEnabled / managedWaEnabled)
//   - Toggle gates on/off
//   - Override budget% for individual tenants
//   - Approve/reject pending access requests
//   - View per-cycle usage + audit log
//
// All endpoints require SUPER_ADMIN role (mounted under /api/admin/notification-access).
'use strict';

const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const { computeBudgetUsd, computeSlotCounts, getCurrentCycle } = require('../lib/notifications/budgetEngine');

const prisma = new PrismaClient();

// =============================================================================
// GET /api/admin/notification-access
// List all tenants + their notification config + this-cycle usage
// Query params: ?status=PENDING|APPROVED|... (optional filter)
// =============================================================================
async function listTenants(req, res) {
  try {
    const status = req.query.status;
    const where = {};
    if (status) where.requestAccessStatus = status;

    const configs = await prisma.notificationConfig.findMany({
      where,
      include: {
        business: {
          select: {
            id: true,
            slug: true,
            name: true,
            country: true,
            vertical: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const cycle = getCurrentCycle();
    const enriched = await Promise.all(
      configs.map(async (cfg) => {
        const usage = await prisma.budgetUsage.findUnique({
          where: { businessId_cycle: { businessId: cfg.businessId, cycle } },
        });
        return {
          ...cfg,
          currentCycle: cycle,
          usage: usage || null,
        };
      }),
    );

    res.json({ items: enriched });
  } catch (err) {
    console.error('[notificationAccess.listTenants]', err);
    res.status(500).json({ message: 'Failed to load tenants' });
  }
}

// =============================================================================
// GET /api/admin/notification-access/:businessId
// Detailed view: config + usage history + recent deliveries
// =============================================================================
async function getTenantDetail(req, res) {
  try {
    const { businessId } = req.params;
    const config = await prisma.notificationConfig.findUnique({
      where: { businessId },
      include: { business: true },
    });
    if (!config) return res.status(404).json({ message: 'Notification config not found' });

    const [usageHistory, recentDeliveries, slotCounts] = await Promise.all([
      prisma.budgetUsage.findMany({
        where: { businessId },
        orderBy: { cycle: 'desc' },
        take: 6,
      }),
      prisma.messageDelivery.findMany({
        where: { businessId },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: {
          id: true,
          recipientPhone: true,
          recipientCountry: true,
          channel: true,
          provider: true,
          status: true,
          providerCostUsd: true,
          createdAt: true,
          sentAt: true,
          triggeredBy: true,
        },
      }),
      computeSlotCounts(businessId, config.business?.country || 'US').catch(() => null),
    ]);

    res.json({ config, usageHistory, recentDeliveries, slotCounts });
  } catch (err) {
    console.error('[notificationAccess.getTenantDetail]', err);
    res.status(500).json({ message: 'Failed to load tenant detail' });
  }
}

// =============================================================================
// PUT /api/admin/notification-access/:businessId/gates
// Toggle the managed-SMS and/or managed-WhatsApp gates for a tenant.
// =============================================================================
const gateSchema = z.object({
  managedSmsEnabled:      z.boolean().optional(),
  managedWhatsappEnabled: z.boolean().optional(),
  budgetOverridePercent:  z.union([z.number().min(0).max(100), z.null()]).optional(),
});

async function updateGates(req, res) {
  try {
    const { businessId } = req.params;
    const parsed = gateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Invalid input', issues: parsed.error.issues });

    const existing = await prisma.notificationConfig.findUnique({ where: { businessId } });
    if (!existing) {
      // Create on demand — first super-admin action implicitly creates the row.
      const created = await prisma.notificationConfig.create({
        data: {
          businessId,
          ...parsed.data,
        },
      });
      return res.json(created);
    }

    const updated = await prisma.notificationConfig.update({
      where: { businessId },
      data: parsed.data,
    });
    res.json(updated);
  } catch (err) {
    console.error('[notificationAccess.updateGates]', err);
    res.status(500).json({ message: 'Failed to update gates' });
  }
}

// =============================================================================
// PUT /api/admin/notification-access/:businessId/request-status
// Approve/reject a tenant's access request.
// On APPROVED, automatically flips managedSmsEnabled + managedWhatsappEnabled.
// =============================================================================
const reviewSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  enableSms: z.boolean().optional(),
  enableWhatsapp: z.boolean().optional(),
  reviewerNote: z.string().max(1000).optional(),
});

async function reviewRequest(req, res) {
  try {
    const { businessId } = req.params;
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Invalid input', issues: parsed.error.issues });

    const updateData = {
      requestAccessStatus: parsed.data.status,
      requestReviewedAt: new Date(),
      requestReviewedBy: req.user?.id || null,
    };
    if (parsed.data.status === 'APPROVED') {
      // Default to enabling both unless explicitly disabled in the body.
      updateData.managedSmsEnabled      = parsed.data.enableSms      !== false;
      updateData.managedWhatsappEnabled = parsed.data.enableWhatsapp !== false;
    }

    const updated = await prisma.notificationConfig.update({
      where: { businessId },
      data: updateData,
    });
    res.json(updated);
  } catch (err) {
    console.error('[notificationAccess.reviewRequest]', err);
    res.status(500).json({ message: 'Failed to update request status' });
  }
}

// =============================================================================
// GET /api/admin/notification-access/pricing-tiers
// Show per-tier messagingBudgetPercent (the global super-admin knob).
// =============================================================================
async function listTierBudgets(req, res) {
  try {
    const tiers = await prisma.pricingTier.findMany({
      orderBy: [{ vertical: 'asc' }, { sortOrder: 'asc' }],
      select: {
        id: true,
        slug: true,
        name: true,
        vertical: true,
        messagingBudgetPercent: true,
        sortOrder: true,
      },
    });
    res.json({ tiers });
  } catch (err) {
    console.error('[notificationAccess.listTierBudgets]', err);
    res.status(500).json({ message: 'Failed to load tier budgets' });
  }
}

// =============================================================================
// PUT /api/admin/notification-access/pricing-tiers/:tierId/budget
// Update messagingBudgetPercent on a tier (the global knob).
// =============================================================================
const budgetSchema = z.object({
  messagingBudgetPercent: z.number().min(0).max(100),
});

async function updateTierBudget(req, res) {
  try {
    const { tierId } = req.params;
    const parsed = budgetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Invalid input', issues: parsed.error.issues });

    const updated = await prisma.pricingTier.update({
      where: { id: tierId },
      data: { messagingBudgetPercent: parsed.data.messagingBudgetPercent },
      select: { id: true, slug: true, name: true, vertical: true, messagingBudgetPercent: true },
    });
    res.json(updated);
  } catch (err) {
    console.error('[notificationAccess.updateTierBudget]', err);
    res.status(500).json({ message: 'Failed to update tier budget' });
  }
}

module.exports = {
  listTenants,
  getTenantDetail,
  updateGates,
  reviewRequest,
  listTierBudgets,
  updateTierBudget,
};
