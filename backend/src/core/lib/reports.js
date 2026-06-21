// Pure report-aggregation helpers. Given a list of appointment rows
// (already scoped to a business + date range by the caller), compute
// the summary stats + per-day / per-hour / per-service / per-staff
// breakdowns the admin Reports tab needs.
//
// Kept pure so we can unit-test against fixtures with no DB. The
// controller does the Prisma query, then hands the rows here.

// Status buckets we consider "real revenue" vs "lost / pending".
// CONFIRMED + COMPLETED count as captured revenue; PENDING is
// revenue-at-risk; NO_SHOW + CANCELLED don't count toward revenue
// even if the customer was charged (those are billing edge cases).
const REVENUE_STATUSES = new Set(['CONFIRMED', 'COMPLETED']);

// Pull the price the customer pays. finalPrice is what the booking
// actually charged (after coupons); originalPrice is the snapshot at
// booking time; service.price is the catalogue price. Coalesce with
// that precedence so a coupon-discounted booking is counted at its
// real revenue, not the sticker.
function priceFor(appt) {
  if (typeof appt.finalPrice === 'number') return appt.finalPrice;
  if (typeof appt.originalPrice === 'number') return appt.originalPrice;
  if (appt.service && typeof appt.service.price === 'number') return appt.service.price;
  return 0;
}

function dateKey(d) {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

function hourFromHHMM(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):/);
  return m ? Number(m[1]) : null;
}

// Compute the full report shape from a list of appointments. Caller is
// responsible for scoping to a business + date range; we just count.
//
// Returned shape:
//   {
//     summary: { totalRevenue, totalBookings, completed, noShow, cancelled,
//                pending, confirmed, completionRate, noShowRate },
//     byStatus: { PENDING, CONFIRMED, COMPLETED, NO_SHOW, CANCELLED },
//     byDay: [ { date, bookings, revenue, completed, noShow, cancelled } ],
//     byHour: [ { hour, count } ]   // 0..23
//     byService: [ { serviceId, serviceName, bookings, revenue } ]
//     byStaff: [ { staffId, staffName, bookings, revenue, noShowCount } ]
//   }
function computeReport(appointments) {
  const appts = Array.isArray(appointments) ? appointments : [];

  let totalRevenue = 0;
  const byStatus = { PENDING: 0, CONFIRMED: 0, COMPLETED: 0, NO_SHOW: 0, CANCELLED: 0 };
  const dayMap = new Map();
  const hourMap = new Map();
  const serviceMap = new Map();
  const staffMap = new Map();

  for (const a of appts) {
    const status = a.status || 'PENDING';
    if (Object.prototype.hasOwnProperty.call(byStatus, status)) byStatus[status]++;

    // Revenue
    const price = priceFor(a);
    const counts = REVENUE_STATUSES.has(status);
    if (counts) totalRevenue += price;

    // By day
    const dk = dateKey(a.date);
    if (!dayMap.has(dk)) {
      dayMap.set(dk, { date: dk, bookings: 0, revenue: 0, completed: 0, noShow: 0, cancelled: 0 });
    }
    const d = dayMap.get(dk);
    d.bookings++;
    if (counts) d.revenue += price;
    if (status === 'COMPLETED') d.completed++;
    if (status === 'NO_SHOW') d.noShow++;
    if (status === 'CANCELLED') d.cancelled++;

    // By hour (start hour, 0..23)
    const hr = hourFromHHMM(a.startTime);
    if (hr !== null) {
      hourMap.set(hr, (hourMap.get(hr) || 0) + 1);
    }

    // By service
    if (a.serviceId) {
      const k = a.serviceId;
      if (!serviceMap.has(k)) {
        serviceMap.set(k, {
          serviceId: a.serviceId,
          serviceName: a.service?.name || 'Service',
          bookings: 0,
          revenue: 0,
        });
      }
      const s = serviceMap.get(k);
      s.bookings++;
      if (counts) s.revenue += price;
    }

    // By staff
    if (a.staffId) {
      const k = a.staffId;
      if (!staffMap.has(k)) {
        staffMap.set(k, {
          staffId: a.staffId,
          staffName: a.staff?.name || 'Staff',
          bookings: 0,
          revenue: 0,
          noShowCount: 0,
        });
      }
      const s = staffMap.get(k);
      s.bookings++;
      if (counts) s.revenue += price;
      if (status === 'NO_SHOW') s.noShowCount++;
    }
  }

  // Sort + finalise
  const byDay = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourMap.get(h) || 0 }));
  const byService = Array.from(serviceMap.values()).sort((a, b) => b.revenue - a.revenue || b.bookings - a.bookings);
  const byStaff = Array.from(staffMap.values()).sort((a, b) => b.revenue - a.revenue || b.bookings - a.bookings);

  const totalBookings = appts.length;
  const finishable = byStatus.PENDING + byStatus.CONFIRMED + byStatus.COMPLETED + byStatus.NO_SHOW;
  const completionRate = finishable > 0 ? byStatus.COMPLETED / finishable : 0;
  const noShowRate = finishable > 0 ? byStatus.NO_SHOW / finishable : 0;

  return {
    summary: {
      totalRevenue: round2(totalRevenue),
      totalBookings,
      completed: byStatus.COMPLETED,
      noShow: byStatus.NO_SHOW,
      cancelled: byStatus.CANCELLED,
      pending: byStatus.PENDING,
      confirmed: byStatus.CONFIRMED,
      completionRate: round4(completionRate),
      noShowRate: round4(noShowRate),
    },
    byStatus,
    byDay: byDay.map((d) => ({ ...d, revenue: round2(d.revenue) })),
    byHour,
    byService: byService.map((s) => ({ ...s, revenue: round2(s.revenue) })),
    byStaff: byStaff.map((s) => ({ ...s, revenue: round2(s.revenue) })),
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

module.exports = { computeReport, priceFor, REVENUE_STATUSES };
