const crypto = require('crypto');
const { connectedAccountStatus, createDirectCharge, verifyWebhookSignature } = require('../src/core/lib/stripeConnect');

describe('stripeConnect helpers', () => {
  const originalFetch = global.fetch;
  const originalSecret = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalSecret;
  });

  test('marks connected accounts active only when charges and payouts are enabled', () => {
    expect(connectedAccountStatus({ charges_enabled: true, payouts_enabled: true })).toBe('ACTIVE');
    expect(connectedAccountStatus({ charges_enabled: true, payouts_enabled: false })).toBe('PENDING');
    expect(connectedAccountStatus({ charges_enabled: false, payouts_enabled: true })).toBe('PENDING');
  });

  test('marks rejected or disabled connected accounts suspended', () => {
    expect(connectedAccountStatus({
      charges_enabled: false,
      payouts_enabled: false,
      requirements: { disabled_reason: 'rejected.fraud' },
    })).toBe('SUSPENDED');
  });

  test('creates direct charges on the seller connected account', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_sitepresso';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'pi_123', client_secret: 'pi_123_secret' }),
    });

    const result = await createDirectCharge({
      amountMinor: 5000,
      currency: 'NZD',
      connectedAccountId: 'acct_seller_123',
      platformFeePct: 2,
      metadata: { orderId: 'ord_1', businessId: 'biz_1' },
    });

    expect(result).toEqual({
      ok: true,
      clientSecret: 'pi_123_secret',
      paymentIntentId: 'pi_123',
      connectedAccountId: 'acct_seller_123',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/payment_intents',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Stripe-Account': 'acct_seller_123',
        }),
      }),
    );
    const body = global.fetch.mock.calls[0][1].body;
    expect(body).toContain('application_fee_amount=100');
    expect(body).toContain('metadata%5BorderId%5D=ord_1');
  });
});

// Regression for SC-02 / PAY-003 (HIGH): the Connect order webhook verifier must
// reject replays (timestamp tolerance) and accept any of multiple v1 signatures.
describe('stripeConnect.verifyWebhookSignature (Connect order webhook)', () => {
  const SECRET = 'whsec_connect_test';
  const original = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  const originalSubs = process.env.STRIPE_WEBHOOK_SECRET;
  const body = '{"id":"evt_1","type":"payment_intent.succeeded"}';
  const nowMs = 1_700_000_000_000;
  const ts = Math.floor(nowMs / 1000);
  const sign = (b, t, secret = SECRET) => crypto.createHmac('sha256', secret).update(`${t}.${b}`).digest('hex');

  beforeEach(() => { process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SECRET; });
  afterEach(() => {
    if (original === undefined) delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET; else process.env.STRIPE_CONNECT_WEBHOOK_SECRET = original;
    if (originalSubs === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = originalSubs;
  });

  test('accepts a valid signature within tolerance', () => {
    expect(verifyWebhookSignature({ body, signatureHeader: `t=${ts},v1=${sign(body, ts)}`, nowMs })).toBe(true);
  });
  test('rejects a replayed (stale) timestamp beyond tolerance', () => {
    const stale = ts - 3600;
    expect(verifyWebhookSignature({ body, signatureHeader: `t=${stale},v1=${sign(body, stale)}`, nowMs })).toBe(false);
  });
  test('accepts when one of several v1 signatures matches (secret rotation)', () => {
    expect(verifyWebhookSignature({ body, signatureHeader: `t=${ts},v1=deadbeef,v1=${sign(body, ts)}`, nowMs })).toBe(true);
  });
  test('rejects a tampered body', () => {
    expect(verifyWebhookSignature({ body: `${body}x`, signatureHeader: `t=${ts},v1=${sign(body, ts)}`, nowMs })).toBe(false);
  });
  test('rejects when no signing secret is configured', () => {
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(verifyWebhookSignature({ body, signatureHeader: `t=${ts},v1=${sign(body, ts)}`, nowMs })).toBe(false);
  });
});

describe('stripeConnect BYO (tenant-own account)', () => {
  const {
    verifyWebhookSignatureWithSecret, validateSecretKey, createPaymentIntentWithKey,
  } = require('../src/core/lib/stripeConnect');
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  describe('verifyWebhookSignatureWithSecret', () => {
    const secret = 'whsec_tenant_123';
    const body = '{"id":"evt_1","type":"payment_intent.succeeded"}';
    const nowMs = 1_700_000_000_000;
    const ts = Math.floor(nowMs / 1000);
    const sign = (b, t, s = secret) => crypto.createHmac('sha256', s).update(`${t}.${b}`).digest('hex');

    test('accepts a signature from the tenant secret', () => {
      expect(verifyWebhookSignatureWithSecret({ body, signatureHeader: `t=${ts},v1=${sign(body, ts)}`, secret, nowMs })).toBe(true);
    });
    test('REJECTS a signature made with a different secret (BYO isolation)', () => {
      expect(verifyWebhookSignatureWithSecret({ body, signatureHeader: `t=${ts},v1=${sign(body, ts, 'whsec_someone_else')}`, secret, nowMs })).toBe(false);
    });
    test('rejects a stale timestamp', () => {
      const stale = ts - 3600;
      expect(verifyWebhookSignatureWithSecret({ body, signatureHeader: `t=${stale},v1=${sign(body, stale)}`, secret, nowMs })).toBe(false);
    });
    test('rejects when no secret is given', () => {
      expect(verifyWebhookSignatureWithSecret({ body, signatureHeader: `t=${ts},v1=${sign(body, ts)}`, secret: null, nowMs })).toBe(false);
    });
  });

  describe('validateSecretKey', () => {
    test('rejects a non-secret key without calling Stripe', async () => {
      global.fetch = jest.fn();
      const r = await validateSecretKey('pk_test_abc');
      expect(r.ok).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });
    test('accepts an authenticating sk_test_ key and reports test mode', async () => {
      global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ available: [] }) }));
      expect(await validateSecretKey('sk_test_abc')).toEqual({ ok: true, mode: 'test' });
    });
    test('rejects when Stripe declines the key', async () => {
      global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: { message: 'Invalid API Key' } }) }));
      const r = await validateSecretKey('sk_live_bad');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Invalid API Key/);
    });
  });

  describe('createPaymentIntentWithKey', () => {
    test('charges on the TENANT key (no Stripe-Account, no app fee)', async () => {
      let headers = null;
      let bodyStr = null;
      global.fetch = jest.fn(async (url, opts) => {
        headers = opts.headers; bodyStr = opts.body;
        return { ok: true, json: async () => ({ id: 'pi_1', client_secret: 'pi_1_secret' }) };
      });
      const r = await createPaymentIntentWithKey({ secretKey: 'sk_test_tenant', amountMinor: 5000, currency: 'USD', metadata: { orderId: 'o1' } });
      expect(r).toEqual({ ok: true, clientSecret: 'pi_1_secret', paymentIntentId: 'pi_1' });
      expect(headers.Authorization).toBe('Bearer sk_test_tenant');
      expect(headers['Stripe-Account']).toBeUndefined();
      expect(bodyStr).not.toMatch(/application_fee_amount/);
      expect(bodyStr).toMatch(/amount=5000/);
    });
  });
});
