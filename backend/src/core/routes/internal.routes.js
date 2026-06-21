// Internal diagnostics + router-support endpoints. Public, unauthenticated,
// but reveal nothing sensitive — they let smoke tests and ops scripts
// confirm the server's runtime config matches what we expect.
//
// Most endpoints here MUST:
//   - Be safe to expose (no secrets, no PII, no environment dumps)
//   - Be cheap (no DB roundtrips, no external calls)
//   - Be observable from CDN / Cloudflare without auth
//
// Exception: /tenant-vertical does a single indexed DB lookup — it's
// called only on a Redis miss (max once per tenant per 24h) by the
// internal router process, never exposed to end-users.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Constant-time string compare for the lightweight confirmation header
// (avoids the early-exit timing side-channel of `!==`).
function safeHeaderEqual(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const { isProductionDeploy, getStagingInbox } = require('../../core/lib/emailOverride');
const prisma = require('../../core/lib/prisma');
const { setTenantVertical } = require('../../core/lib/redis');
const { routableCustomDomainWhere } = require('../../core/lib/customDomainRouting');
const { resolveDomainTraffic } = require('../../domains/domainService');

const router = express.Router();

// GET /api/internal/email-mode
//
// Returns whether THIS process is in production-email mode (real
// recipients) or rerouting to the staging inbox. Smoke tests assert
// this on prod to catch a regression where someone re-introduces
// FORCE_EMAIL_OVERRIDE or flips DEPLOY_ENV away from 'production' —
// silent customer-impact bug otherwise.
//
// Response:
//   { mode: "production" | "staging", deployEnv: "<value>",
//     stagingInbox: "<email>" }
//
// stagingInbox is included so non-prod deploys can confirm WHERE
// rerouted mail lands. It is not a secret — the same address is
// hardcoded in scripts/nginx-* / readme. If you ever DO want to
// hide it, return null when mode==='production'.
router.get('/email-mode', (req, res) => {
  const inProd = isProductionDeploy();
  res.json({
    mode: inProd ? 'production' : 'staging',
    deployEnv: process.env.DEPLOY_ENV || null,
    stagingInbox: inProd ? null : getStagingInbox(),
  });
});

// POST /api/internal/repair-taxfixy-pages
// Staging-only operational repair for the TaxFixy import. Requires a lightweight
// confirmation header so random crawlers cannot trigger it by accident.
router.post('/repair-taxfixy-pages', async (req, res) => {
  if (isProductionDeploy()) return res.status(404).json({ error: 'not found' });
  if (!safeHeaderEqual(req.get('x-sitepresso-repair'), 'taxfixy-20260519')) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const seedScript = path.join(__dirname, '..', '..', '..', 'scripts', 'seed-taxfixy-web.js');
  const child = spawn(process.execPath, [seedScript], {
    cwd: path.join(__dirname, '..', '..', '..'),
    env: { ...process.env, TAXFIXY_SCRAPE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => { stdout += buf.toString(); });
  child.stderr.on('data', (buf) => { stderr += buf.toString(); });
  child.on('exit', async (code) => {
    const business = await prisma.business.findUnique({
      where: { slug: 'taxfixy' },
      select: { id: true },
    });
    const pageCount = business
      ? await prisma.businessPage.count({ where: { businessId: business.id } })
      : 0;
    res.status(code === 0 ? 200 : 500).json({
      ok: code === 0,
      code,
      pageCount,
      stdout: stdout.slice(-6000),
      stderr: stderr.slice(-6000),
    });
  });
});

// GET /api/internal/tenant-vertical?slug=<slug>
// GET /api/internal/tenant-vertical?host=<custom-domain>
// Called by the tenant router on a Redis miss to resolve which vertical
// a slug belongs to. Custom domains resolve once connected so the public
// route can render while SEO stays paused until the domain becomes ACTIVE.
// Caches the result back into Redis for 24h.
// Also used by ops seed scripts to backfill all existing tenants.
const VERTICAL_TO_ROUTER = { APPOINTMENT: 'booking', ECOMMERCE: 'shop', STATIC: 'web' };

router.get('/tenant-vertical', async (req, res) => {
  const slug = String(req.query.slug || '').toLowerCase().trim();
  const host = String(req.query.host || '').toLowerCase().trim();
  if (!slug && !host) return res.status(400).json({ error: 'slug or host required' });
  try {
    const biz = host
      ? await prisma.business.findFirst({
          where: {
            subscription: { is: routableCustomDomainWhere(host) },
          },
          select: { slug: true, vertical: true },
        })
      : await prisma.business.findUnique({
          where: { slug },
          select: { slug: true, vertical: true },
        });
    if (!biz) return res.status(404).json({ error: 'not found' });
    const dbVertical = biz.vertical || 'APPOINTMENT';
    const routerKey = VERTICAL_TO_ROUTER[dbVertical] || 'booking';
    setTenantVertical(biz.slug || slug || host, dbVertical).catch(() => {});
    return res.json({
      vertical: routerKey,
      slug: biz.slug || slug || null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'db error' });
  }
});

// GET /api/internal/domain-route?host=<custom-or-alias-domain>
// Router-facing canonicalization endpoint. It returns whether a custom host
// should serve the tenant app or 301 to the tenant's primary domain. This keeps
// multiple customer-owned domains SEO-safe without exposing admin-only data.
router.get('/domain-route', async (req, res) => {
  const host = String(req.query.host || '').toLowerCase().trim();
  if (!host) return res.status(400).json({ error: 'host required' });
  try {
    const route = await resolveDomainTraffic({ prisma, host });
    return res.json(route);
  } catch (err) {
    return res.status(err?.status || 500).json({
      error: err?.code === 'DOMAIN_ROUTE_NOT_FOUND' ? 'not found' : 'db error',
      code: err?.code || 'DOMAIN_ROUTE_ERROR',
    });
  }
});

router.get('/tenant-vertical/by-domain', async (req, res) => {
  const host = String(req.query.host || '').toLowerCase().trim();
  if (!host) return res.status(400).json({ error: 'host required' });
  try {
    const biz = await prisma.business.findFirst({
      where: {
        subscription: { is: routableCustomDomainWhere(host) },
      },
      select: { vertical: true },
    });
    if (!biz) return res.status(404).json({ error: 'not found' });
    const dbVertical = biz.vertical || 'APPOINTMENT';
    const routerKey = VERTICAL_TO_ROUTER[dbVertical] || 'booking';
    setTenantVertical(host, dbVertical).catch(() => {});
    return res.json({ vertical: routerKey });
  } catch (err) {
    return res.status(500).json({ error: 'db error' });
  }
});

module.exports = router;
