const express = require('express');
const router = express.Router();
const { register, login, me, logout, updateMe, changePassword, deleteAccount, undoDeleteAccount, verifyOtp, resendOtp, forgotPassword, resetPassword } = require('../controllers/customer.controller');
const { socialStart, socialExchange, googleAuth, googleAuthCode, exchangeCode } = require('../controllers/social.controller');
const { listAddresses, createAddress, updateAddress, deleteAddress, setDefaultAddress } = require('../../shop/controllers/customerAddress.controller');
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const { requireCustomerVertical } = require('../../core/middleware/requireVertical');
const { authLimiter } = require('../../core/middleware/abuse.middleware');
const { validateBody } = require('../../core/lib/validate');
const { signupSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } = require('../../core/lib/schemas/signup.schema');
const { verifyOtpSchema, resendOtpSchema, changePasswordSchema } = require('../../core/lib/schemas/customer.schema');
const { createAddressSchema, updateAddressSchema } = require('../../core/lib/schemas/customerAddress.schema');
const { myWaitlist, cancelMyWaitlist } = require('../../booking/controllers/waitlist.controller');
const prisma = require('../../core/lib/prisma');
const { INBOX_TYPES, createNotifications, formatWhenLabel, listBusinessAdminRecipients } = require('../../core/lib/inbox');

const requireAppointmentCustomer = requireCustomerVertical('APPOINTMENT');
const requireShopCustomer = requireCustomerVertical('ECOMMERCE');

function parseJsonField(raw, fallback) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeThemeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isDoctorClinicTheme(value) {
  return normalizeThemeKey(value) === 'doctor_clinic';
}

function formatPrescription(record) {
  if (!record) return null;
  return {
    id: record.id,
    patientName: record.patientName,
    patientContact: record.patientContact,
    clinical: parseJsonField(record.clinicalJson, {}),
    medicines: parseJsonField(record.medicinesJson, []),
    // doctorSnapshot is the immutable provider identity stamped at issue time
    // (replaces the old editable letterhead).
    doctor: parseJsonField(record.doctorSnapshotJson, null),
    status: record.status || null,
    issuedAt: record.issuedAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy || null,
  };
}

function formatInvoice(record) {
  if (!record) return null;
  return {
    id: record.id,
    invoiceNumber: record.invoiceNumber,
    currency: record.currency || null,
    lineItems: parseJsonField(record.lineItemsJson, []),
    subtotal: record.subtotal,
    taxAmount: record.taxAmount,
    total: record.total,
    taxLabel: record.taxLabel || null,
    issuedAt: record.issuedAt,
  };
}

// Customer-facing auth — same abuse limit as business auth so a bot can't
// brute-force customer credentials or spray Google OAuth code exchanges.
//
router.post('/register',         authLimiter, validateBody(signupSchema),           register);
router.post('/verify-otp',       authLimiter, validateBody(verifyOtpSchema),         verifyOtp);
router.post('/resend-otp',       authLimiter, validateBody(resendOtpSchema),         resendOtp);
router.post('/forgot-password',  authLimiter, validateBody(forgotPasswordSchema),   forgotPassword);
router.post('/reset-password',   authLimiter, validateBody(resetPasswordSchema),    resetPassword);
router.post('/login',            authLimiter, validateBody(loginSchema),            login);
router.get('/me',                requireCustomer, me);
router.put('/me',                requireCustomer, updateMe);
router.put('/password',          requireCustomer, authLimiter, validateBody(changePasswordSchema), changePassword);
router.delete('/account',        requireCustomer, deleteAccount);
// GDPR Article 17 — undo within 30-day grace period (signs back in to undo).
router.post('/undo-deletion',    requireCustomer, undoDeleteAccount);
router.post('/logout',           logout);
// Server-side fallback: bounce a tenant host to the centralised provider
// page on the platform origin. The frontend normally builds this URL
// directly; this exists for non-JS / deep-link entry. :provider is the
// social provider key (google | apple | microsoft | …).
router.get('/auth/:provider',    authLimiter, (req, res) => {
  const provider = String(req.params.provider || 'google').toLowerCase();
  const tenantHost = (req.get('X-Tenant-Host') || req.get('X-Forwarded-Host') || req.get('Host') || '').split(':')[0];
  const configuredPlatform = (process.env.PLATFORM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const platformDomain = configuredPlatform || (tenantHost.endsWith('.aapkatech.com') ? 'aapkatech.com' : 'sitepresso.com');
  const redirect = req.query.redirect || '/dashboard';
  const target = new URL(`https://${platformDomain}/auth/${provider}`);
  target.searchParams.set('host', tenantHost);
  target.searchParams.set('redirect', redirect);
  res.redirect(302, target.toString());
});
// Customer's own waitlist entries — list + cancel-own.
router.get('/waitlist',          requireCustomer, requireAppointmentCustomer, myWaitlist);
router.delete('/waitlist/:id',   requireCustomer, requireAppointmentCustomer, cancelMyWaitlist);
// Generic, provider-agnostic social login (Google now; Apple/MS later).
router.post('/social/:provider/start', authLimiter, socialStart); // platform → one-time code
router.post('/social/exchange',        authLimiter, socialExchange); // tenant host → JWT
// Legacy aliases — delegate to the generic handlers above. Kept so older
// already-deployed frontends keep working through the rollout.
router.post('/google-auth',      authLimiter, googleAuth);
router.post('/google-auth-code', authLimiter, googleAuthCode);
router.post('/exchange-code',    authLimiter, exchangeCode);

// Address book — saved shipping addresses for the storefront /account page.
router.get('/addresses',                  requireCustomer, requireShopCustomer, listAddresses);
router.post('/addresses',                 requireCustomer, requireShopCustomer, validateBody(createAddressSchema), createAddress);
router.put('/addresses/:id',              requireCustomer, requireShopCustomer, validateBody(updateAddressSchema), updateAddress);
router.delete('/addresses/:id',           requireCustomer, requireShopCustomer, deleteAddress);
router.post('/addresses/:id/default',     requireCustomer, requireShopCustomer, setDefaultAddress);

// GET /api/customer/appointments — customer's own appointments at this business
router.get('/appointments', requireCustomer, requireAppointmentCustomer, async (req, res, next) => {
  try {
    const appointments = await prisma.appointment.findMany({
      where: { customerId: req.customer.id, businessId: req.customer.businessId },
      include: {
        service: { select: { id: true, name: true, duration: true, price: true, isVirtual: true, virtualMeetingUrl: true } },
        staff: { select: { id: true, name: true } },
        business: { select: { id: true, name: true, slug: true, subscription: { select: { theme: true } } } },
        prescription: { include: { createdBy: { select: { id: true, name: true } } } },
        invoice: true,
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });
    res.json({
      appointments: appointments.map((appointment) => ({
        ...appointment,
        prescription: isDoctorClinicTheme(appointment.business?.subscription?.theme)
          ? formatPrescription(appointment.prescription)
          : null,
        invoice: isDoctorClinicTheme(appointment.business?.subscription?.theme)
          ? formatInvoice(appointment.invoice)
          : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/customer/matters — a law-firm client's own matters, engagement
// letters and invoices for the branded "My matters" portal tab. Empty for any
// non-law_firm tenant so the generic portal is unaffected.
router.get('/matters', requireCustomer, requireAppointmentCustomer, async (req, res, next) => {
  try {
    const biz = await prisma.business.findUnique({
      where: { id: req.customer.businessId },
      select: { subscription: { select: { theme: true } } },
    });
    if (String(biz?.subscription?.theme || '').toLowerCase() !== 'law_firm') return res.json({ matters: [] });

    const matters = await prisma.matter.findMany({
      where: { customerId: req.customer.id, businessId: req.customer.businessId },
      include: {
        responsibleLawyer: { select: { name: true } },
        invoices: { orderBy: { issuedAt: 'desc' } },
        trustTransactions: { orderBy: { createdAt: 'desc' }, take: 1 },
        originAppointment: { include: { documents: { where: { type: 'engagement_letter' } } } },
      },
      orderBy: { openedAt: 'desc' },
    });

    res.json({
      matters: matters.map((m) => {
        const doc = (m.originAppointment?.documents || [])[0];
        return {
          id: m.id, matterNumber: m.matterNumber, title: m.title, status: m.status,
          practiceArea: m.practiceArea, feeBasis: m.feeBasis, currency: m.currency,
          responsibleLawyer: m.responsibleLawyer?.name || null,
          engagementStatus: m.engagementStatus,
          engagementLetter: doc && doc.status === 'issued'
            ? { title: doc.title, payload: parseJsonField(doc.payloadJson, {}), letterhead: parseJsonField(doc.letterheadJson, {}), issuedAt: doc.issuedAt }
            : null,
          trustBalance: m.trustTransactions[0]?.balanceAfter || 0,
          openedAt: m.openedAt,
          invoices: m.invoices.map((i) => ({
            id: i.id, invoiceNumber: i.invoiceNumber, currency: i.currency,
            lineItems: parseJsonField(i.lineItemsJson, []), subtotal: i.subtotal, taxAmount: i.taxAmount,
            taxLabel: i.taxLabel, total: i.total, amountPaid: i.amountPaid,
            balance: Math.round((i.total - i.amountPaid) * 100) / 100, status: i.status,
            dueDate: i.dueDate, issuedAt: i.issuedAt,
          })),
        };
      }),
    });
  } catch (err) { next(err); }
});

// GET /api/customer/service-plan — a water-purifier client's AMC contracts,
// upcoming service visits and service history for the "My Service Plan" portal
// tab. Empty for any non-water_purifier tenant.
router.get('/service-plan', requireCustomer, requireAppointmentCustomer, async (req, res, next) => {
  try {
    const biz = await prisma.business.findUnique({ where: { id: req.customer.businessId }, select: { subscription: { select: { theme: true } } } });
    if (String(biz?.subscription?.theme || '').toLowerCase() !== 'water_purifier') return res.json({ contracts: [] });

    const contracts = await prisma.amcContract.findMany({
      where: { customerId: req.customer.id, businessId: req.customer.businessId },
      include: {
        installedUnit: true,
        responsibleTechnician: { select: { name: true } },
        visits: { orderBy: { scheduledFor: 'asc' }, include: { technician: { select: { name: true } } } },
        invoices: { orderBy: { issuedAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      contracts: contracts.map((c) => ({
        id: c.id, contractNumber: c.contractNumber, tier: c.tier, status: c.status,
        startDate: c.startDate, endDate: c.endDate, currency: c.currency,
        visitsIncluded: c.visitsIncluded, visitsUsed: c.visitsUsed, visitsRemaining: Math.max(0, c.visitsIncluded - c.visitsUsed),
        nextVisitDueAt: c.nextVisitDueAt, technician: c.responsibleTechnician?.name || null,
        unit: c.installedUnit ? { brand: c.installedUnit.brand, model: c.installedUnit.model, purifierType: c.installedUnit.purifierType, lastTds: c.installedUnit.lastTds, pincode: c.installedUnit.pincode } : null,
        visits: c.visits.map((v) => ({ id: v.id, kind: v.kind, status: v.status, scheduledFor: v.scheduledFor, completedAt: v.completedAt, technician: v.technician?.name || null, tdsBefore: v.tdsBefore, tdsAfter: v.tdsAfter, parts: parseJsonField(v.partsReplacedJson, []) })),
        invoices: c.invoices.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, currency: i.currency, total: i.total, amountPaid: i.amountPaid, balance: Math.round((i.total - i.amountPaid) * 100) / 100, status: i.status, issuedAt: i.issuedAt })),
      })),
    });
  } catch (err) { next(err); }
});

// PUT /api/customer/appointments/:id/reschedule — customer moves their own booking
router.put('/appointments/:id/reschedule', requireCustomer, requireAppointmentCustomer, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { date, startTime, endTime } = req.body;
    if (!date || !startTime || !endTime) {
      return res.status(400).json({ message: 'date, startTime and endTime are required' });
    }

    const appt = await prisma.appointment.findFirst({
      where: { id, customerId: req.customer.id, businessId: req.customer.businessId },
      include: {
        service: { select: { name: true } },
        staff: { select: { id: true, name: true } },
        business: { select: { id: true, name: true } },
      },
    });
    if (!appt) return res.status(404).json({ message: 'Appointment not found' });
    if (appt.status === 'CANCELLED') return res.status(400).json({ message: 'Cannot reschedule a cancelled appointment' });
    if (appt.status === 'COMPLETED') return res.status(400).json({ message: 'Cannot reschedule a completed appointment' });

    const newDate = new Date(date);
    if (isNaN(newDate.getTime())) return res.status(400).json({ message: 'Invalid date' });
    if (newDate < new Date()) return res.status(400).json({ message: 'Cannot reschedule to a past date' });

    // Check the slot isn't already taken by another appointment for the same staff
    const conflict = await prisma.appointment.findFirst({
      where: {
        id: { not: id },
        staffId: appt.staffId,
        businessId: appt.businessId,
        date: newDate,
        status: { notIn: ['CANCELLED'] },
        OR: [
          { startTime: { lt: endTime }, endTime: { gt: startTime } },
        ],
      },
    });
    if (conflict) return res.status(409).json({ message: 'That slot is no longer available. Please pick another time.' });

    const updated = await prisma.appointment.update({
      where: { id },
      data: { date: newDate, startTime, endTime },
    });

    const admins = await listBusinessAdminRecipients(appt.businessId);
    await createNotifications([
      {
        businessId: appt.businessId,
        customerId: req.customer.id,
        appointmentId: appt.id,
        type: INBOX_TYPES.APPOINTMENT_RESCHEDULED ?? 'APPOINTMENT_RESCHEDULED',
        title: 'Booking rescheduled',
        body: `You rescheduled your ${appt.service?.name || 'appointment'} at ${appt.business?.name || 'the business'} to ${formatWhenLabel(updated)}.`,
      },
      ...admins.map((admin) => ({
        businessId: appt.businessId,
        userId: admin.id,
        appointmentId: appt.id,
        type: INBOX_TYPES.APPOINTMENT_RESCHEDULED ?? 'APPOINTMENT_RESCHEDULED',
        title: 'Customer rescheduled booking',
        body: `${req.customer.name} rescheduled ${appt.service?.name || 'an appointment'} with ${appt.staff?.name || 'staff'} to ${formatWhenLabel(updated)}.`,
      })),
    ]);

    res.json({ appointment: updated });
  } catch (err) {
    next(err);
  }
});

// PUT /api/customer/appointments/:id/cancel — customer cancels own appointment
router.put('/appointments/:id/cancel', requireCustomer, requireAppointmentCustomer, async (req, res, next) => {
  try {
    const { id } = req.params;
    const appt = await prisma.appointment.findFirst({
      where: { id, customerId: req.customer.id, businessId: req.customer.businessId },
      include: {
        service: { select: { name: true } },
        staff: { select: { id: true, name: true } },
        business: { select: { id: true, name: true } },
      },
    });
    if (!appt) {
      return res.status(404).json({ message: 'Appointment not found' });
    }
    if (appt.status === 'CANCELLED' || appt.status === 'COMPLETED') {
      return res.status(400).json({ message: `Cannot cancel a ${appt.status.toLowerCase()} appointment` });
    }

    const updated = await prisma.appointment.update({
      where: { id: appt.id },
      data: { status: 'CANCELLED' },
    });

    const admins = await listBusinessAdminRecipients(appt.businessId);
    await createNotifications([
      {
        businessId: appt.businessId,
        customerId: req.customer.id,
        appointmentId: appt.id,
        type: INBOX_TYPES.APPOINTMENT_CANCELLED,
        title: 'Appointment cancelled',
        body: `You cancelled your ${appt.service?.name || 'appointment'} at ${appt.business?.name || 'the business'} for ${formatWhenLabel(updated)}.`,
      },
      {
        businessId: appt.businessId,
        userId: appt.staffId,
        appointmentId: appt.id,
        type: INBOX_TYPES.CUSTOMER_CANCELLED,
        title: 'Customer cancelled booking',
        body: `${req.customer.name} cancelled ${appt.service?.name || 'an appointment'} scheduled for ${formatWhenLabel(updated)}.`,
      },
      ...admins
        .filter((admin) => admin.id !== appt.staffId)
        .map((admin) => ({
          businessId: appt.businessId,
          userId: admin.id,
          appointmentId: appt.id,
          type: INBOX_TYPES.CUSTOMER_CANCELLED,
          title: 'Customer cancelled booking',
          body: `${req.customer.name} cancelled ${appt.service?.name || 'an appointment'} with ${appt.staff?.name || 'staff'} for ${formatWhenLabel(updated)}.`,
        })),
    ]);

    res.json({ appointment: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
