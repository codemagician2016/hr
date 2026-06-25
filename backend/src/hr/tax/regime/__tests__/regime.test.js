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
        if (update && update.regimeElectedAt) next.regimeElectedAt = update.regimeElectedAt;
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
          if (update && update.regimeElectedAt) next.regimeElectedAt = update.regimeElectedAt;
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
  // ── 1. getEffectiveRegime precedence — gated on the MARKER, not taxRegime ───
  const ELECTED_AT = new Date('2026-05-01T00:00:00.000Z');
  // (a) DELIBERATELY elected OLD (marker set) → OLD (source ELECTED), beats default.
  {
    const db = fakeDb({ sp: { taxRegime: 'OLD', regimeElectedAt: ELECTED_AT }, policy: { defaultRegime: 'NEW' } });
    const r = await regime.getEffectiveRegime({ businessId: BIZ, employeeId: EMP, fy: FY, db });
    ok('elected OLD wins → OLD', r.regime === 'OLD');
    ok('elected OLD source=ELECTED', r.source === 'ELECTED');
  }
  // (b) THE BUG: un-elected employee carries taxRegime='NEW' from @default but NO marker.
  //     With employer DEFAULT OLD this MUST resolve to OLD/DEFAULT (not ELECTED NEW).
  {
    const db = fakeDb({ sp: { taxRegime: 'NEW', regimeElectedAt: null }, policy: { defaultRegime: 'OLD' } });
    const r = await regime.getEffectiveRegime({ businessId: BIZ, employeeId: EMP, fy: FY, db });
    ok('un-elected (taxRegime=NEW, no marker) + default OLD → OLD', r.regime === 'OLD');
    ok('un-elected source=DEFAULT (not ELECTED)', r.source === 'DEFAULT');
  }
  // (c) No election + no policy → statutory NEW (source STATUTORY).
  {
    const db = fakeDb({ sp: null, policy: null });
    const r = await regime.getEffectiveRegime({ businessId: BIZ, employeeId: EMP, fy: FY, db });
    ok('no election + no policy → NEW', r.regime === 'NEW');
    ok('statutory source=STATUTORY', r.source === 'STATUTORY');
  }
  // (d) sp passed in (hot payroll path) WITH the marker is honoured without a fetch.
  {
    const db = fakeDb({ sp: null, policy: { defaultRegime: 'NEW' } });
    const r = await regime.getEffectiveRegime({ businessId: BIZ, employeeId: EMP, fy: FY, sp: { taxRegime: 'OLD', regimeElectedAt: ELECTED_AT }, db });
    ok('passed-in elected sp (marker set) honoured → OLD/ELECTED', r.regime === 'OLD' && r.source === 'ELECTED');
  }
  // (e) passed-in sp with taxRegime='OLD' but NO marker is NOT an election → default wins.
  {
    const db = fakeDb({ sp: null, policy: { defaultRegime: 'NEW' } });
    const r = await regime.getEffectiveRegime({ businessId: BIZ, employeeId: EMP, fy: FY, sp: { taxRegime: 'OLD', regimeElectedAt: null }, policy: { defaultRegime: 'NEW' }, db });
    ok('passed-in sp without marker → NOT ELECTED, falls to default NEW', r.regime === 'NEW' && r.source === 'DEFAULT');
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
      db: fakeDb({ sp: { taxRegime: 'NEW', regimeElectedAt: D('2026-05-01') }, policy: { electionLockDate: D('2020-01-01') } }),
    }),
    'WINDOW_CLOSED');

  // ── 4. electRegime() over an UN-ELECTED profile writes SP + marker + history ─
  //     The profile carries taxRegime='NEW' from @default but NO marker (un-elected).
  //     Electing OLD is a real change: marker stamped, history oldValue=null (never
  //     elected before), newValue=OLD.
  {
    const db = fakeDb({ sp: { taxRegime: 'NEW', regimeElectedAt: null }, policy: { electionLockDate: D('2999-01-01') } });
    const out = await regime.electRegime({ businessId: BIZ, employeeId: EMP, fy: FY, regime: 'OLD', actorId: 'u1', db });
    ok('elect OLD over un-elected changed=true', out.changed === true && out.regime === 'OLD');
    ok('elect writes ONE history row', db._created.history.length === 1);
    ok('history field=taxRegime old=null (un-elected) new=OLD',
      db._created.history[0].field === 'taxRegime'
      && db._created.history[0].oldValue === null
      && db._created.history[0].newValue === 'OLD');
    ok('elect stamps the marker (regimeElectedAt set)',
      db._created.spUpdates[0].regimeElectedAt instanceof Date);
    ok('history effectiveFrom = FY start (1 Apr 2026)',
      db._created.history[0].effectiveFrom.toISOString().slice(0, 10) === '2026-04-01');
  }

  // ── 4b. MEDIUM-2 — electing NEW over an un-elected profile (taxRegime already
  //     'NEW' from @default) IS a REAL change: it was never deliberately elected.
  //     Before the fix this was wrongly dropped as a no-op (no marker, no history).
  {
    const db = fakeDb({ sp: { taxRegime: 'NEW', regimeElectedAt: null }, policy: { electionLockDate: D('2999-01-01') } });
    const out = await regime.electRegime({ businessId: BIZ, employeeId: EMP, fy: FY, regime: 'NEW', actorId: 'u1', db });
    ok('elect NEW over un-elected changed=true', out.changed === true && out.regime === 'NEW');
    ok('elect NEW writes ONE history row (old=null,new=NEW)',
      db._created.history.length === 1
      && db._created.history[0].oldValue === null
      && db._created.history[0].newValue === 'NEW');
    ok('elect NEW stamps the marker', db._created.spUpdates[0].regimeElectedAt instanceof Date);
  }

  // ── 5. electRegime() idempotent ONLY against an ACTUAL prior election ──────
  //     (a) Re-electing the SAME regime when ALREADY elected (marker set) → no-op.
  {
    const db = fakeDb({ sp: { taxRegime: 'OLD', regimeElectedAt: D('2026-05-01') }, policy: { electionLockDate: D('2999-01-01') } });
    const out = await regime.electRegime({ businessId: BIZ, employeeId: EMP, fy: FY, regime: 'OLD', actorId: 'u1', db });
    ok('re-elect same ALREADY-elected regime changed=false', out.changed === false);
    ok('idempotent writes NO history row', db._created.history.length === 0);
    ok('idempotent writes NO sp update', db._created.spUpdates.length === 0);
  }
  //     (b) An un-elected profile whose taxRegime happens to be OLD electing OLD is NOT
  //         a no-op — there was no prior ELECTION, so it must persist + audit.
  {
    const db = fakeDb({ sp: { taxRegime: 'OLD', regimeElectedAt: null }, policy: { electionLockDate: D('2999-01-01') } });
    const out = await regime.electRegime({ businessId: BIZ, employeeId: EMP, fy: FY, regime: 'OLD', actorId: 'u1', db });
    ok('elect OLD over un-elected(OLD) is a REAL change', out.changed === true);
    ok('un-elected→elect writes history (old=null,new=OLD)',
      db._created.history.length === 1
      && db._created.history[0].oldValue === null
      && db._created.history[0].newValue === 'OLD');
  }

  console.log(`\nregime.service: ${passed} passed, ${failed} failed`);
  if (failed) { console.error('FAILURES:', fails.join('; ')); process.exit(1); }
})();

// Sync version of throwsCode for the pure assertElectable cases.
function throwsCodeSync(name, fn, code) {
  try { fn(); failed += 1; fails.push(`${name} (did not throw)`); console.error(`FAIL ${name} (did not throw)`); }
  catch (e) { ok(name, e && e.code === code); }
}
