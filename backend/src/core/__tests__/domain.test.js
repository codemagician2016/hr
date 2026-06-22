'use strict';

/**
 * domain.test.js — Feature 3 "Self-service Domain & Branding" backend proof.
 *
 * Plain-node runner (no jest), sibling style to src/hr/__tests__/scope.rbac.test.js:
 * same fakeRes()/callController()/assert() harness, same isolated hr_test schema.
 * Cloudflare is NEVER hit for real — global.fetch is mocked per-case. DB cases
 * run against a throwaway fixture business so the seed 'demo' tenant (relied on
 * by other suites) is never mutated.
 *
 * Coverage (dev contract §5 QA):
 *   subdomainProvision:
 *     - NOT-SHARED invariant holds (dedicated !== shared)   [QA 13]
 *     - provision builds the correct CNAME body (content + comment tag) [QA 1]
 *     - deprovision REFUSES to delete when comment !== tag  [QA 3 tag-safety]
 *     - best-effort: returns {provisioned:false} when env unset (no throw)
 *   changeSlug: reserved 409, taken 409, same noop 200, cooldown 429,
 *               happy path updates slug + slugLastChangedAt + calls provision [QA 4,5]
 *   domain-config: shape + customDomainEnabled reflects CF config        [QA 17]
 *   logo fix: Business with content.logoUrl → tenant resolve logoUrl non-null [QA 15]
 *   RBAC: changeSlug / domain-config require BUSINESS_ADMIN              [QA 12]
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/core/__tests__/domain.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const assert = require('assert');
const crypto = require('crypto');
const prisma = require('../lib/prisma');

let failures = 0;
const log = (...a) => console.log(...a);
function check(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

// ── Express res()/controller doubles (copied from the scope.rbac harness) ─────
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const origJson = res.json.bind(res);
    res.json = (p) => { const r = origJson(p); done(); return r; };
    const origEnd = res.end.bind(res);
    res.end = () => { const r = origEnd(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}
// Run a route middleware (requireRole) and report whether it short-circuited
// (sent a 403) or passed through to next().
function runMiddleware(mw, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const finish = (passed) => { if (!settled) { settled = true; resolve({ res, passed }); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return finish(true); };
    const origJson = res.json.bind(res);
    res.json = (p) => { const r = origJson(p); finish(false); return r; };
    const origEnd = res.end.bind(res);
    res.end = () => { const r = origEnd(); finish(false); return r; };
    Promise.resolve(mw(req, res, next)).catch(reject);
  });
}

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ENV = process.env;
const PREFIX = 'DOMAIN-TEST';

async function main() {
  log('\n=== Feature 3 Domain & Branding backend proof (LIVE hr_test) ===\n');

  // ════════════════════════════════════════════════════════════════════════
  // subdomainProvision unit cases (env-driven; mocked fetch — never real CF)
  // ════════════════════════════════════════════════════════════════════════
  log('subdomainProvision:');
  {
    // Fresh module load with the NOT-SHARED guard in force.
    const provMod = require('../lib/subdomainProvision');
    const { DEDICATED_TUNNEL_ID, SHARED_TUNNEL_ID, hostForSlug, dedicatedTunnelTarget, tenantTag } = provMod;

    // (1) NOT-SHARED invariant — dedicated must never equal the shared tunnel.
    check(DEDICATED_TUNNEL_ID === 'c87a09e3-258a-4c7a-8ab6-b30b01055d94', 'DEDICATED_TUNNEL_ID is the dedicated tunnel');
    check(SHARED_TUNNEL_ID === '1fd39436-6495-4381-9a40-8c663b50c29a', 'SHARED_TUNNEL_ID is the shared tunnel');
    check(DEDICATED_TUNNEL_ID !== SHARED_TUNNEL_ID, 'NOT-SHARED: dedicated !== shared (module loaded => guard held)');

    // host shape — drive PLATFORM_DOMAIN explicitly (the dev .env sets it to
    // 'localhost', so hostForSlug honours whatever PLATFORM_DOMAIN is set; in
    // prod/staging this is drifthr.com).
    process.env = { ...ORIGINAL_ENV, PLATFORM_DOMAIN: 'drifthr.com' };
    check(hostForSlug('acme', true) === 'acme-staging.drifthr.com', 'hostForSlug(staging) → {slug}-staging.drifthr.com');
    check(hostForSlug('acme', false) === 'acme.drifthr.com', 'hostForSlug(prod) → {slug}.drifthr.com');
    process.env = ORIGINAL_ENV;

    // (2) provision builds the correct CNAME body — assert via mocked fetch.
    {
      process.env = { ...ORIGINAL_ENV, CLOUDFLARE_API_TOKEN: 'cf-test', CF_ZONE_ID: 'zone_test', PLATFORM_DOMAIN: 'drifthr.com' };
      const calls = [];
      let createdBody = null;
      global.fetch = async (url, options = {}) => {
        const u = String(url);
        calls.push({ u, options });
        // GET existing CNAME → none
        if (u.includes('/dns_records?') && (!options.method || options.method === 'GET')) {
          return { ok: true, json: async () => ({ success: true, result: [] }) };
        }
        // POST create
        if (u.endsWith('/dns_records') && options.method === 'POST') {
          createdBody = JSON.parse(options.body);
          return { ok: true, json: async () => ({ success: true, result: { id: 'rec_1', ...createdBody } }) };
        }
        throw new Error(`Unexpected fetch: ${u} ${options.method || 'GET'}`);
      };

      // No DB write path: pass businessId:null so provision skips subscription.update
      // (this case asserts the CNAME body only — DB binding is covered by changeSlug).
      const out = await provMod.provisionSubdomain({ businessId: null, slug: 'acme', staging: true });
      check(out.host === 'acme-staging.drifthr.com', 'provision returns the staging host');
      check(out.provisioned === true, 'provision reports provisioned:true on success');
      check(createdBody && createdBody.type === 'CNAME', 'created record is a CNAME');
      check(createdBody && createdBody.content === dedicatedTunnelTarget(), `CNAME content === ${dedicatedTunnelTarget()}`);
      check(createdBody && createdBody.content === 'c87a09e3-258a-4c7a-8ab6-b30b01055d94.cfargotunnel.com', 'CNAME points at the DEDICATED tunnel (cfargotunnel)');
      check(createdBody && createdBody.proxied === true && createdBody.ttl === 1, 'CNAME is proxied with ttl:1');
      check(createdBody && createdBody.comment === tenantTag(null), 'CNAME comment carries the drifthr-tenant tag');
      check(!JSON.stringify(createdBody).includes('1fd39436'), 'CNAME body NEVER references the shared tunnel id');
    }

    // (3) deprovision REFUSES to delete when comment !== tag (tag-safety).
    {
      process.env = { ...ORIGINAL_ENV, CLOUDFLARE_API_TOKEN: 'cf-test', CF_ZONE_ID: 'zone_test', PLATFORM_DOMAIN: 'drifthr.com' };
      let deleteCalled = false;
      global.fetch = async (url, options = {}) => {
        const u = String(url);
        if (u.includes('/dns_records?') && (!options.method || options.method === 'GET')) {
          // Record exists but is tagged for SOMEONE ELSE (e.g. demo-staging).
          return { ok: true, json: async () => ({ success: true, result: [{ id: 'rec_other', comment: 'drifthr-tenant:OTHER-BIZ' }] }) };
        }
        if (options.method === 'DELETE') { deleteCalled = true; return { ok: true, json: async () => ({ success: true, result: {} }) }; }
        throw new Error(`Unexpected fetch: ${u}`);
      };
      const out = await provMod.deprovisionSubdomain({ businessId: 'MY-BIZ', host: 'app-staging.drifthr.com' });
      check(deleteCalled === false, 'deprovision did NOT issue a DELETE for a foreign-tagged record (tag-safety)');
      check(out.refused === true && out.deprovisioned === false, 'deprovision reports refused:true / deprovisioned:false');

      // Control: a record tagged for THIS business IS deleted.
      deleteCalled = false;
      let deletedId = null;
      global.fetch = async (url, options = {}) => {
        const u = String(url);
        if (u.includes('/dns_records?') && (!options.method || options.method === 'GET')) {
          return { ok: true, json: async () => ({ success: true, result: [{ id: 'rec_mine', comment: 'drifthr-tenant:MY-BIZ' }] }) };
        }
        if (options.method === 'DELETE') { deleteCalled = true; deletedId = u.split('/').pop(); return { ok: true, json: async () => ({ success: true, result: {} }) }; }
        throw new Error(`Unexpected fetch: ${u}`);
      };
      const ok = await provMod.deprovisionSubdomain({ businessId: 'MY-BIZ', host: 'mine-staging.drifthr.com' });
      check(deleteCalled === true && deletedId === 'rec_mine' && ok.deprovisioned === true, 'deprovision DELETEs a record tagged for this business');
    }

    // (3b) WRITE tag-gate — provision REFUSES a host owned by someone else
    // (comment !== our tag): no PATCH, no subscription bind, returns refused.
    {
      process.env = { ...ORIGINAL_ENV, CLOUDFLARE_API_TOKEN: 'cf-test', CF_ZONE_ID: 'zone_test', PLATFORM_DOMAIN: 'drifthr.com' };
      let patched = false;
      let posted = false;
      global.fetch = async (url, options = {}) => {
        const u = String(url);
        const method = options.method || 'GET';
        // Existing record carries a FOREIGN comment (infra / another tenant).
        if (u.includes('/dns_records?') && method === 'GET') {
          return { ok: true, json: async () => ({ success: true, result: [{ id: 'rec_infra', content: 'something.else', comment: 'drifthr-tenant:OTHER-BIZ' }] }) };
        }
        if (method === 'PATCH') { patched = true; return { ok: true, json: async () => ({ success: true, result: {} }) }; }
        if (method === 'POST') { posted = true; return { ok: true, json: async () => ({ success: true, result: {} }) }; }
        throw new Error(`Unexpected fetch: ${method} ${u}`);
      };
      const out = await provMod.provisionSubdomain({ businessId: 'MY-BIZ', slug: 'app', staging: true });
      check(out.refused === true && out.provisioned === false && out.reason === 'host-not-owned', 'WRITE tag-gate: provision refuses a foreign-comment host (refused:true, reason:host-not-owned)');
      check(patched === false, 'WRITE tag-gate: did NOT PATCH the foreign record');
      check(posted === false, 'WRITE tag-gate: did NOT create a record over the foreign host');

      // Control: an EMPTY-comment record is ALSO refused (untagged infra host).
      global.fetch = async (url, options = {}) => {
        const u = String(url);
        const method = options.method || 'GET';
        if (u.includes('/dns_records?') && method === 'GET') {
          return { ok: true, json: async () => ({ success: true, result: [{ id: 'rec_bare', content: 'x', comment: '' }] }) };
        }
        throw new Error(`Unexpected fetch: ${method} ${u}`);
      };
      const out2 = await provMod.provisionSubdomain({ businessId: 'MY-BIZ', slug: 'demo', staging: true });
      check(out2.refused === true && out2.reason === 'host-not-owned', 'WRITE tag-gate: provision refuses an EMPTY-comment host too');

      // Control: a record tagged for THIS business IS patched/bound (ownership ok).
      let ownPatched = false;
      global.fetch = async (url, options = {}) => {
        const u = String(url);
        const method = options.method || 'GET';
        if (u.includes('/dns_records?') && method === 'GET') {
          return { ok: true, json: async () => ({ success: true, result: [{ id: 'rec_mine', content: 'drifted.value', comment: tenantTag(null) }] }) };
        }
        if (method === 'PATCH') { ownPatched = true; return { ok: true, json: async () => ({ success: true, result: {} }) }; }
        throw new Error(`Unexpected fetch: ${method} ${u}`);
      };
      const out3 = await provMod.provisionSubdomain({ businessId: null, slug: 'mine', staging: true });
      check(out3.provisioned === true && ownPatched === true, 'WRITE tag-gate: our own (tag-matched) drifted record IS patched + provisioned');
    }

    // (4) best-effort: env unset → {provisioned:false}, no throw, no fetch.
    {
      process.env = { ...ORIGINAL_ENV };
      delete process.env.CLOUDFLARE_API_TOKEN;
      let fetched = false;
      global.fetch = async () => { fetched = true; throw new Error('should not be called'); };
      let threw = false;
      let out;
      try {
        out = await provMod.provisionSubdomain({ businessId: 'x', slug: 'noenv', staging: true });
      } catch (e) { threw = true; }
      check(!threw, 'provision does NOT throw when creds are missing (best-effort)');
      check(out && out.provisioned === false, 'provision returns {provisioned:false} when token unset');
      check(fetched === false, 'no Cloudflare fetch attempted when token unset');
    }

    global.fetch = ORIGINAL_FETCH;
    process.env = ORIGINAL_ENV;
  }

  // ════════════════════════════════════════════════════════════════════════
  // customDomainRouting — only ACTIVE/verified rows route (no PENDING squat)
  // ════════════════════════════════════════════════════════════════════════
  log('\ncustomDomainRouting:');
  {
    const routing = require('../lib/customDomainRouting');
    check(
      Array.isArray(routing.ROUTABLE_CUSTOM_DOMAIN_STATUSES)
      && routing.ROUTABLE_CUSTOM_DOMAIN_STATUSES.length === 1
      && routing.ROUTABLE_CUSTOM_DOMAIN_STATUSES[0] === 'ACTIVE',
      "ROUTABLE_CUSTOM_DOMAIN_STATUSES is exactly ['ACTIVE']",
    );
    // Build a matcher and prove a PENDING_DNS / unverified row does NOT match,
    // while an ACTIVE+verified row (how subdomains are bound) DOES.
    const where = routing.routableCustomDomainWhere('shop.example.com');
    const statusBranch = (where.OR || []).find((c) => c.customDomainStatus);
    const verifiedBranch = (where.OR || []).find((c) => c.customDomainVerified === true);
    check(!!statusBranch && Array.isArray(statusBranch.customDomainStatus.in)
      && statusBranch.customDomainStatus.in.length === 1
      && statusBranch.customDomainStatus.in[0] === 'ACTIVE',
      "routableCustomDomainWhere status branch only allows 'ACTIVE'");
    // Simulate matching: a PENDING_DNS, unverified row satisfies NEITHER OR branch.
    const pendingRow = { customDomainVerified: false, customDomainStatus: 'PENDING_DNS' };
    const matchesStatus = statusBranch.customDomainStatus.in.includes(pendingRow.customDomainStatus);
    const matchesVerified = verifiedBranch.customDomainVerified === pendingRow.customDomainVerified;
    check(!matchesStatus && !matchesVerified, 'a PENDING_DNS/unverified row does NOT match routableCustomDomainWhere (no squat route)');
    // An ACTIVE+verified subdomain row still routes (matches BOTH branches).
    const activeRow = { customDomainVerified: true, customDomainStatus: 'ACTIVE' };
    check(statusBranch.customDomainStatus.in.includes(activeRow.customDomainStatus)
      && verifiedBranch.customDomainVerified === activeRow.customDomainVerified,
      'an ACTIVE+verified row still routes (subdomains unaffected)');
  }

  // ════════════════════════════════════════════════════════════════════════
  // updateCustomDomain — OFF (503) until Cloudflare-for-SaaS is configured
  // ════════════════════════════════════════════════════════════════════════
  log('\nupdateCustomDomain (v1 OFF):');
  {
    const subscriptionController = require('../controllers/subscription.controller');
    // CF custom-hostname NOT configured → 503 CUSTOM_DOMAIN_NOT_AVAILABLE.
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CLOUDFLARE_CUSTOM_HOSTNAME_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_ID;
    delete process.env.CLOUDFLARE_ZONE_ID;
    delete process.env.CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_NAME;
    delete process.env.CLOUDFLARE_ZONE_NAME;
    delete process.env.PLATFORM_DOMAIN;
    const req = { user: { id: 'u1', businessId: 'b1' }, body: { domain: 'shop.example.com' } };
    const res = await callController(subscriptionController.updateCustomDomain, req);
    check(res.statusCode === 503 && res.body?.error === 'CUSTOM_DOMAIN_NOT_AVAILABLE', 'updateCustomDomain → 503 CUSTOM_DOMAIN_NOT_AVAILABLE when CF unconfigured');
    process.env = ORIGINAL_ENV;
  }

  // ════════════════════════════════════════════════════════════════════════
  // DB-backed cases — isolated fixture business (never touch 'demo')
  // ════════════════════════════════════════════════════════════════════════
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' }, include: { subscription: true } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const tierId = demo.subscription?.tierId;
  if (!tierId) throw new Error('demo subscription has no tierId — cannot build fixture subscription');

  const fixtureSlug = `${PREFIX.toLowerCase()}-biz-${crypto.randomBytes(3).toString('hex')}`;
  async function cleanup() {
    const rows = await prisma.business.findMany({ where: { slug: { startsWith: `${PREFIX.toLowerCase()}-` } }, select: { id: true } });
    for (const r of rows) {
      await prisma.subscription.deleteMany({ where: { businessId: r.id } });
      await prisma.businessContent.deleteMany({ where: { businessId: r.id } });
      await prisma.user.deleteMany({ where: { businessId: r.id, email: { startsWith: `${PREFIX.toLowerCase()}-` } } });
      await prisma.auditLog.deleteMany({ where: { businessId: r.id } });
      await prisma.business.delete({ where: { id: r.id } });
    }
  }

  await cleanup(); // start clean

  const fixture = await prisma.business.create({
    data: { name: 'Domain Test Co', slug: fixtureSlug, vertical: 'APPOINTMENT', isActive: true },
  });
  await prisma.subscription.create({
    data: { businessId: fixture.id, tierId, status: 'ACTIVE', billingCycle: 'MONTHLY', currentPeriodEnd: new Date(Date.now() + 1e11), seatsUsed: 1 },
  });
  const fxAdmin = await prisma.user.create({
    data: { businessId: fixture.id, email: `${PREFIX.toLowerCase()}-admin@drifthr.invalid`, password: 'x', name: 'FX Admin', role: 'BUSINESS_ADMIN' },
  });

  // Mock CF so the controller's provision/deprovision can run without real CF.
  // Records are tracked in-memory so deprovision tag-gating works end-to-end.
  function installCfMock() {
    process.env = { ...ORIGINAL_ENV, CLOUDFLARE_API_TOKEN: 'cf-test', CF_ZONE_ID: 'zone_test', PLATFORM_DOMAIN: 'drifthr.com' };
    const store = new Map(); // host → { id, content, comment }
    const provisionedHosts = [];
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      const method = options.method || 'GET';
      if (u.includes('/dns_records?') && method === 'GET') {
        const name = decodeURIComponent((u.match(/name=([^&]+)/) || [])[1] || '');
        const rec = store.get(name);
        return { ok: true, json: async () => ({ success: true, result: rec ? [rec] : [] }) };
      }
      if (u.endsWith('/dns_records') && method === 'POST') {
        const body = JSON.parse(options.body);
        const rec = { id: `rec_${store.size + 1}`, ...body };
        store.set(body.name, rec);
        provisionedHosts.push(body.name);
        return { ok: true, json: async () => ({ success: true, result: rec }) };
      }
      if (u.includes('/dns_records/') && method === 'DELETE') {
        const id = u.split('/').pop();
        for (const [k, v] of store) if (v.id === id) store.delete(k);
        return { ok: true, json: async () => ({ success: true, result: {} }) };
      }
      throw new Error(`Unexpected fetch: ${method} ${u}`);
    };
    return { store, provisionedHosts };
  }

  const businessController = require('../controllers/business.controller');
  const { ROLES } = require('../lib/roles');

  try {
    // ── changeSlug: reserved → 409 ────────────────────────────────────────────
    log('\nchangeSlug:');
    {
      installCfMock();
      const req = { user: { id: fxAdmin.id, businessId: fixture.id, role: ROLES.BUSINESS_ADMIN }, body: { slug: 'admin' } };
      const res = await callController(businessController.changeSlug, req);
      check(res.statusCode === 409 && res.body?.reason === 'reserved', 'reserved slug "admin" → 409 {reason:reserved}');
    }

    // ── changeSlug: reserved 'demo' / 'saas-origin' → 409 {reason:reserved} ────
    // (these are staging-host prefixes added to RESERVED_SLUGS by the Feature 3
    // security fix — must be refused before any uniqueness/DNS work).
    {
      installCfMock();
      const reqDemo = { user: { id: fxAdmin.id, businessId: fixture.id, role: ROLES.BUSINESS_ADMIN }, body: { slug: 'demo' } };
      const resDemo = await callController(businessController.changeSlug, reqDemo);
      check(resDemo.statusCode === 409 && resDemo.body?.reason === 'reserved', 'reserved slug "demo" → 409 {reason:reserved}');

      installCfMock();
      const reqSaas = { user: { id: fxAdmin.id, businessId: fixture.id, role: ROLES.BUSINESS_ADMIN }, body: { slug: 'saas-origin' } };
      const resSaas = await callController(businessController.changeSlug, reqSaas);
      check(resSaas.statusCode === 409 && resSaas.body?.reason === 'reserved', 'reserved slug "saas-origin" → 409 {reason:reserved}');
    }

    // ── changeSlug: taken → 409 (existing non-reserved seed 'globex') ──────────
    {
      installCfMock();
      const req = { user: { id: fxAdmin.id, businessId: fixture.id, role: ROLES.BUSINESS_ADMIN }, body: { slug: 'globex' } };
      const res = await callController(businessController.changeSlug, req);
      check(res.statusCode === 409 && res.body?.reason === 'taken', 'taken slug "globex" → 409 {reason:taken}');
    }

    // ── changeSlug: same slug → 200 noop ──────────────────────────────────────
    {
      installCfMock();
      const req = { user: { id: fxAdmin.id, businessId: fixture.id, role: ROLES.BUSINESS_ADMIN }, body: { slug: fixtureSlug } };
      const res = await callController(businessController.changeSlug, req);
      check(res.statusCode === 200 && res.body?.unchanged === true && res.body?.slug === fixtureSlug, 'same slug → 200 {unchanged:true}');
      const reloaded = await prisma.business.findUnique({ where: { id: fixture.id } });
      check(reloaded.slugLastChangedAt === null, 'noop did NOT stamp slugLastChangedAt');
    }

    // ── changeSlug: happy path → updates slug + stamp + calls provision ───────
    let newSlug;
    {
      const { provisionedHosts } = installCfMock();
      newSlug = `${PREFIX.toLowerCase()}-new-${crypto.randomBytes(2).toString('hex')}`;
      const req = { user: { id: fxAdmin.id, businessId: fixture.id, role: ROLES.BUSINESS_ADMIN }, body: { slug: newSlug } };
      const res = await callController(businessController.changeSlug, req);
      check(res.statusCode === 200 && res.body?.slug === newSlug, 'happy path → 200 {slug:new}');
      check(res.body?.url === `https://${newSlug}-staging.drifthr.com`, 'happy path returns the new staging URL');
      const reloaded = await prisma.business.findUnique({ where: { id: fixture.id }, include: { subscription: true } });
      check(reloaded.slug === newSlug, 'business.slug updated to the new slug');
      check(reloaded.slugLastChangedAt !== null, 'slugLastChangedAt stamped on change');
      check(provisionedHosts.includes(`${newSlug}-staging.drifthr.com`), 'provisionSubdomain wrote the new CNAME (mock saw the POST)');
      check(reloaded.subscription?.customDomain === `${newSlug}-staging.drifthr.com` && reloaded.subscription?.customDomainStatus === 'ACTIVE', 'subscription bound to new host ACTIVE/verified');
      const audit = await prisma.auditLog.findFirst({ where: { businessId: fixture.id, action: 'business.slug.change' } });
      check(!!audit, "audit row 'business.slug.change' written");
    }

    // ── changeSlug: cooldown → 429 (slugLastChangedAt now stamped) ─────────────
    {
      installCfMock();
      const req = { user: { id: fxAdmin.id, businessId: fixture.id, role: ROLES.BUSINESS_ADMIN }, body: { slug: `${PREFIX.toLowerCase()}-toosoon` } };
      const res = await callController(businessController.changeSlug, req);
      check(res.statusCode === 429 && res.body?.reason === 'cooldown' && !!res.body?.nextAvailableAt, 'within 30 days → 429 {reason:cooldown, nextAvailableAt}');
    }

    // ── changeSlug: deprovisions the STORED host (not a re-derived one) ───────
    // FIX 4b: the old host torn down must be the actual subscription.customDomain
    // value, even if it differs from hostForSlug(oldSlug). We stamp a stored host
    // that is INTENTIONALLY different from the current slug's derived host and
    // prove THAT is the record deleted.
    {
      // Reset the cooldown so this change is allowed.
      await prisma.business.update({ where: { id: fixture.id }, data: { slugLastChangedAt: null } });
      const storedHost = `${PREFIX.toLowerCase()}-stored-${crypto.randomBytes(2).toString('hex')}.drifthr.com`;
      await prisma.subscription.update({ where: { businessId: fixture.id }, data: { customDomain: storedHost, customDomainStatus: 'ACTIVE', customDomainVerified: true } });

      // CF mock pre-seeded with the stored host tagged for THIS business so the
      // tag-gated deprovision can delete it; tracks every DELETEd host.
      process.env = { ...ORIGINAL_ENV, CLOUDFLARE_API_TOKEN: 'cf-test', CF_ZONE_ID: 'zone_test', PLATFORM_DOMAIN: 'drifthr.com' };
      const { tenantTag } = require('../lib/subdomainProvision');
      const store = new Map();
      store.set(storedHost, { id: 'rec_stored', content: 'x', comment: tenantTag(fixture.id) });
      const deletedHosts = [];
      global.fetch = async (url, options = {}) => {
        const u = String(url);
        const method = options.method || 'GET';
        if (u.includes('/dns_records?') && method === 'GET') {
          const name = decodeURIComponent((u.match(/name=([^&]+)/) || [])[1] || '');
          const rec = store.get(name);
          return { ok: true, json: async () => ({ success: true, result: rec ? [rec] : [] }) };
        }
        if (u.endsWith('/dns_records') && method === 'POST') {
          const body = JSON.parse(options.body);
          store.set(body.name, { id: `rec_${store.size + 1}`, ...body });
          return { ok: true, json: async () => ({ success: true, result: store.get(body.name) }) };
        }
        if (u.includes('/dns_records/') && method === 'DELETE') {
          const id = u.split('/').pop();
          for (const [k, v] of store) if (v.id === id) { deletedHosts.push(k); store.delete(k); }
          return { ok: true, json: async () => ({ success: true, result: {} }) };
        }
        throw new Error(`Unexpected fetch: ${method} ${u}`);
      };
      const nextSlug = `${PREFIX.toLowerCase()}-cut-${crypto.randomBytes(2).toString('hex')}`;
      const req = { user: { id: fxAdmin.id, businessId: fixture.id, role: ROLES.BUSINESS_ADMIN }, body: { slug: nextSlug } };
      const res = await callController(businessController.changeSlug, req);
      check(res.statusCode === 200 && res.body?.slug === nextSlug, 'changeSlug (stored-host case) → 200');
      check(deletedHosts.includes(storedHost), 'changeSlug deprovisioned the STORED subscription.customDomain host (not a re-derived one)');
    }

    // ── provisionSubdomain / changeSlug: P2002 on duplicate customDomain → 409 ─
    // FIX 4a: with customDomain @unique, binding a host already owned by another
    // tenant raises Prisma P2002 → provision returns refused:taken → changeSlug
    // surfaces 409 {reason:taken} and does NOT write the slug. A throwaway second
    // fixture (cleaned up by the PREFIX cleanup) holds the colliding host.
    {
      await prisma.business.update({ where: { id: fixture.id }, data: { slugLastChangedAt: null } });
      const before = await prisma.business.findUnique({ where: { id: fixture.id } });

      const collideSlug = `${PREFIX.toLowerCase()}-dup-${crypto.randomBytes(2).toString('hex')}`;
      const collideHost = `${collideSlug}-staging.drifthr.com`;
      // Second fixture that ALREADY owns collideHost (unique value occupied).
      const otherBiz = await prisma.business.create({
        data: { name: 'Dup Owner Co', slug: `${PREFIX.toLowerCase()}-owner-${crypto.randomBytes(3).toString('hex')}`, vertical: 'APPOINTMENT', isActive: true },
      });
      await prisma.subscription.create({
        data: { businessId: otherBiz.id, tierId, status: 'ACTIVE', billingCycle: 'MONTHLY', currentPeriodEnd: new Date(Date.now() + 1e11), seatsUsed: 1, customDomain: collideHost, customDomainStatus: 'ACTIVE', customDomainVerified: true },
      });

      installCfMock(); // GET/POST work; the DB bind is what raises P2002.
      const req = { user: { id: fxAdmin.id, businessId: fixture.id, role: ROLES.BUSINESS_ADMIN }, body: { slug: collideSlug } };
      const res = await callController(businessController.changeSlug, req);
      check(res.statusCode === 409 && res.body?.reason === 'taken', 'duplicate customDomain bind → changeSlug 409 {reason:taken}');
      const after = await prisma.business.findUnique({ where: { id: fixture.id } });
      check(after.slug === before.slug, 'slug NOT written when the new host is already taken (P2002)');
    }

    // ── domain-config: shape + customDomainEnabled reflects CF config ─────────
    log('\ndomain-config:');
    {
      // CF custom-hostname NOT configured → false.
      process.env = { ...ORIGINAL_ENV };
      delete process.env.CLOUDFLARE_CUSTOM_HOSTNAME_TOKEN;
      delete process.env.CLOUDFLARE_API_TOKEN;
      delete process.env.CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_ID;
      delete process.env.CLOUDFLARE_ZONE_ID;
      delete process.env.CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_NAME;
      delete process.env.CLOUDFLARE_ZONE_NAME;
      delete process.env.PLATFORM_DOMAIN;
      const res = await callController(businessController.getDomainConfig, { user: { id: fxAdmin.id, businessId: fixture.id, role: ROLES.BUSINESS_ADMIN } });
      check(res.statusCode === 200, 'domain-config → 200');
      check(typeof res.body?.customDomainEnabled === 'boolean', 'customDomainEnabled is a boolean');
      check(res.body?.customDomainEnabled === false, 'customDomainEnabled false when CF custom-hostname unconfigured');
      check(res.body?.platformDomain === 'drifthr.com', 'platformDomain defaults to drifthr.com');
      check(typeof res.body?.subdomainSuffix === 'string' && res.body.subdomainSuffix.endsWith('drifthr.com'), 'subdomainSuffix present and ends with drifthr.com');
      check('targetCname' in res.body, 'targetCname key present');

      // CF configured → true (token + zone id set).
      process.env = { ...ORIGINAL_ENV, CLOUDFLARE_CUSTOM_HOSTNAME_TOKEN: 'cf', CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_ID: 'z1' };
      const res2 = await callController(businessController.getDomainConfig, { user: { id: fxAdmin.id, businessId: fixture.id, role: ROLES.BUSINESS_ADMIN } });
      check(res2.body?.customDomainEnabled === true, 'customDomainEnabled true when CF custom-hostname configured');
      process.env = ORIGINAL_ENV;
    }

    // ── logo fix: Business with content.logoUrl → resolve payload logoUrl ─────
    log('\nlogo fix:');
    {
      process.env = ORIGINAL_ENV;
      global.fetch = ORIGINAL_FETCH;
      const LOGO = 'https://cdn.drifthr.com/logos/fixture.png';
      await prisma.businessContent.upsert({
        where: { businessId: fixture.id },
        create: { businessId: fixture.id, logoUrl: LOGO },
        update: { logoUrl: LOGO },
      });
      const tenantController = require('../controllers/tenant.controller');
      const reloaded = await prisma.business.findUnique({ where: { id: fixture.id } });
      const req = { query: { slug: reloaded.slug }, get: () => undefined, _selfContext: true, user: { id: fxAdmin.id, businessId: fixture.id } };
      const res = await callController(tenantController.resolve, req);
      // The themed payload carries the logo through resolveTenantTheme(logoUrl).
      const themeLogo = res.body?.theme?.logoUrl ?? res.body?.bookingTheme?.logoUrl ?? res.body?.hrTheme?.logoUrl;
      check(res.statusCode === 200, 'tenant resolve → 200 for fixture with logo');
      check(themeLogo === LOGO, 'resolved theme logoUrl is the content.logoUrl (non-null) — logo bug fixed');
    }

    // ── RBAC: changeSlug / domain-config require BUSINESS_ADMIN ───────────────
    log('\nRBAC (require BUSINESS_ADMIN):');
    {
      const { requireRole } = require('../middleware/auth.middleware');
      const guard = requireRole(ROLES.BUSINESS_ADMIN);
      // A STAFF/USER actor must be 403'd by the route guard.
      const staffReq = { user: { id: 'staff-1', businessId: fixture.id, role: ROLES.STAFF } };
      const blocked = await runMiddleware(guard, staffReq);
      check(!blocked.passed && blocked.res.statusCode === 403, 'STAFF blocked by requireRole(BUSINESS_ADMIN) → 403 (gates /slug + /domain-config)');
      // An admin actor passes the guard through to the handler.
      const adminReq = { user: { id: fxAdmin.id, businessId: fixture.id, role: ROLES.BUSINESS_ADMIN } };
      const allowed = await runMiddleware(guard, adminReq);
      check(allowed.passed, 'BUSINESS_ADMIN passes requireRole(BUSINESS_ADMIN)');
    }
  } finally {
    global.fetch = ORIGINAL_FETCH;
    process.env = ORIGINAL_ENV;
    await cleanup();
  }

  log(`\n=== ${failures === 0 ? 'ALL DOMAIN CHECKS PASSED' : `${failures} DOMAIN CHECK(S) FAILED`} ===\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Domain test crashed:', err);
  try { global.fetch = ORIGINAL_FETCH; } catch (_e) { /* ignore */ }
  try { await prisma.$disconnect(); } catch (_e) { /* ignore */ }
  process.exit(2);
});
