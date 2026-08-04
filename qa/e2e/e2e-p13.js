'use strict';
/* Program P1.3 E2E on live staging: full salary-component authoring — SLAB
 * component with band editor semantics, validation 400s, floor/cap, wage flags,
 * structure preview evaluating the slab, cleanup. Self-contained. */
const A = require('./config').ADMIN;
const pb = require('./config');
const cred = (l) => pb.logins.find((x) => x.label.includes(l));
const results = [];
function rec(name, ok, d = '') { results.push(ok); console.log(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${d ? ' — ' + d : ''}`); }
function jar() { return { cookie: '' }; }
async function call(j, method, path, body) {
  const h = { 'X-Tenant-Host': 'demo.staging.drifthr.com' };
  if (j.cookie) h.Cookie = j.cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(A + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setC.length) {
    const pairs = setC.map((c) => c.split(';')[0].trim()).filter((p) => p.includes('='));
    const map = new Map((j.cookie ? j.cookie.split('; ') : []).map((p) => [p.split('=')[0], p]));
    for (const p of pairs) map.set(p.split('=')[0], p);
    j.cookie = [...map.values()].join('; ');
  }
  let data = null; try { data = await res.json(); } catch (_e) {}
  return { status: res.status, data };
}

(async () => {
  const op = jar();
  const T = 'P13' + (Date.now() % 1000); // unique per run
  let r = await call(op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator login', r.status === 200);

  // ── A. component authoring: full surface ─────────────────────────────────
  // SLAB earning banded by GROSS: ≤30k → ₹500, above → 1% of gross.
  r = await call(op, 'POST', '/api/hr/compensation/components', {
    code: T + 'SLAB', name: 'E2E attendance bonus', kind: 'CUSTOM', category: 'EARNING',
    calcMethod: 'SLAB', calcBaseScope: 'GROSS',
    slabsJson: [{ upTo: 30000, value: 500, valueType: 'FLAT' }, { upTo: null, value: 1, valueType: 'PERCENT' }],
    isWageForESI: true, prorationMethod: 'WORKING_DAYS',
  });
  const slabComp = r.data;
  rec('Create SLAB component', r.status === 201 && !!slabComp?.id, `status ${r.status} ${r.data?.message || ''}`);
  rec('derivationPass computed server-side (GROSS→2)', slabComp?.derivationPass === 2, `pass=${slabComp?.derivationPass}`);
  rec('wage flag + proration persisted', slabComp?.isWageForESI === true && slabComp?.prorationMethod === 'WORKING_DAYS');

  // Validation 400s.
  r = await call(op, 'POST', '/api/hr/compensation/components', { code: T + 'B1', name: 'bad slabs', kind: 'CUSTOM', category: 'EARNING', calcMethod: 'SLAB', calcBaseScope: 'GROSS', slabsJson: [{ upTo: 20000, value: 100, valueType: 'FLAT' }, { upTo: 10000, value: 200, valueType: 'FLAT' }] });
  rec('Descending slab bands rejected', r.status === 400, r.data?.message);
  r = await call(op, 'POST', '/api/hr/compensation/components', { code: T + 'B2', name: 'bad pct', kind: 'HRA', category: 'EARNING', calcMethod: 'PERCENT_OF', calcBaseScope: 'SINGLE' });
  rec('PERCENT_OF w/o value+base rejected', r.status === 400, r.data?.message);
  r = await call(op, 'POST', '/api/hr/compensation/components', { code: T + 'B3', name: 'bad clamp', kind: 'CUSTOM', category: 'EARNING', calcMethod: 'FLAT', calcValue: 100, floorValue: 500, capValue: 100 });
  rec('floor > cap rejected', r.status === 400, r.data?.message);
  r = await call(op, 'POST', '/api/hr/compensation/components', { code: T + 'B4', name: 'open band mid', kind: 'CUSTOM', category: 'EARNING', calcMethod: 'SLAB', calcBaseScope: 'GROSS', slabsJson: [{ upTo: null, value: 100, valueType: 'FLAT' }, { upTo: 10000, value: 200, valueType: 'FLAT' }] });
  rec('Open band not-last rejected', r.status === 400, r.data?.message);

  // PERCENT_OF named-base + floor/cap authoring (full surface persists).
  r = await call(op, 'POST', '/api/hr/compensation/components', {
    code: T + 'PCT', name: 'E2E city allowance', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING',
    calcMethod: 'PERCENT_OF', calcValue: 10, calcBaseScope: 'SINGLE', calcBaseCode: 'BASIC',
    floorValue: 300, capValue: 4000, isTaxable: true, taxSection: '17(1)', minWageFloorApplies: false,
  });
  const pctComp = r.data;
  rec('Create PERCENT_OF(BASIC) with floor/cap', r.status === 201 && pctComp?.derivationPass === 1, `pass=${pctComp?.derivationPass}`);
  rec('floor/cap + taxSection persisted', Number(pctComp?.floorValue) === 300 && Number(pctComp?.capValue) === 4000 && pctComp?.taxSection === '17(1)');

  // PATCH: switch slab base to CTC → derivationPass recomputed; bad patch rejected.
  r = await call(op, 'PATCH', `/api/hr/compensation/components/${slabComp.id}`, { calcBaseScope: 'CTC' });
  rec('PATCH recomputes derivationPass (CTC→2)', r.status === 200 && r.data?.derivationPass === 2);
  r = await call(op, 'PATCH', `/api/hr/compensation/components/${slabComp.id}`, { slabsJson: [] });
  rec('PATCH empty slabs rejected', r.status === 400, r.data?.message);
  r = await call(op, 'PATCH', `/api/hr/compensation/components/${slabComp.id}`, { calcBaseScope: 'GROSS' });
  rec('Slab base restored to GROSS', r.status === 200);

  // ── B. structure preview evaluates the slab ──────────────────────────────
  // Need a BASIC + BALANCING component for a well-formed structure. Reuse the
  // tenant's existing ones (seeded); fall back to creating tagged ones.
  r = await call(op, 'GET', '/api/hr/compensation/components?pageSize=100');
  const all = r.data?.items || [];
  let basic = all.find((c) => c.kind === 'BASIC' && c.isActive !== false);
  let bal = all.find((c) => c.calcMethod === 'BALANCING' && c.isActive !== false);
  const created = [];
  if (!basic) {
    r = await call(op, 'POST', '/api/hr/compensation/components', { code: T + 'BAS', name: 'E2E Basic', kind: 'BASIC', category: 'EARNING', calcMethod: 'PERCENT_OF', calcValue: 50, calcBaseScope: 'GROSS' });
    basic = r.data; created.push(basic);
  }
  if (!bal) {
    r = await call(op, 'POST', '/api/hr/compensation/components', { code: T + 'BAL', name: 'E2E Special', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'BALANCING' });
    bal = r.data; created.push(bal);
  }
  const basicLine = basic.calcMethod === 'PERCENT_OF'
    ? { componentId: basic.id, calcMethod: 'PERCENT_OF', calcValue: 50 }
    : { componentId: basic.id, calcMethod: 'FLAT', amountMonthly: 25000 };
  r = await call(op, 'POST', '/api/hr/compensation/structures/preview', {
    basis: 'GROSS', target: { grossMonthly: 50000 },
    lines: [basicLine, { componentId: slabComp.id, calcMethod: 'SLAB' }, { componentId: bal.id, calcMethod: 'BALANCING' }],
  });
  const lines = r.data?.resolved || [];
  const slabLine = lines.find((l) => l.code === slabComp.code);
  rec('Preview resolves', r.status === 200 && lines.length >= 3, `status ${r.status} ${r.data?.message || r.data?.error || ''}`);
  // 50k gross → above 30k band → 1% of gross = ₹500 = 50000 minor.
  rec('SLAB evaluated in preview (1% of 50k = ₹500)', slabLine && Number(slabLine.amountMonthlyMinor) === 50000, `got ${slabLine && slabLine.amountMonthlyMinor}`);
  const grossMinor = r.data?.waterfall?.grossMonthlyMinor;
  rec('Preview reconciles to target gross', Number(grossMinor) === 5000000, `gross ${grossMinor}`);

  // ── C. cleanup ───────────────────────────────────────────────────────────
  let cleaned = true;
  for (const c of [slabComp, pctComp, ...created]) {
    if (!c?.id) continue;
    const d = await call(op, 'DELETE', `/api/hr/compensation/components/${c.id}`);
    if (d.status !== 204) cleaned = false;
  }
  rec('Cleanup (tagged components removed)', cleaned);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P1.3 E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
