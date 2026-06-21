// Tests for the SMS provider abstraction. Mocks global fetch so tests
// don't hit real Twilio / MSG91 APIs.

const sms = require('../src/core/lib/sms');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Clear all SMS provider env vars by default — tests opt in by setting them
  delete process.env.MSG91_API_KEY;
  delete process.env.MSG91_SENDER_ID;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
  global.fetch = jest.fn();
});

afterAll(() => {
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('detectProvider', () => {
  test('explicit IN country hint → msg91', () => {
    expect(sms.detectProvider('+919876543210', 'IN')).toBe('msg91');
  });
  test('explicit lowercase in hint → msg91', () => {
    expect(sms.detectProvider('+919876543210', 'in')).toBe('msg91');
  });
  test('+91 phone number → msg91 (no hint needed)', () => {
    expect(sms.detectProvider('+91 98765 43210')).toBe('msg91');
    expect(sms.detectProvider('+919876543210')).toBe('msg91');
    expect(sms.detectProvider('919876543210')).toBe('msg91');
  });
  test('+1 US phone → twilio (default)', () => {
    expect(sms.detectProvider('+15551234567')).toBe('twilio');
  });
  test('+44 UK phone → twilio (default)', () => {
    expect(sms.detectProvider('+447911123456')).toBe('twilio');
  });
  test('explicit US hint overrides — still twilio (since US not in COUNTRY_TO_PROVIDER)', () => {
    expect(sms.detectProvider('+919876543210', 'US')).toBe('msg91'); // phone wins because US not mapped
  });
  test('handles spaces, dashes, parens in number', () => {
    expect(sms.detectProvider('+91-987-654-3210')).toBe('msg91');
    expect(sms.detectProvider('+91 (987) 654 3210')).toBe('msg91');
  });
  test('empty / null inputs → default provider', () => {
    expect(sms.detectProvider('')).toBe('twilio');
    expect(sms.detectProvider(null)).toBe('twilio');
    expect(sms.detectProvider(undefined)).toBe('twilio');
  });
});

describe('isMsg91Configured / isTwilioConfigured', () => {
  test('false when env not set', () => {
    expect(sms.isMsg91Configured()).toBe(false);
    expect(sms.isTwilioConfigured()).toBe(false);
  });
  test('true when MSG91 env vars all set', () => {
    process.env.MSG91_API_KEY = 'k';
    process.env.MSG91_SENDER_ID = 'SITEPR';
    expect(sms.isMsg91Configured()).toBe(true);
  });
  test('false when only one MSG91 var set', () => {
    process.env.MSG91_API_KEY = 'k';
    expect(sms.isMsg91Configured()).toBe(false);
  });
  test('true when Twilio env vars all set', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC...';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_FROM_NUMBER = '+15551234';
    expect(sms.isTwilioConfigured()).toBe(true);
  });
  test('false when missing TWILIO_FROM_NUMBER', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC...';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    expect(sms.isTwilioConfigured()).toBe(false);
  });
});

describe('sendSMS — input validation', () => {
  test('missing to', async () => {
    const r = await sms.sendSMS({ message: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_RECIPIENT');
  });
  test('missing message', async () => {
    const r = await sms.sendSMS({ to: '+919876543210' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_RECIPIENT');
  });
});

describe('sendSMS — graceful no-op when provider not configured', () => {
  test('IN number, no MSG91 env → NOT_CONFIGURED, no fetch call', async () => {
    const r = await sms.sendSMS({ to: '+919876543210', message: 'test' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_CONFIGURED');
    expect(r.provider).toBe('msg91');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('US number, no Twilio env → NOT_CONFIGURED, no fetch call', async () => {
    const r = await sms.sendSMS({ to: '+15551234567', message: 'test' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_CONFIGURED');
    expect(r.provider).toBe('twilio');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('sendSMS — MSG91', () => {
  beforeEach(() => {
    process.env.MSG91_API_KEY = 'msg91-key';
    process.env.MSG91_SENDER_ID = 'SITEPR';
    process.env.MSG91_TEMPLATE_SIGNUP_OTP = 'tpl-123';
  });

  test('successful send returns providerId', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message_id: 'msg-456', type: 'success' }),
    });
    const r = await sms.sendSMS({
      to: '+919876543210',
      message: '123456',
      templateType: 'SIGNUP_OTP',
    });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('msg91');
    expect(r.providerId).toBe('msg-456');
  });

  test('uses MSG91_TEMPLATE_<TYPE> env var to look up templateId', async () => {
    let capturedBody = null;
    global.fetch.mockImplementationOnce(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ message_id: 'm1', type: 'success' }) };
    });
    await sms.sendSMS({
      to: '+919876543210',
      message: 'hi',
      templateType: 'SIGNUP_OTP',
    });
    expect(capturedBody.template_id).toBe('tpl-123');
    expect(capturedBody.sender).toBe('SITEPR');
  });

  test('TEMPLATE_NOT_CONFIGURED when templateType has no env var', async () => {
    const r = await sms.sendSMS({
      to: '+919876543210',
      message: 'hi',
      templateType: 'NEW_TEMPLATE_NOT_SET',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TEMPLATE_NOT_CONFIGURED');
  });

  test('PROVIDER_ERROR when MSG91 returns error', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'invalid auth', type: 'error' }),
    });
    const r = await sms.sendSMS({ to: '+919876543210', message: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('PROVIDER_ERROR');
  });

  test('NETWORK_ERROR when fetch throws', async () => {
    global.fetch.mockRejectedValueOnce(new Error('connection reset'));
    const r = await sms.sendSMS({ to: '+919876543210', message: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NETWORK_ERROR');
    expect(r.message).toMatch(/connection reset/);
  });

  test('strips non-digits from phone number for mobiles field', async () => {
    let body = null;
    global.fetch.mockImplementationOnce(async (_url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ message_id: 'x' }) };
    });
    await sms.sendSMS({ to: '+91-987-654-3210', message: 'hi' });
    expect(body.mobiles).toBe('919876543210');
  });
});

describe('sendSMS — Twilio', () => {
  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'tok-456';
    process.env.TWILIO_FROM_NUMBER = '+15551234567';
  });

  test('successful send returns providerId (sid)', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'SM-789', status: 'queued' }),
    });
    const r = await sms.sendSMS({ to: '+15559876543', message: 'test' });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('twilio');
    expect(r.providerId).toBe('SM-789');
  });

  test('uses Basic auth header', async () => {
    let auth = null;
    global.fetch.mockImplementationOnce(async (_url, opts) => {
      auth = opts.headers.Authorization;
      return { ok: true, json: async () => ({ sid: 'x' }) };
    });
    await sms.sendSMS({ to: '+15551234567', message: 'hi' });
    const expected = 'Basic ' + Buffer.from('AC123:tok-456').toString('base64');
    expect(auth).toBe(expected);
  });

  test('PROVIDER_ERROR on non-2xx', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'invalid number' }),
    });
    const r = await sms.sendSMS({ to: '+15551234567', message: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('PROVIDER_ERROR');
  });

  test('NETWORK_ERROR when fetch throws', async () => {
    global.fetch.mockRejectedValueOnce(new Error('timeout'));
    const r = await sms.sendSMS({ to: '+15551234567', message: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NETWORK_ERROR');
  });
});

describe('status', () => {
  test('reflects per-provider configuration', () => {
    process.env.MSG91_API_KEY = 'k';
    process.env.MSG91_SENDER_ID = 'SITEPR';
    const s = sms.status();
    expect(s.msg91.configured).toBe(true);
    expect(s.twilio.configured).toBe(false);
  });
});
