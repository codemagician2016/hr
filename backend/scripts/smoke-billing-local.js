const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const API_BASE_URL = String(
  process.env.LOCAL_API_URL
  || `http://localhost:${process.env.PORT || 3001}`
).replace(/\/$/, '');

const PLATFORM_BASE_URL = String(
  process.env.LOCAL_PLATFORM_URL
  || process.env.NEXT_PUBLIC_PLATFORM_URL
  || process.env.FRONTEND_URL
  || 'http://localhost:3002'
).replace(/\/$/, '');

const TEST_PASSWORD = 'Password123!';
const TEST_PLAN = {
  tierSlug: process.env.SMOKE_PLAN_SLUG || 'starter',
  billingCycle: process.env.SMOKE_BILLING_CYCLE || 'MONTHLY',
  country: process.env.SMOKE_COUNTRY || 'IN',
  timezone: process.env.SMOKE_TIMEZONE || 'Asia/Kolkata',
  category: process.env.SMOKE_CATEGORY || 'dental',
  theme: process.env.SMOKE_THEME || 'dental',
};

let cookieHeader = '';

function log(step, detail) {
  const suffix = detail ? ` ${detail}` : '';
  console.log(`[billing-smoke] ${step}${suffix}`);
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function captureTokenCookie(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [];
  const rawHeader = [
    ...setCookies,
    res.headers.get('set-cookie'),
  ].filter(Boolean).join('\n');

  const match = rawHeader.match(/(?:^|[\n,])\s*((?:ae_operator(?:_[^=;\s]+)?)|token)=([^;\s]+)/);
  if (match) cookieHeader = `${match[1]}=${match[2]}`;
}

async function request(pathname, { method = 'GET', json } = {}) {
  const headers = {};
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (json !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_BASE_URL}${pathname}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  captureTokenCookie(res);

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.message || `${method} ${pathname} failed with ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function requestRaw(url) {
  const res = await fetch(url);
  const text = await res.text();
  return { res, text };
}

async function main() {
  const stamp = Date.now();
  const email = `billing-smoke-${stamp}@example.com`;
  const slug = `billing-smoke-${stamp}`;
  const businessName = `Billing Smoke ${stamp}`;

  log('starting', `api=${API_BASE_URL} platform=${PLATFORM_BASE_URL}`);

  try {
    log('registering user', email);
    await request('/api/auth/register', {
      method: 'POST',
      json: {
        name: 'Billing Smoke',
        email,
        password: TEST_PASSWORD,
        acceptTerms: true,
      },
    });

    log('sending otp');
    try {
      await request('/api/auth/send-otp', {
        method: 'POST',
        json: { email },
      });
    } catch (err) {
      // Local dev often lacks working SES credentials. The OTP is still
      // persisted in the database, so continue via Prisma.
      if (!String(err.message || '').includes('Failed to send OTP email')) throw err;
      log('otp email unavailable locally', 'continuing with DB-stored OTP');
    }

    const userWithOtp = await prisma.user.findUnique({
      where: { email },
      select: { emailOtp: true },
    });
    assert(userWithOtp?.emailOtp, 'OTP was not stored for the new test user.');

    log('verifying otp');
    await request('/api/auth/verify-otp', {
      method: 'POST',
      json: {
        email,
        otp: userWithOtp.emailOtp,
      },
    });

    log('creating business', slug);
    const setup = await request('/api/business/setup', {
      method: 'POST',
      json: {
        name: businessName,
        slug,
        country: TEST_PLAN.country,
        timezone: TEST_PLAN.timezone,
        category: TEST_PLAN.category,
        email,
      },
    });
    assert(setup?.business?.slug === slug, 'Business setup did not return the expected slug.');

    log('checking initial subscription');
    const initialSubscription = await request('/api/subscription');
    assert(initialSubscription?.subscription?.tier?.slug === 'free', 'New businesses should start on the Free tier.');

    log('previewing paid plan', `${TEST_PLAN.tierSlug}/${TEST_PLAN.billingCycle}`);
    const preview = await request('/api/subscription/change-preview', {
      method: 'POST',
      json: {
        tierSlug: TEST_PLAN.tierSlug,
        billingCycle: TEST_PLAN.billingCycle,
        targetVertical: 'APPOINTMENT',
      },
    });
    assert(preview?.preview?.safeToCommit === true, 'Paid plan preview should be safe before checkout.');
    assert(preview?.preview?.money?.requiresCheckout === true, 'First paid plan preview should require checkout.');

    log('committing paid plan', `${TEST_PLAN.tierSlug}/${TEST_PLAN.billingCycle}`);
    const selection = await request('/api/subscription/change', {
      method: 'POST',
      json: {
        tierSlug: TEST_PLAN.tierSlug,
        billingCycle: TEST_PLAN.billingCycle,
        targetVertical: 'APPOINTMENT',
      },
    });

    assert(selection?.action === 'checkout', 'Paid plan selection should return action=checkout.');
    assert(selection?.transactionId, 'Paid plan selection should return a transaction id.');
    assert(selection?.checkoutUrl, 'Paid plan selection should return a checkout URL.');

    const checkoutUrl = new URL(selection.checkoutUrl);
    const checkoutOrigin = checkoutUrl.origin;
    assert(
      ['localhost', '127.0.0.1'].includes(checkoutUrl.hostname),
      `Checkout launcher should stay on a local origin, got ${checkoutUrl.origin}.`
    );
    assert(
      checkoutUrl.pathname === '/billing/checkout',
      `Checkout launcher should open /billing/checkout, got ${checkoutUrl.pathname}.`
    );

    log('checking launcher route');
    const launcher = await requestRaw(selection.checkoutUrl);
    assert(launcher.res.ok, `Checkout launcher returned ${launcher.res.status}.`);
    assert(
      launcher.text.includes('Secure checkout'),
      'Checkout launcher page did not render the expected content.'
    );

    log('checking public paddle config');
    const paddleConfig = await requestRaw(`${checkoutOrigin}/api/subscription/paddle-config`);
    assert(paddleConfig.res.ok, `Paddle config returned ${paddleConfig.res.status}.`);
    assert(
      paddleConfig.text.includes('"clientToken"'),
      'Paddle config did not include a client token.'
    );

    log('checking billing snapshot');
    const billing = await request('/api/subscription/billing');
    assert(
      billing?.overview?.paddleTransactionId === selection.transactionId,
      'Billing overview did not persist the pending Paddle transaction id.'
    );
    assert(
      Array.isArray(billing?.transactions) && billing.transactions.some((txn) => txn.id === selection.transactionId),
      'Billing history did not include the pending transaction.'
    );

    log('checking pre-payment sync fallback');
    const syncAttempt = await request('/api/subscription/sync-from-paddle', {
      method: 'POST',
      json: {},
    });
    assert(syncAttempt?.synced === false, 'Sync should stay pending before checkout is completed.');

    log('checking invoice gating');
    const invoiceRes = await fetch(`${API_BASE_URL}/api/subscription/billing/invoices/${selection.transactionId}`, {
      method: 'POST',
      headers: {
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const invoiceBody = await invoiceRes.json().catch(() => ({}));
    assert(invoiceRes.status === 409, `Draft transaction invoice should return 409, got ${invoiceRes.status}.`);
    assert(
      String(invoiceBody?.message || '').includes('PDF invoice is not available'),
      'Draft invoice response did not explain why the PDF is unavailable.'
    );

    log('checking billing portal');
    const portal = await request('/api/subscription/billing/portal', {
      method: 'POST',
      json: {},
    });
    assert(portal?.url, 'Billing portal did not return a URL.');

    console.log('');
    console.log('Local billing smoke test passed.');
    console.log(`Business slug: ${slug}`);
    console.log(`Checkout URL: ${selection.checkoutUrl}`);
    console.log('Next manual sandbox step: open the checkout URL and pay with Paddle test card 4242 4242 4242 4242, any future expiry, CVC 100.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('');
  console.error('Local billing smoke test failed.');
  console.error(err?.message || err);
  process.exitCode = 1;
});
