'use strict';

/**
 * careersPage.controller.js — Careers CMS admin CRUD, mounted on the recruitment
 * router at /api/hr/recruitment/careers-page.
 *
 *   GET  /careers-page            the tenant's page (or a sensible empty default)
 *   PUT  /careers-page            upsert the single per-tenant row (sanitise+cap)
 *   POST /careers-page/publish    isPublished = true
 *   POST /careers-page/unpublish  isPublished = false
 *
 * RBAC is enforced on the router: canManage (canManageHiring|canManageEmployees)
 * for writes, canView for the read. Tenant isolation is by req.user.businessId on
 * every where — one CareersPage row per tenant (businessId @unique). Rich-text is
 * SANITISED on write (see careersPage.lib.js) so the UNAUTH public render is safe.
 */

const prisma = require('../../../core/lib/prisma');
const { sanitizeCareersInput, shapeAdminPage } = require('./careersPage.lib');

// GET /careers-page — the tenant's page, or the empty default when none exists.
async function getCareersPage(req, res, next) {
  try {
    const { businessId } = req.user;
    const row = await prisma.careersPage.findUnique({ where: { businessId } });
    res.json({ page: shapeAdminPage(row) });
  } catch (e) { next(e); }
}

// PUT /careers-page — upsert the single per-tenant row. isPublished is NEVER
// changed here (only publish/unpublish toggle it); a create defaults it to false.
async function upsertCareersPage(req, res, next) {
  try {
    const { businessId, id: userId } = req.user;
    const data = sanitizeCareersInput(req.body || {});
    const row = await prisma.careersPage.upsert({
      where: { businessId },
      create: { businessId, ...data, updatedByUserId: userId || null },
      update: { ...data, updatedByUserId: userId || null },
    });
    res.json({ page: shapeAdminPage(row) });
  } catch (e) { next(e); }
}

// Toggle isPublished. Upsert so publishing works even before a first PUT (an
// empty page still flips the switch; the public board simply shows no content).
async function setPublished(businessId, userId, isPublished) {
  return prisma.careersPage.upsert({
    where: { businessId },
    create: { businessId, isPublished, updatedByUserId: userId || null },
    update: { isPublished, updatedByUserId: userId || null },
  });
}

// POST /careers-page/publish
async function publishCareersPage(req, res, next) {
  try {
    const { businessId, id: userId } = req.user;
    const row = await setPublished(businessId, userId, true);
    res.json({ page: shapeAdminPage(row) });
  } catch (e) { next(e); }
}

// POST /careers-page/unpublish
async function unpublishCareersPage(req, res, next) {
  try {
    const { businessId, id: userId } = req.user;
    const row = await setPublished(businessId, userId, false);
    res.json({ page: shapeAdminPage(row) });
  } catch (e) { next(e); }
}

module.exports = {
  getCareersPage,
  upsertCareersPage,
  publishCareersPage,
  unpublishCareersPage,
};
