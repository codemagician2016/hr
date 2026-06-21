/* eslint-disable no-console */
//
// verify-config.js — deploy-time configuration self-check.
//
// Catches the silent failure modes that broke checkout this cycle and were only
// found by a user in production:
//   - a REVOKED Paddle API key (worked → 401/403)
//   - a DELETED Paddle price catalog (TierPrice rows pointing at prices that no
//     longer exist → checkout 409 "price not configured")
//   - missing webhook secret / client token
//
// Fail-closed by design: prints ✓/⚠/✗ and exits with the failure count.
// scripts/deploy.sh blocks before PM2 reload when this exits non-zero.
//
// Run:  cd backend && node -r dotenv/config scripts/verify-config.js

const prisma = require('../src/core/lib/prisma');
const {
  getPaddleApiKey,
  getPaddleBaseUrl,
  getPaddleEnvironment,
  isPaddleConfigured,
} = require('../src/core/lib/paddle');
const {
  resolveTierPriceRecord,
  getPriceIdForBillingCycle,
} = require('../src/core/lib/subscriptionBilling');
const {
  isProductionPlatform,
  launchFreeAllowedInThisEnvironment,
} = require('../src/core/lib/launchPeriod');

let failures = 0;
const ok = (m) => console.log('  ✓', m);
const warn = (m) => console.log('  ⚠', m);
const bad = (m) => { console.log('  ✗', m); failures++; };

async function paddleGet(path) {
  return fetch(new URL(path, `${getPaddleBaseUrl()}/`), {
    headers: { Authorization: `Bearer ${getPaddleApiKey()}`, 'Paddle-Version': '1' },
  });
}

async function checkPaddlePrice(id, label) {
  if (!id) {
    bad(`${label}: no Paddle price ID configured`);
    return;
  }
  try {
    const r = await paddleGet(`prices/${id}`);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.data && j.data.status === 'active') ok(`${label} → ${id} [active]`);
    else bad(`${label} → ${id} NOT active in Paddle (${(j.error && j.error.detail) || (j.data && j.data.status) || r.status})`);
  } catch (e) {
    bad(`${label} price check error: ${e.message}`);
  }
}

async function main() {
  console.log(`== config self-check (NODE_ENV=${process.env.NODE_ENV || '?'}) ==`);

  const launchFreeUntil = String(process.env.LAUNCH_FREE_UNTIL || '').trim();
  if (launchFreeUntil) {
    const launchFreeDate = new Date(launchFreeUntil);
    if (!Number.isFinite(launchFreeDate.getTime())) {
      bad(`LAUNCH_FREE_UNTIL is not a valid date: ${launchFreeUntil}`);
    } else if (launchFreeDate > new Date() && isProductionPlatform() && !launchFreeAllowedInThisEnvironment()) {
      bad('LAUNCH_FREE_UNTIL is active on production. Clear it or set LAUNCH_FREE_ALLOW_PROD=true intentionally.');
    } else if (launchFreeDate > new Date()) {
      warn(`launch free period active until ${launchFreeDate.toISOString()}`);
    }
  }

  if (!isPaddleConfigured()) {
    warn('Paddle not configured (no PADDLE_API_KEY) — billing checks skipped');
  } else {
    console.log(`-- Paddle (${getPaddleEnvironment()}) --`);
    const rawPaddleEnvironment = String(process.env.PADDLE_ENVIRONMENT || '').trim().toLowerCase();
    const deployEnv = String(process.env.DEPLOY_ENV || process.env.ENV_LABEL || '').trim().toLowerCase();
    if (rawPaddleEnvironment && !['sandbox', 'live'].includes(rawPaddleEnvironment)) {
      bad(`PADDLE_ENVIRONMENT must be 'sandbox' or 'live' (got '${rawPaddleEnvironment}')`);
    }
    if (deployEnv === 'staging' && getPaddleEnvironment() !== 'sandbox') {
      bad('DEPLOY_ENV=staging must use PADDLE_ENVIRONMENT=sandbox');
    }
    if (isProductionPlatform() && getPaddleEnvironment() !== 'live') {
      bad('production platform must use PADDLE_ENVIRONMENT=live');
    }

    // 1) API key still valid for the catalog reads checkout depends on?
    try {
      const r = await paddleGet('prices?per_page=1');
      if (r.ok) ok('API key valid');
      else bad(`API key rejected (HTTP ${r.status}) — likely revoked/wrong account`);
    } catch (e) { bad(`API key check error: ${e.message}`); }

    // 2) Webhook secret + client token present
    if (String(process.env.PADDLE_WEBHOOK_SECRET || '').trim()) ok('webhook secret set');
    else bad('PADDLE_WEBHOOK_SECRET missing — webhooks will 500');
    const webhookTolerance = Number.parseInt(process.env.PADDLE_WEBHOOK_TOLERANCE_SECONDS || '300', 10);
    if (!Number.isFinite(webhookTolerance) || webhookTolerance <= 0 || webhookTolerance > 900) {
      bad('PADDLE_WEBHOOK_TOLERANCE_SECONDS must be between 1 and 900 seconds');
    } else {
      ok(`webhook signature tolerance ${webhookTolerance}s`);
    }
    if (String(process.env.PADDLE_CLIENT_TOKEN || '').trim()) ok('client token set');
    else {
      try {
        const r = await paddleGet('client-tokens?status=active');
        const j = await r.json().catch(() => ({}));
        const tokens = Array.isArray(j?.data) ? j.data : [];
        if (r.ok && tokens.length > 0) ok('active client token available through Paddle API');
        else bad('PADDLE_CLIENT_TOKEN missing and no active client token is readable through Paddle API');
      } catch (e) {
        bad(`client token check error: ${e.message}`);
      }
    }

    if (String(process.env.MAILBOX_ALLOW_UNPAID_PROVISIONING || '').toLowerCase() !== 'true') {
      await checkPaddlePrice(String(process.env.PADDLE_MAILBOX_PRICE_ID_MONTHLY || '').trim(), 'mailbox monthly');
      await checkPaddlePrice(String(process.env.PADDLE_MAILBOX_PRICE_ID_ANNUAL || '').trim(), 'mailbox annual');
    }

    // 3) A representative price per vertical resolves AND is live in Paddle.
    //    This is the check that would have caught the deleted catalog.
    const sample = ['solo', 'professional', 'ecom-business', 'static-starter'];
    for (const slug of sample) {
      const tier = await prisma.pricingTier.findUnique({ where: { slug }, select: { id: true } });
      if (!tier) { warn(`tier '${slug}' not in DB`); continue; }
      const row = await resolveTierPriceRecord({ tierId: tier.id, countryCode: 'US' });
      const id = getPriceIdForBillingCycle(row, 'MONTHLY');
      if (!id) { bad(`tier '${slug}': no Paddle price ID — checkout would 409`); continue; }
      await checkPaddlePrice(id, `tier '${slug}'`);
    }
  }

  console.log(failures ? `CONFIG: ${failures} failure(s)` : 'CONFIG: all checks passed');
  await prisma.$disconnect();
  process.exit(failures);
}

main().catch(async (e) => {
  console.error('verify-config fatal:', e.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
