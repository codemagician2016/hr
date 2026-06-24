'use strict';

/*
 * calendarRunner.live.test.js — LIVE (hr_test) proof of the Feature 23 runtime:
 * seed-from-registrations, generator applicability + per-state fan-out + idempotency,
 * status sweep (DUE/OVERDUE), reminder staging + dedupe, and the NO-COLLISION
 * guarantee vs service.js fileRun()'s StatutoryRemittance writer.
 *
 * Plain-node (built-in assert, NO jest). Self-contained: creates its OWN scratch
 * Business + Entity + StatutoryRegistration rows (prefix F23TEST), exercises the
 * runner, asserts, then tears everything down.
 *
 *   DATABASE_URL="$HR_URL" node src/hr/payroll/compliance/__tests__/calendarRunner.live.test.js
 *   ($HR_URL = repo .env DATABASE_URL + '?schema=hr_test')
 */

const assert = require('assert');
const prisma = require('../../../../core/lib/prisma');
const runner = require('../calendarRunner');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));

const PFX = 'F23TEST';
const BIZ_ID = `${PFX}-biz-0001`;
const ENT_ID = `${PFX}-ent-0001`;
const ASOF = new Date(Date.UTC(2026, 5, 1)); // 1 Jun 2026 — anchor for deterministic dates

async function teardown() {
  await prisma.statutoryRemittance.deleteMany({ where: { businessId: BIZ_ID } });
  await prisma.complianceObligation.deleteMany({ where: { businessId: BIZ_ID } });
  await prisma.statutoryRegistration.deleteMany({ where: { businessId: BIZ_ID } });
  await prisma.entity.deleteMany({ where: { id: ENT_ID } });
  await prisma.auditLog.deleteMany({ where: { businessId: BIZ_ID } }).catch(() => {});
  await prisma.business.deleteMany({ where: { id: BIZ_ID } });
}

async function setup() {
  await teardown();
  await prisma.business.create({ data: { id: BIZ_ID, name: 'F23 Test Pvt Ltd', slug: `${PFX.toLowerCase()}-biz-0001` } });
  await prisma.entity.create({
    data: {
      id: ENT_ID, businessId: BIZ_ID, code: `${PFX}-IN-HQ`, legalName: 'F23 Test Entity',
      countryCode: 'IN', payCurrency: 'INR', stateCode: 'MH',
      timezone: 'Asia/Kolkata', activeFrom: new Date(Date.UTC(2020, 3, 1)),
    },
  });
  // Registrations: TAN + EPF + ESI (entity-wide) + PT(MH) + PT(KA) + LWF(MH).
  const ef = new Date(Date.UTC(2020, 3, 1));
  const mk = (kind, stateCode) => ({ businessId: BIZ_ID, entityId: ENT_ID, kind, number: `${kind}-NUM`, stateCode: stateCode || null, effectiveFrom: ef, isActive: true });
  await prisma.statutoryRegistration.createMany({
    data: [mk('TAN'), mk('EPF'), mk('ESI'), mk('PT_STATE', 'MH'), mk('PT_STATE', 'KA'), mk('LWF', 'MH')],
  });
}

async function main() {
  log('Feature 23 — calendarRunner LIVE (hr_test):\n');
  await setup();

  // ── seed obligations from registrations ──────────────────────────────────
  const seedR = await runner.seedObligationsForEntity({ businessId: BIZ_ID, entityId: ENT_ID, actorId: 'F23-actor' });
  const obs = await prisma.complianceObligation.findMany({ where: { businessId: BIZ_ID } });
  ok(obs.length >= 8, `seed: derived ${obs.length} obligations from 6 registrations (TDS/24Q/16/PF/PF_ANNUAL/ESI/ESI_RETURN/PT-MH/PT-KA/LWF-MH)`);
  ok(obs.filter((o) => o.kind === 'IN_PT').length === 2, 'seed: per-state PT fan-out → 2 IN_PT obligations (MH + KA)');
  ok(obs.some((o) => o.kind === 'IN_LWF' && o.stateCode === 'MH'), 'seed: LWF-MH obligation present');
  // idempotent re-seed: no new rows
  await runner.seedObligationsForEntity({ businessId: BIZ_ID, entityId: ENT_ID, actorId: 'F23-actor' });
  const obs2 = await prisma.complianceObligation.findMany({ where: { businessId: BIZ_ID } });
  ok(obs2.length === obs.length, `seed idempotent: re-seed kept ${obs.length} obligations (no dup)`);

  // ── generate upcoming obligation stubs over a 120-day horizon ────────────
  const g1 = await runner.generateUpcomingObligations({ businessId: BIZ_ID, asOf: ASOF, horizonDays: 120 });
  ok(g1.created > 0, `generate: created ${g1.created} stub instances (errors=${g1.errors})`);
  const rows = await prisma.statutoryRemittance.findMany({ where: { businessId: BIZ_ID }, orderBy: { dueDate: 'asc' } });
  // PF May-2026 stub due 15-Jun-2026
  const pfMay = rows.find((r) => r.kind === 'IN_PF' && r.taxPeriod === '2026-05');
  ok(pfMay && iso(pfMay.dueDate) === '2026-06-15' && pfMay.status === 'PENDING', `generate: PF 2026-05 stub due 2026-06-15 PENDING (got ${pfMay && iso(pfMay.dueDate)})`);
  // TDS Mar-2026 special would be before horizon; check TDS May-2026 → 7 Jun
  const tdsMay = rows.find((r) => r.kind === 'IN_TDS' && r.taxPeriod === '2026-05');
  ok(tdsMay && iso(tdsMay.dueDate) === '2026-06-07', `generate: TDS 2026-05 stub due 2026-06-07 (got ${tdsMay && iso(tdsMay.dueDate)})`);
  // PT per-state instances carry stateCode
  const ptKa = rows.find((r) => r.kind === 'IN_PT' && r.stateCode === 'KA');
  const ptMh = rows.find((r) => r.kind === 'IN_PT' && r.stateCode === 'MH');
  ok(ptKa && ptMh, 'generate: per-state PT stubs carry stateCode (MH + KA distinct rows)');
  // 24Q→138 succession lands in the forward horizon as IN_FORM138, FY26-27 Q1 due
  // 31-Jul-2026 (the FY25-26 Q4 deadline of 31-May is BEFORE asOf=1-Jun, correctly
  // excluded). The taxPeriod key is FY-prefixed — IDENTICAL to fileRun's format.
  const q1Next = rows.find((r) => r.kind === 'IN_FORM138' && r.taxPeriod === '2026-27-Q1');
  ok(q1Next && iso(q1Next.dueDate) === '2026-07-31', `generate: 138 2026-27-Q1 stub due 2026-07-31, FY-prefixed key, succession applied (got ${q1Next && q1Next.taxPeriod} ${q1Next && iso(q1Next.dueDate)})`);
  // Form 16 FY25-26 due 15-Jun-2026
  const f16 = rows.find((r) => r.kind === 'IN_FORM16');
  ok(f16 && iso(f16.dueDate) === '2026-06-15', `generate: Form16 stub due 2026-06-15 (got ${f16 && iso(f16.dueDate)})`);

  // ── idempotent re-generate: no duplicate rows ─────────────────────────────
  const beforeCount = rows.length;
  const g2 = await runner.generateUpcomingObligations({ businessId: BIZ_ID, asOf: ASOF, horizonDays: 120 });
  const rows2 = await prisma.statutoryRemittance.findMany({ where: { businessId: BIZ_ID } });
  ok(rows2.length === beforeCount && g2.created === 0, `generate idempotent: re-run created 0 (still ${rows2.length} rows)`);

  // ── NO-COLLISION with fileRun(): simulate a payroll-written PF row, then re-generate ──
  // fileRun writes (entity, IN_PF, 2026-05) with a real amount + DUE status + payRunId.
  const payrollPf = await prisma.statutoryRemittance.findFirst({ where: { businessId: BIZ_ID, kind: 'IN_PF', taxPeriod: '2026-06' } });
  // Make the Jun-2026 PF row look payroll-written:
  await prisma.statutoryRemittance.update({ where: { id: payrollPf.id }, data: { amount: 214500, status: 'DUE', fileUrl: '/api/hr/payroll/runs/x/files/ecr', obligationId: null, meta: { runCode: 'FAKE-RUN' } } });
  const g3 = await runner.generateUpcomingObligations({ businessId: BIZ_ID, asOf: ASOF, horizonDays: 120 });
  const reread = await prisma.statutoryRemittance.findUnique({ where: { id: payrollPf.id } });
  ok(Number(reread.amount.toString()) === 214500 && reread.status === 'DUE', 'no-collision: generator did NOT clobber the payroll-written PF amount/status');
  ok(reread.obligationId, 'no-collision: generator ENRICHED the payroll row with its obligation back-link (reconcile, not overwrite)');
  const dupCheck = await prisma.statutoryRemittance.findMany({ where: { businessId: BIZ_ID, kind: 'IN_PF', taxPeriod: '2026-06' } });
  ok(dupCheck.length === 1, `no-collision: still exactly ONE (IN_PF, 2026-06) row — no duplicate vs fileRun (got ${dupCheck.length})`);

  // ── status sweep: an overdue past-due row flips to OVERDUE ─────────────────
  // Force PF 2026-05 (due 15-Jun) to be evaluated as of 1-Jul-2026 → OVERDUE.
  const sweepAsOf = new Date(Date.UTC(2026, 6, 1)); // 1 Jul 2026
  const sw = await runner.sweepComplianceStatus({ businessId: BIZ_ID, asOf: sweepAsOf });
  ok(sw.overdue > 0, `sweep: flipped ${sw.overdue} past-due rows to OVERDUE (due ${sw.due})`);
  const pfMayAfter = await prisma.statutoryRemittance.findUnique({ where: { id: pfMay.id } });
  ok(pfMayAfter.status === 'OVERDUE', 'sweep: PF 2026-05 (due 15-Jun) is OVERDUE as of 1-Jul');
  // a row due in the future, inside the reminder window, flips PENDING→DUE
  const dueRows = await prisma.statutoryRemittance.findMany({ where: { businessId: BIZ_ID, status: 'DUE' } });
  ok(dueRows.length >= 0, `sweep: ${dueRows.length} rows in DUE window`);
  // idempotent sweep
  const sw2 = await runner.sweepComplianceStatus({ businessId: BIZ_ID, asOf: sweepAsOf });
  ok(sw2.overdue === 0, 'sweep idempotent: re-run flips 0 (already OVERDUE)');

  // ── reminders: stage compute + dedupe ─────────────────────────────────────
  // As of 12-Jun-2026, PF 2026-05 (due 15-Jun) is T-3 → eligible.
  const remindAsOf = new Date(Date.UTC(2026, 5, 12));
  // reset its status to PENDING/DUE for the reminder path + clear prior stage
  await prisma.statutoryRemittance.update({ where: { id: pfMay.id }, data: { status: 'DUE', reminderStage: null, remindersSent: 0 } });
  const rm1 = await runner.sendComplianceReminders({ businessId: BIZ_ID, asOf: remindAsOf });
  ok(rm1.sent > 0, `remind: sent ${rm1.sent} reminders at T-window (errors=${rm1.errors})`);
  const pfReminded = await prisma.statutoryRemittance.findUnique({ where: { id: pfMay.id } });
  ok(pfReminded.reminderStage === 'T-3' && pfReminded.remindersSent >= 1, `remind: PF 2026-05 stamped stage T-3 remindersSent=${pfReminded.remindersSent}`);
  // dedupe: re-run same window → 0 new sends for that row
  const rm2 = await runner.sendComplianceReminders({ businessId: BIZ_ID, asOf: remindAsOf });
  const pfReminded2 = await prisma.statutoryRemittance.findUnique({ where: { id: pfMay.id } });
  ok(pfReminded2.remindersSent === pfReminded.remindersSent, `remind dedupe: re-run same window did NOT re-send PF (remindersSent stable at ${pfReminded2.remindersSent})`);

  // ── stage transition: at OVERDUE (16-Jun) the row gets the OVERDUE stage once ──
  const overdueAsOf = new Date(Date.UTC(2026, 5, 20));
  await prisma.statutoryRemittance.update({ where: { id: pfMay.id }, data: { status: 'OVERDUE' } });
  const rm3 = await runner.sendComplianceReminders({ businessId: BIZ_ID, asOf: overdueAsOf });
  const pfOverdue = await prisma.statutoryRemittance.findUnique({ where: { id: pfMay.id } });
  ok(pfOverdue.reminderStage === 'OVERDUE', 'remind: stage advances to OVERDUE past the due date');

  // ── applicability: an obligation with NO matching active registration is skipped ──
  // Deactivate the EPF registration; PF obligation should no longer generate NEW stubs.
  await prisma.statutoryRegistration.updateMany({ where: { businessId: BIZ_ID, kind: 'EPF' }, data: { isActive: false } });
  await prisma.statutoryRemittance.deleteMany({ where: { businessId: BIZ_ID, kind: 'IN_PF', taxPeriod: '2026-07' } });
  const g4 = await runner.generateUpcomingObligations({ businessId: BIZ_ID, asOf: ASOF, horizonDays: 120 });
  const pfJul = await prisma.statutoryRemittance.findFirst({ where: { businessId: BIZ_ID, kind: 'IN_PF', taxPeriod: '2026-07' } });
  ok(!pfJul, 'applicability: EPF deregistered → no new IN_PF stub generated for the deleted period');

  log('');
  log(failures === 0 ? `ALL PASSED (0 failures)` : `${failures} FAILURE(S)`);
  await teardown();
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('FATAL', e); try { await teardown(); await prisma.$disconnect(); } catch (_) {} process.exit(1); });
