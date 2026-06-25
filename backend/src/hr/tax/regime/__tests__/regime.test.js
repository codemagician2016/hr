'use strict';

/*
 * regime.test.js — Feature 15/25 PURE (DB-free) unit test for the income-tax REGIME
 * election service. Plain-node assert (no jest, no real DB — a tiny fake `db` stands in
 * for prisma so the resolver + window/lock enforcement are proven without a database):
 *   node backend/src/hr/tax/regime/__tests__/regime.test.js
 *
 * Proves the two contracts the withholding correctness hinges on:
 *   1. getEffectiveRegime FALLBACK precedence:
 *        elected (StatutoryProfile.taxRegime) → employer DEFAULT (TaxRegimePolicy)
 *        → statutory NEW. An un-elected employee is withheld under the EMPLOYER DEFAULT.
 *   2. The WINDOW / LOCK enforcement: an election is REJECTED when past the lock date,
 *        before the open date, globally locked, or the employee is individually locked.
 *      And electRegime() refuses a past-lock-date election end-to-end (fake db).
 */

const assert = require('assert');
const regime = require('../regime.service');
const { assertElectable } = regime._internals;

let passed = 0; let failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed += 1; } else { failed += 1; fails.push(name); console.error(`FAIL ${name}`); }
}
async function throwsCode(name, fn, code) {
  try { await fn(); failed += 1; fails.push(`${name} (did not throw)`); console.error(`FAIL ${name} (did not throw)`); }
  catch (e) { ok(name, e && e.code === code); }
}

const BIZ = 'biz-1';
const EMP = 'emp-1';
const FY = '2026-27';

// A minimal fake prisma: each model exposes only the methods the service calls.
function fakeDb({ sp = null, policy = null, emp = { id: EMP, countryCode: 'IN' } } = {}) {
  const created = { history: [], spUpdates: [] };
  return {
    _created: created,
    employee: {
      findFirst: async () => emp,
    },
    statutoryProfile: {
      findFirst: async () => sp,
      upsert: async ({ update, create }) => {
        const next = { id: 'sp-1', ...(sp || {}), ...(create || {}), ...(update || {}) };
        if (update && update.taxRegime) next.taxRegime = update.taxRegime;
        created.spUpdates.push(next);
        return next;
      },
      updateMany: async () => ({ count: 1 }),
    },
    statutoryElectionHistory: {
      create: async ({ data }) => { created.history.push(data); return data; },
    },
    taxRegimePolicy: {
      findFirst: async () => policy,
    },
    $transaction: async (fn) => fn({
      statutoryProfile: {
        upsert: async ({ update, create }) => {
          const next = { id: 'sp-1', ...(sp || {}), ...(create || {}), ...(update || {}) };
          if (update && update.taxRegime) next.taxRegime = update.taxRegime;
          created.spUpdates.push(next);
          return next;
        },
      },
      statutoryElectionHistory: {
        create: async ({ data }) => { created.history.push(data); return data; },
      },
    }),
  };
}

(async () => {
  // ── 1. getEffectiveRegime FALLBACK precedence ──────────────────────────────
  // (a) Employee ELECTED OLD → OLD (source ELECTED), regardless of default.
  {
    const db = fakeDb({ sp: { taxRegime: 'OLD' }, policy: { defaultRegime: 'NEW' } });
    const r = await regime.getEffectiveRegime({ businessId: BIZ, employeeId: EMP, fy: FY, db });
    ok('elected OLD wins → OLD', r.regime === 'OLD');
    ok('elected OLD source=ELECTED', r.source === 'ELECTED');
  }
  // (b) Un-elected (no taxRegime) + employer DEFAULT OLD → OLD (source DEFAULT).
  {
    const db = fakeDb({ sp: { taxRegime: null }, policy: { defaultRegime: 'OLD' } });
    const r = await regime.getEffectiveRegime({ businessId: BIZ, employeeId: EMP, fy: FY, db });
    ok('un-elected falls back to default OLD → OLD', r.regime === 'OLD');
    ok('un-elected source=DEFAULT', r.source === 'DEFAULT');
  }
  // (c) No election + no policy → statutory NEW (source STATUTORY).
  {
    const db = fakeDb({ sp: null, policy: null });
    const r = await regime.getEffectiveRegime({ businessId: BIZ, employeeId: EMP, fy: FY, db });
    ok('no election + no policy → NEW', r.regime === 'NEW');
    ok('statutory source=STATUTORY', r.source === 'STATUTORY');
  }
  // (d) sp passed in (hot payroll path) is honoured without a fetch.
  {
    const db = fakeDb({ sp: null, policy: { defaultRegime: 'NEW' } });
    const r = await regime.getEffectiveRegime({ businessId: BIZ, employeeId: EMP, fy: FY, sp: { taxRegime: 'OLD' }, db });
    ok('passed-in sp.taxRegime=OLD honoured → OLD', r.regime === 'OLD' && r.source === 'ELECTED');
  }

  // ── 2. WINDOW / LOCK enforcement (assertElectable — pure) ──────────────────
  const D = (s) => new Date(`${s}T00:00:00.000Z`);
  // (a) past the lock date → WINDOW_CLOSED.
  throwsCodeSync('past lock date → WINDOW_CLOSED',
    () => assertElectable({ profile: null, policy: { electionLockDate: D('2026-12-31') }, now: D('2027-01-01') }),
    'WINDOW_CLOSED');
  // (b) before the open date → WINDOW_NOT_OPEN.
  throwsCodeSync('before open date → WINDOW_NOT_OPEN',
    () => assertElectable({ profile: null, policy: { electionOpenFrom: D('2026-04-01') }, now: D('2026-03-01') }),
    'WINDOW_NOT_OPEN');
  // (c) global lock → GLOBAL_LOCK.
  throwsCodeSync('global lock → GLOBAL_LOCK',
    () => assertElectable({ profile: null, policy: { lockedGlobally: true }, now: D('2026-06-01') }),
    'GLOBAL_LOCK');
  // (d) per-employee lock → REGIME_LOCKED.
  throwsCodeSync('regimeLockedAt → REGIME_LOCKED',
    () => assertElectable({ profile: { regimeLockedAt: D('2026-06-01') }, policy: null, now: D('2026-07-01') }),
    'REGIME_LOCKED');
  // (e) inside the window, no lock → electable (no throw).
  {
    let threw = false;
    try { assertElectable({ profile: null, policy: { electionOpenFrom: D('2026-04-01'), electionLockDate: D('2026-12-31') }, now: D('2026-06-01') }); }
    catch (_e) { threw = true; }
    ok('inside window, no lock → electable', threw === false);
  }
  // (f) no policy at all → fail-open (electable).
  {
    let threw = false;
    try { assertElectable({ profile: null, policy: null, now: new Date() }); }
    catch (_e) { threw = true; }
    ok('no policy → fail-open electable', threw === false);
  }

  // ── 3. electRegime() end-to-end refuses a past-lock-date election ──────────
  await throwsCode('electRegime past lock date → WINDOW_CLOSED',
    () => regime.electRegime({
      businessId: BIZ, employeeId: EMP, fy: FY, regime: 'OLD', actorId: 'u1',
      db: fakeDb({ sp: { taxRegime: 'NEW' }, policy: { electionLockDate: D('2020-01-01') } }),
    }),
    'WINDOW_CLOSED');

  // ── 4. electRegime() inside window writes SP + history (audit trail) ───────
  {
    const db = fakeDb({ sp: { taxRegime: 'NEW' }, policy: { electionLockDate: D('2999-01-01') } });
    const out = await regime.electRegime({ businessId: BIZ, employeeId: EMP, fy: FY, regime: 'OLD', actorId: 'u1', db });
    ok('elect OLD changed=true', out.changed === true && out.regime === 'OLD');
    ok('elect writes ONE history row', db._created.history.length === 1);
    ok('history field=taxRegime old=NEW new=OLD',
      db._created.history[0].field === 'taxRegime'
      && db._created.history[0].oldValue === 'NEW'
      && db._created.history[0].newValue === 'OLD');
    ok('history effectiveFrom = FY start (1 Apr 2026)',
      db._created.history[0].effectiveFrom.toISOString().slice(0, 10) === '2026-04-01');
  }

  // ── 5. electRegime() idempotent: electing the same regime is a no-op ───────
  {
    const db = fakeDb({ sp: { taxRegime: 'OLD' }, policy: { electionLockDate: D('2999-01-01') } });
    const out = await regime.electRegime({ businessId: BIZ, employeeId: EMP, fy: FY, regime: 'OLD', actorId: 'u1', db });
    ok('re-elect same regime changed=false', out.changed === false);
    ok('idempotent writes NO history row', db._created.history.length === 0);
  }

  console.log(`\nregime.service: ${passed} passed, ${failed} failed`);
  if (failed) { console.error('FAILURES:', fails.join('; ')); process.exit(1); }
})();

// Sync version of throwsCode for the pure assertElectable cases.
function throwsCodeSync(name, fn, code) {
  try { fn(); failed += 1; fails.push(`${name} (did not throw)`); console.error(`FAIL ${name} (did not throw)`); }
  catch (e) { ok(name, e && e.code === code); }
}
