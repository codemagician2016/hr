'use strict';
/* Program P1.4 E2E on live staging: lifecycle template authoring (meta, CRUD,
 * task replace, default rules, seed-defaults) + probation policy CRUD +
 * validation. Self-contained; unique tags; full cleanup. */
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
  const T = 'P14-' + (Date.now() % 1000);
  let r = await call(op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator login', r.status === 200);

  // ── A. meta + template CRUD ───────────────────────────────────────────────
  r = await call(op, 'GET', '/api/hr/lifecycle/templates/meta');
  rec('Meta enums served', r.status === 200 && r.data?.stages?.ONBOARDING?.length === 7 && r.data?.owners?.includes('HR'));

  r = await call(op, 'POST', '/api/hr/lifecycle/templates', {
    name: `${T} engineering onboarding`, direction: 'ONBOARDING', countryCode: 'IN',
    tasks: [
      { stageKey: 'PRE_JOIN', title: 'Send welcome kit', ownerRole: 'HR', dueAnchor: 'OFFER_ACCEPT', dueOffsetDays: 1, isBlocking: false },
      { stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_PERSONAL', title: 'Fill personal details', ownerRole: 'NEW_HIRE', dueAnchor: 'JOIN_DATE', dueOffsetDays: -3 },
      { stageKey: 'DAY_ONE', title: 'Team lunch intro', ownerRole: 'MANAGER', dueAnchor: 'JOIN_DATE', dueOffsetDays: 0, isBlocking: false, isMandatory: false },
    ],
  });
  const tpl = r.data;
  rec('Create template with tasks', r.status === 201 && tpl?.taskDefs?.length === 3, `status ${r.status} ${r.data?.message || ''}`);
  rec('Server-minted code', /^ONBT-C\d+$/.test(tpl?.code || ''), `code=${tpl?.code}`);

  r = await call(op, 'POST', '/api/hr/lifecycle/templates', { name: 'bad', direction: 'ONBOARDING', tasks: [{ stageKey: 'NOTICE', title: 'x', ownerRole: 'HR' }] });
  rec('Offboarding stage on onboarding template rejected', r.status === 400, r.data?.message);
  r = await call(op, 'POST', '/api/hr/lifecycle/templates', { name: 'bad2', direction: 'ONBOARDING', tasks: [{ stageKey: 'DAY_ONE', title: '', ownerRole: 'HR' }] });
  rec('Empty task title rejected', r.status === 400, r.data?.message);

  // Task replace (the checklist editor's save).
  r = await call(op, 'PUT', `/api/hr/lifecycle/templates/${tpl.id}/tasks`, {
    tasks: [
      { stageKey: 'PRE_JOIN', title: 'Send welcome kit v2', ownerRole: 'HR', dueAnchor: 'OFFER_ACCEPT', dueOffsetDays: 2 },
      { stageKey: 'WEEK_ONE', taskKey: 'ASSIGN_ASSET', title: 'Issue laptop', ownerRole: 'IT', assetCategory: 'LAPTOP', dueAnchor: 'JOIN_DATE', dueOffsetDays: 2 },
    ],
  });
  rec('Replace tasks', r.status === 200 && r.data?.taskDefs?.length === 2 && r.data.taskDefs.some((t) => t.assetCategory === 'LAPTOP'));
  r = await call(op, 'PUT', `/api/hr/lifecycle/templates/${tpl.id}/tasks`, { tasks: [] });
  rec('Empty task list rejected', r.status === 400, r.data?.message);

  // Details PATCH + default handling on a NON-default template.
  r = await call(op, 'PATCH', `/api/hr/lifecycle/templates/${tpl.id}`, { name: `${T} renamed` });
  rec('Rename template', r.status === 200 && r.data?.name === `${T} renamed`);

  // The seeded stock default exists (seed-defaults idempotent) — verify guard:
  await call(op, 'POST', '/api/hr/lifecycle/templates/seed-defaults');
  r = await call(op, 'GET', '/api/hr/lifecycle/templates?direction=ONBOARDING');
  const defaults = (r.data?.items || []).filter((t) => t.isDefault && t.isActive);
  rec('Seeded defaults present', defaults.length >= 1, `defaults=${defaults.length}`);
  const soleDefault = defaults.length === 1 ? defaults[0] : null;
  if (soleDefault) {
    const g = await call(op, 'PATCH', `/api/hr/lifecycle/templates/${soleDefault.id}`, { isDefault: false });
    rec('Unsetting the only default blocked (409)', g.status === 409, `status ${g.status}`);
  } else rec('Unsetting the only default blocked (409)', 'skip', 'multiple defaults');
  r = await call(op, 'DELETE', `/api/hr/lifecycle/templates/${tpl.id}`);
  rec('Delete non-default template', r.status === 204);

  // ── B. probation policies ─────────────────────────────────────────────────
  r = await call(op, 'POST', '/api/hr/lifecycle/probation-policies', { probationDays: 120, autoConfirm: true, remindDaysBefore: 10 });
  const pol = r.data;
  rec('Create tenant-wide policy (120d, auto-confirm)', r.status === 201 && pol?.probationDays === 120 && pol?.autoConfirm === true, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(op, 'POST', '/api/hr/lifecycle/probation-policies', { probationDays: 30 });
  rec('Duplicate scope rejected (409)', r.status === 409, r.data?.message);
  r = await call(op, 'POST', '/api/hr/lifecycle/probation-policies', { employmentType: 'INTERN', probationDays: 900 });
  rec('probationDays > 730 rejected', r.status === 400, r.data?.message);
  r = await call(op, 'POST', '/api/hr/lifecycle/probation-policies', { employmentType: 'INTERN', probationDays: 30, remindDaysBefore: 5 });
  const polIntern = r.data;
  rec('Create INTERN-scoped policy (30d)', r.status === 201 && polIntern?.employmentType === 'INTERN');
  r = await call(op, 'PATCH', `/api/hr/lifecycle/probation-policies/${pol.id}`, { probationDays: 100, autoConfirm: false });
  rec('Patch policy', r.status === 200 && r.data?.probationDays === 100 && r.data?.autoConfirm === false);
  r = await call(op, 'PATCH', `/api/hr/lifecycle/probation-policies/${pol.id}`, { letterTemplateId: 'not-a-real-id' });
  rec('Foreign letter template rejected', r.status === 400, r.data?.message);
  r = await call(op, 'GET', '/api/hr/lifecycle/probation-policies');
  rec('Policies listed', (r.data?.items || []).length >= 2);

  // ── C. cleanup ────────────────────────────────────────────────────────────
  let cleaned = true;
  for (const p of [pol, polIntern]) {
    if (!p?.id) continue;
    const d = await call(op, 'DELETE', `/api/hr/lifecycle/probation-policies/${p.id}`);
    if (d.status !== 204) cleaned = false;
  }
  rec('Cleanup (policies removed)', cleaned);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P1.4 E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
