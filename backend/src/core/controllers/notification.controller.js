const prisma = require('../lib/prisma');

// GET /api/notifications/active — public endpoint
// Returns currently active banners based on current time + target scope.
// Query: ?target=platform|business&businessId=xxx
async function getActive(req, res) {
  const now = new Date();
  const { target, businessId } = req.query;

  const where = {
    isActive: true,
    startTime: { lte: now },
    endTime: { gte: now },
  };

  // Filter by target scope
  if (target === 'platform') {
    where.target = { in: ['ALL', 'PLATFORM'] };
  } else if (target === 'business' && businessId) {
    where.OR = [
      { target: 'ALL' },
      { target: 'BUSINESSES' },
      { target: 'SPECIFIC', businessId },
    ];
  } else {
    // Default: return all active (for general use)
    where.target = { in: ['ALL', 'PLATFORM', 'BUSINESSES'] };
  }

  const banners = await prisma.notificationBanner.findMany({
    where,
    orderBy: [{ type: 'desc' }, { startTime: 'desc' }], // URGENT first
    select: {
      id: true,
      message: true,
      type: true,
      target: true,
      startTime: true,
      endTime: true,
      dismissible: true,
      linkUrl: true,
      linkText: true,
    },
  });

  res.json({ banners });
}

// GET /api/admin/notifications — all banners (for management)
async function listAll(req, res) {
  const banners = await prisma.notificationBanner.findMany({
    orderBy: { createdAt: 'desc' },
  });
  res.json({ banners });
}

// POST /api/admin/notifications — create a new banner
async function create(req, res) {
  const { message, type = 'INFO', target = 'ALL', businessId, startTime, endTime, dismissible = true, linkUrl, linkText } = req.body;

  if (!message?.trim()) return res.status(400).json({ message: 'Message is required' });
  if (!startTime || !endTime) return res.status(400).json({ message: 'startTime and endTime are required' });

  const start = new Date(startTime);
  const end = new Date(endTime);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return res.status(400).json({ message: 'Invalid date format' });
  }
  if (end <= start) return res.status(400).json({ message: 'endTime must be after startTime' });

  if (!['INFO', 'WARNING', 'URGENT', 'MAINTENANCE'].includes(type)) {
    return res.status(400).json({ message: 'Invalid type' });
  }
  if (!['ALL', 'PLATFORM', 'BUSINESSES', 'SPECIFIC'].includes(target)) {
    return res.status(400).json({ message: 'Invalid target' });
  }
  if (target === 'SPECIFIC' && !businessId) {
    return res.status(400).json({ message: 'businessId required when target is SPECIFIC' });
  }

  const banner = await prisma.notificationBanner.create({
    data: {
      message: message.trim(),
      type,
      target,
      businessId: target === 'SPECIFIC' ? businessId : null,
      startTime: start,
      endTime: end,
      dismissible: !!dismissible,
      linkUrl: linkUrl?.trim() || null,
      linkText: linkText?.trim() || null,
      createdBy: req.user?.id || null,
    },
  });

  res.status(201).json({ banner });
}

// PUT /api/admin/notifications/:id — update
async function update(req, res) {
  const { id } = req.params;
  const existing = await prisma.notificationBanner.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ message: 'Not found' });

  const data = {};
  const { message, type, target, businessId, startTime, endTime, isActive } = req.body;
  if (message !== undefined) data.message = message.trim();
  if (type !== undefined) data.type = type;
  if (target !== undefined) data.target = target;
  if (businessId !== undefined) data.businessId = businessId;
  if (startTime !== undefined) data.startTime = new Date(startTime);
  if (endTime !== undefined) data.endTime = new Date(endTime);
  if (isActive !== undefined) data.isActive = !!isActive;

  const banner = await prisma.notificationBanner.update({ where: { id }, data });
  res.json({ banner });
}

// DELETE /api/admin/notifications/:id
async function remove(req, res) {
  const { id } = req.params;
  await prisma.notificationBanner.delete({ where: { id } }).catch(() => null);
  res.json({ message: 'Deleted' });
}

module.exports = { getActive, listAll, create, update, remove };
