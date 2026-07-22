'use strict';

/*
 * reportScheduleRunner.js — hourly delivery of scheduled report exports.
 *
 * Driven by an hourly cron block in core/lib/scheduler.js (in-process overlap
 * flag, same family as the compliance/learning sweeps). A schedule is DUE when
 * its cronPreset + anchor + hourUtc match `now` (computed PURELY — see
 * computeWindowStart / isScheduleDue, unit-tested in
 * __tests__/scheduleDue.unit.test.js) AND lastRunAt is not already inside the
 * current window (dedupe: a restarted process never double-sends).
 *
 * Each due schedule: render the definition via builder.service (under the
 * CREATOR's Feature-1 data scope, reconstructed from createdByUserId — a
 * TEAM-band creator's scheduled report stays inside their sub-tree, and a
 * creator whose access was revoked resolves to NONE → empty report, fail-
 * closed) → email the file as a real attachment to each recipient via the
 * core email util → stamp lastRunAt/lastStatus. Fail-SOFT per schedule: one
 * broken schedule never blocks the others.
 *
 * MONTHLY anchor clamping: anchor 31 fires on the month's LAST day (Feb 28/29,
 * Apr 30, …) so "end of month" schedules never silently skip short months.
 */

const prisma = require('../../core/lib/prisma');
const { renderExport } = require('./builder.service');
const { resolveAccessibleEmployeeIds } = require('../lib/scopeResolver');
const { sendTrackedEmail } = require('../../core/utils/email');

// ── pure due-ness math (unit-tested, no I/O) ─────────────────────────────────

function daysInMonthUtc(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * If `now` falls inside the schedule's current delivery window (the hour
 * [hourUtc:00, hourUtc:59] UTC of a matching day), return the window's start
 * Date; else null. PURE.
 * @param {object} schedule { cronPreset: 'DAILY'|'WEEKLY'|'MONTHLY', anchor?: number, hourUtc: number }
 * @param {Date}   now
 */
function computeWindowStart(schedule, now) {
  if (!schedule || !(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const hourUtc = Number(schedule.hourUtc);
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) return null;
  if (now.getUTCHours() !== hourUtc) return null;

  const preset = String(schedule.cronPreset || '').toUpperCase();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  if (preset === 'DAILY') {
    return new Date(Date.UTC(y, m, d, hourUtc));
  }
  if (preset === 'WEEKLY') {
    const anchor = schedule.anchor == null ? 1 : Number(schedule.anchor); // default Monday
    if (!Number.isInteger(anchor) || anchor < 0 || anchor > 6) return null;
    return now.getUTCDay() === anchor ? new Date(Date.UTC(y, m, d, hourUtc)) : null;
  }
  if (preset === 'MONTHLY') {
    const anchor = schedule.anchor == null ? 1 : Number(schedule.anchor); // default 1st
    if (!Number.isInteger(anchor) || anchor < 1 || anchor > 31) return null;
    const effectiveDay = Math.min(anchor, daysInMonthUtc(y, m)); // clamp (31 → Feb 28/29)
    return d === effectiveDay ? new Date(Date.UTC(y, m, d, hourUtc)) : null;
  }
  return null;
}

/**
 * True when the schedule should fire now: the window matches AND lastRunAt is
 * not already at/after the window start. PURE.
 * @returns {{ due: boolean, windowStart: Date|null }}
 */
function isScheduleDue(schedule, now) {
  const windowStart = computeWindowStart(schedule, now);
  if (!windowStart) return { due: false, windowStart: null };
  const last = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
  if (last && !Number.isNaN(last.getTime()) && last.getTime() >= windowStart.getTime()) {
    return { due: false, windowStart }; // already delivered (or attempted) this window
  }
  return { due: true, windowStart };
}

// ── scoped actor reconstruction ──────────────────────────────────────────────

/**
 * Rebuild the F1 scope the schedule's creator would have on a live request:
 * load the user (+ businessRole for the scope band), resolve their linked
 * Employee anchor (attachSelfEmployee equivalent), then run the same
 * resolveAccessibleEmployeeIds the HTTP middleware uses. A missing/moved user
 * resolves to NONE — the scheduled report goes out EMPTY rather than leaking
 * tenant-wide data under a dead grant (fail-closed).
 */
async function resolveCreatorScope(businessId, createdByUserId) {
  const user = createdByUserId
    ? await prisma.user.findUnique({
        where: { id: createdByUserId },
        select: { id: true, role: true, businessId: true, businessRoleId: true, businessRole: true },
      })
    : null;
  if (!user || user.businessId !== businessId) return { kind: 'NONE' };
  const emp = await prisma.employee.findFirst({
    where: { userId: user.id, businessId, deletedAt: null },
    select: { id: true, managerEmployeeId: true },
  });
  const actor = {
    id: user.id,
    role: user.role,
    businessId,
    businessRoleId: user.businessRoleId,
    businessRole: user.businessRole,
    employeeId: emp ? emp.id : null,
    managerEmployeeId: emp ? emp.managerEmployeeId : null,
  };
  return resolveAccessibleEmployeeIds(actor, 'canViewReports');
}

// ── delivery ─────────────────────────────────────────────────────────────────

function parseRecipients(recipientsJson) {
  const raw = Array.isArray(recipientsJson) ? recipientsJson : [];
  return raw
    .map((r) => String(r || '').trim())
    .filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function deliverSchedule(schedule, { asOf }) {
  const def = schedule.reportDefinition;
  if (!def || def.deletedAt) {
    return { status: 'SKIPPED: definition deleted', sent: 0 };
  }
  const recipients = parseRecipients(schedule.recipientsJson);
  if (!recipients.length) {
    return { status: 'FAILED: no valid recipients', sent: 0 };
  }

  const scope = await resolveCreatorScope(schedule.businessId, schedule.createdByUserId);
  const out = await renderExport(
    {
      datasetKey: def.datasetKey,
      columns: def.columnsJson,
      filters: def.filtersJson,
      groupBy: def.groupBy,
      sort: def.sortJson,
      name: def.name,
    },
    schedule.format,
    { businessId: schedule.businessId, scope, title: def.name },
  );

  const dateLabel = (asOf || new Date()).toISOString().slice(0, 10);
  const subject = `Scheduled report: ${def.name} — ${dateLabel}`;
  const html = `
    <p>Hi,</p>
    <p>Your scheduled DriftHR report <strong>${escapeHtml(def.name)}</strong> (${escapeHtml(schedule.cronPreset)},
    ${escapeHtml(String(schedule.format))}) for ${dateLabel} is attached — ${out.rowCount} row(s).</p>
    <p style="color:#6B7280;font-size:12px;">You are receiving this because you are a recipient on this report schedule.
    Ask your HR administrator to change or stop this delivery.</p>
  `;

  let sent = 0;
  const failures = [];
  for (const to of recipients) {
    try {
      await sendTrackedEmail({
        eventKey: 'report_schedule_delivery',
        category: 'notification',
        to,
        subject,
        htmlBody: html,
        attachments: [{ filename: out.fileName, contentType: out.contentType, content: out.content }],
        businessId: schedule.businessId,
        metadata: {
          scheduleId: schedule.id,
          reportDefinitionId: def.id,
          datasetKey: def.datasetKey,
          format: String(schedule.format),
          rowCount: out.rowCount,
        },
      });
      sent += 1;
    } catch (err) {
      failures.push(`${to}: ${err && err.message ? err.message : err}`);
    }
  }
  if (sent === 0) return { status: `FAILED: ${failures.join('; ')}`.slice(0, 500), sent };
  if (failures.length) return { status: `SENT (partial — ${failures.length} failed)`, sent };
  return { status: 'SENT', sent };
}

/**
 * The hourly sweep: find active schedules whose window is open and un-served,
 * deliver each (fail-soft), stamp lastRunAt/lastStatus.
 * @returns {{ checked, due, sent, failed, errors }}
 */
async function runDueReportSchedules({ asOf = new Date() } = {}) {
  const summary = { checked: 0, due: 0, sent: 0, failed: 0, errors: 0 };
  const schedules = await prisma.reportSchedule.findMany({
    where: { isActive: true },
    include: { reportDefinition: true },
  });
  summary.checked = schedules.length;

  for (const schedule of schedules) {
    try {
      const { due } = isScheduleDue(schedule, asOf);
      if (!due) continue;
      summary.due += 1;

      let result;
      try {
        result = await deliverSchedule(schedule, { asOf });
      } catch (err) {
        result = { status: `FAILED: ${err && err.message ? err.message : err}`.slice(0, 500), sent: 0 };
      }
      if (result.sent > 0) summary.sent += 1; else summary.failed += 1;

      // Stamp the window even on failure — one attempt per window, the next
      // window retries naturally (no hot-loop on a permanently broken schedule).
      await prisma.reportSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: asOf, lastStatus: result.status },
      }).catch((err) => {
        console.error(`[reportScheduleRunner] stamp failed for ${schedule.id}:`, err.message);
      });
    } catch (err) {
      summary.errors += 1;
      console.error(`[reportScheduleRunner] schedule ${schedule.id} failed:`, err && err.stack ? err.stack : err);
    }
  }
  return summary;
}

module.exports = {
  computeWindowStart,
  isScheduleDue,
  daysInMonthUtc,
  parseRecipients,
  deliverSchedule,
  runDueReportSchedules,
};
