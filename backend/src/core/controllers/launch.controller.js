const prisma = require('../lib/prisma');
const { resolveVertical } = require('../lib/vertical');

/**
 * Launch checklist — determines what a business needs to complete before
 * their website goes live. Business starts as isActive=false (draft).
 * Only when ALL items are checked can the admin click "Launch".
 */

// Checklist items split into two buckets:
//   required=true  → launch button is blocked until these are filled
//   required=false → shown as recommendations; owner can launch anyway
//                    (defaults/placeholders render on the public site
//                    so nothing looks broken).
const CHECKLIST_ITEMS = [
  {
    key: 'business_details',
    label: 'Business details',
    description: 'Business name, category, email, phone, and address — all required. Description is optional. This is how your website introduces itself in the navbar, emails, and search results. Without every contact field filled, visitors can\'t reach you and the site can\'t identify itself.',
    tab: 'settings',
    required: true,
  },
  {
    key: 'hero_section',
    label: 'Hero section',
    description: 'The big headline at the top of your website — the first thing a visitor sees. It tells them what you do and why they should contact, book, or shop with you. Without it, your homepage looks blank and most visitors leave before scrolling down.',
    tab: 'content',
    required: true,
  },
  { key: 'at_least_one_service',  label: 'Add at least 1 service',  description: 'So customers have something to book.',          tab: 'services',       required: false, verticals: ['APPOINTMENT'] },
  { key: 'availability_set',      label: 'Set your availability',   description: 'Your schedule or a staff member\'s schedule.',  tab: 'myavailability', required: false, verticals: ['APPOINTMENT'] },
  { key: 'business_hours',        label: 'Set business hours',      description: 'When your business is open.',                   tab: 'hours',          required: false, verticals: ['APPOINTMENT'] },
  { key: 'about_section',         label: 'Write an About section',  description: 'A short description of your business.',         tab: 'content',        required: false },
];

function itemsForVertical(vertical) {
  return CHECKLIST_ITEMS.filter((item) => !item.verticals || item.verticals.includes(vertical));
}

async function computeCompletion(bizId) {
  const [business, serviceCount, scheduleCount, hoursCount, content] = await Promise.all([
    prisma.business.findUnique({ where: { id: bizId }, select: { name: true, category: true, phone: true, address: true, email: true, isActive: true, vertical: true } }),
    prisma.service.count({ where: { businessId: bizId, isActive: true } }),
    prisma.staffSchedule.count({ where: { staff: { businessId: bizId } } }),
    prisma.businessHours.count({ where: { businessId: bizId } }),
    prisma.businessContent.findUnique({ where: { businessId: bizId } }),
  ]);
  // Business details is "complete" only when ALL five compulsory fields
  // are present. Description is optional and intentionally not checked.
  const biz = business || {};
  const filled = (v) => !!(typeof v === 'string' && v.trim());
  const status = {
    business_details:      filled(biz.name) && filled(biz.category) && filled(biz.email) && filled(biz.phone) && filled(biz.address),
    hero_section:          filled(content?.heroHeadline),
    at_least_one_service:  serviceCount > 0,
    availability_set:      scheduleCount > 0,
    business_hours:        hoursCount > 0,
    about_section:         filled(content?.aboutBody),
  };
  return { business, status };
}

// GET /api/business/launch-checklist — returns completion status of each item
async function getChecklist(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'No business' });
  const { business, status } = await computeCompletion(req.user.businessId);
  const vertical = resolveVertical(business?.vertical);

  const items = itemsForVertical(vertical).map((item) => ({ ...item, completed: !!status[item.key] }));
  const requiredItems = items.filter((i) => i.required);
  const recommendedItems = items.filter((i) => !i.required);

  const allRequiredComplete = requiredItems.every((i) => i.completed);
  const allComplete = items.every((i) => i.completed);
  const completedCount = items.filter((i) => i.completed).length;

  res.json({
    items,
    requiredItems,
    recommendedItems,
    allRequiredComplete,
    allComplete, // kept for UI that still wants the "fully done" signal
    completedCount,
    totalCount: items.length,
    isLive: business?.isActive || false,
  });
}

// POST /api/business/launch — set isActive=true (go live)
// No server-side gating: the frontend's Publish-confirmation popup is the
// "are you sure?" moment. Owner clicks Publish & go live → site goes live,
// regardless of which recommended / required checklist items are filled.
// We still compute + return the item status so the caller can log or toast
// "you skipped these" info, but it's informational, never blocking.
async function launch(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'No business' });
  const bizId = req.user.businessId;

  const { business: existingBusiness, status } = await computeCompletion(bizId);
  const vertical = resolveVertical(existingBusiness?.vertical);
  const pending = itemsForVertical(vertical).filter((i) => !status[i.key]).map((i) => i.label);

  const business = await prisma.business.update({
    where: { id: bizId },
    data: { isActive: true },
    select: { id: true, name: true, slug: true, isActive: true },
  });

  console.log(`Business ${business.name} (${business.slug}) LAUNCHED by admin${pending.length ? ` — ${pending.length} checklist item(s) skipped` : ''}`);
  res.json({
    business,
    message: 'Your website is now live!',
    pendingItems: pending, // info only, not a gate
  });
}

// POST /api/business/unpublish — set isActive=false (take offline)
async function unpublish(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'No business' });
  const business = await prisma.business.update({
    where: { id: req.user.businessId },
    data: { isActive: false },
  });
  res.json({ message: 'Website taken offline' });
}

module.exports = { getChecklist, launch, unpublish };
