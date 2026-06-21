// Reports controller — pulls scoped appointments + hands them to the
// pure aggregator in lib/reports.js. The endpoint is admin-only and
// expects a date range in YYYY-MM-DD format (validated by Zod via the
// route).

const prisma = require('../lib/prisma');
const { computeReport } = require('../lib/reports');

// GET /api/business/reports?from=YYYY-MM-DD&to=YYYY-MM-DD&staffId=...
async function getReport(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const { from, to, staffId } = req.query;

  // Inclusive day range — convert YYYY-MM-DD to UTC midnight day-bounds
  // so a booking on the `to` day is counted regardless of its
  // startTime. Schema (reportRangeSchema) guarantees the format.
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T23:59:59.999Z`);
  if (toDate < fromDate) {
    return res.status(400).json({ message: '"to" must be on or after "from"' });
  }

  const where = {
    businessId: req.user.businessId,
    date: { gte: fromDate, lte: toDate },
  };
  if (staffId) where.staffId = staffId;

  const appointments = await prisma.appointment.findMany({
    where,
    select: {
      id: true,
      status: true,
      date: true,
      startTime: true,
      endTime: true,
      originalPrice: true,
      finalPrice: true,
      serviceId: true,
      staffId: true,
      service: { select: { id: true, name: true, price: true } },
      staff:   { select: { id: true, name: true } },
    },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  });

  const report = computeReport(appointments);
  res.json({ from, to, staffId: staffId || null, ...report });
}

// GET /api/business/appointments/export?format=csv|ical&from=&to=&staffId=
// Streams the matching appointments as CSV or iCal. Same date-range
// scoping as getReport. Sets Content-Disposition so the browser saves
// rather than opens.
const { toCsv, toIcal } = require('../lib/exporters');

async function exportAppointments(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const { format = 'csv', from, to, staffId } = req.query;
  if (!['csv', 'ical'].includes(format)) {
    return res.status(400).json({ message: "format must be 'csv' or 'ical'" });
  }

  // Schema (exportRangeSchema) guarantees from + to are YYYY-MM-DD.
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T23:59:59.999Z`);
  if (toDate < fromDate) {
    return res.status(400).json({ message: '"to" must be on or after "from"' });
  }

  const where = {
    businessId: req.user.businessId,
    date: { gte: fromDate, lte: toDate },
  };
  if (staffId) where.staffId = staffId;

  const appointments = await prisma.appointment.findMany({
    where,
    select: {
      id: true,
      status: true,
      date: true,
      startTime: true,
      endTime: true,
      notes: true,
      originalPrice: true,
      finalPrice: true,
      service: { select: { name: true, price: true } },
      staff:   { select: { name: true } },
      customer: { select: { name: true, email: true, phone: true } },
      user:     { select: { name: true, email: true } },
    },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  });

  const business = await prisma.business.findUnique({
    where: { id: req.user.businessId },
    select: { name: true },
  });

  const filenameDate = `${from}_to_${to}`;
  if (format === 'ical') {
    const body = toIcal(appointments, { businessName: business?.name || 'Sitepresso' });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="appointments_${filenameDate}.ics"`);
    return res.send(body);
  }

  const body = toCsv(appointments);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="appointments_${filenameDate}.csv"`);
  res.send(body);
}

module.exports = { getReport, exportAppointments };
