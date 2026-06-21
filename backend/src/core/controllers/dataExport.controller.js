// Right-to-export (GDPR Art. 20 / NZ Privacy Act IPP 6).
//
// Produces a single JSON document covering everything we hold for the
// signed-in business — business profile, content, products, categories,
// orders, customers, appointments, services, staff, subscription —
// in a portable format the owner can take to another platform or store
// for their records. Excludes obvious operational artefacts (raw logs,
// audit-log entries) and other tenants' data.
//
// Mounted at GET /api/business/data-export, BUSINESS_ADMIN only.

const prisma = require('../lib/prisma');

async function exportBusinessData(req, res) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  try {
    // One Promise.all so we hit the DB in parallel — total roundtrip
    // stays well under nginx's upstream timeout even for the largest
    // shops we expect at v1 scale.
    const [
      business,
      content,
      subscription,
      hours,
      holidays,
      services,
      staff,
      customers,
      appointments,
      productCategories,
      products,
      orders,
      enquiries,
      pages,
    ] = await Promise.all([
      prisma.business.findUnique({
        where: { id: businessId },
        select: {
          id: true, name: true, slug: true, description: true,
          address: true, state: true, country: true, timezone: true,
          phone: true, email: true, category: true, vertical: true,
          defaultLanguage: true, defaultCurrency: true,
          bookingType: true, isActive: true, createdAt: true, updatedAt: true,
        },
      }),
      prisma.businessContent.findUnique({ where: { businessId } }),
      prisma.subscription.findUnique({
        where: { businessId },
        include: { tier: { select: { name: true, slug: true, vertical: true } } },
      }),
      prisma.businessHours.findMany({ where: { businessId } }),
      prisma.businessHoliday.findMany({ where: { businessId } }),
      prisma.service.findMany({ where: { businessId } }),
      prisma.user.findMany({
        where: { businessId },
        select: {
          id: true, email: true, name: true, role: true, subtitle: true, bio: true,
          isActive: true, isServiceProvider: true, showOnWebsite: true,
          preferredLanguage: true, createdAt: true,
        },
      }),
      prisma.customer.findMany({
        where: { businessId },
        select: {
          id: true, email: true, name: true, phone: true, dateOfBirth: true,
          isActive: true, emailVerified: true, preferredLanguage: true,
          termsAcceptedAt: true, termsVersion: true, createdAt: true,
        },
      }),
      prisma.appointment.findMany({ where: { businessId } }),
      prisma.productCategory.findMany({ where: { businessId } }),
      prisma.product.findMany({ where: { businessId } }),
      prisma.order.findMany({
        where: { businessId },
        include: { items: true },
      }),
      prisma.enquiry.findMany({ where: { businessId } }),
      prisma.businessPage.findMany({ where: { businessId } }),
    ]);

    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    const exportPayload = {
      // Metadata so a reader can interpret the file later.
      _meta: {
        format: 'sitepresso-data-export',
        formatVersion: 1,
        generatedAt: new Date().toISOString(),
        generatedFor: business.slug,
        notes: 'JSON snapshot of all data Sitepresso holds for this business. Suitable for backup or porting to another platform. Sensitive fields like password hashes and OAuth tokens are intentionally omitted.',
      },
      business,
      content,
      subscription,
      hours,
      holidays,
      services,
      staff,
      customers,
      appointments,
      productCategories,
      products,
      orders,
      enquiries,
      pages,
    };

    // Stream as a downloadable file. Filename includes the slug + date so
    // the owner gets a clean name in their Downloads folder.
    const filename = `sitepresso-export-${business.slug}-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(exportPayload, null, 2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dataExport] failed', err?.message || err);
    res.status(500).json({ message: 'Could not generate export. Please try again or contact support.' });
  }
}

module.exports = { exportBusinessData };
