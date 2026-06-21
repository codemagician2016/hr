// Unit tests for the POST /api/locale controller. We don't hit the
// real DB — mock prisma + jwt instead so the test stays pure and fast.

jest.mock('../src/core/lib/prisma', () => ({
  customer: { updateMany: jest.fn() },
  user:     { update: jest.fn() },
}));
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../src/core/utils/generateToken', () => ({
  getJwtSecret: jest.fn(() => 'test-secret-not-real'),
  readCustomerToken: jest.fn((req) => req.cookies?.token || null),
  readOperatorToken: jest.fn(),
}));

const prisma = require('../src/core/lib/prisma');
const jwt = require('jsonwebtoken');
const { readOperatorToken } = require('../src/core/utils/generateToken');
const { setLocale, SUPPORTED } = require('../src/core/controllers/locale.controller');

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.JWT_SECRET = 'test-secret-not-real';
});

describe('SUPPORTED locales', () => {
  test('contains the seven launch locales (kept in sync with frontend)', () => {
    // Drift between this set and platform/business i18n/config.js will
    // surface here — both must be edited together when adding a locale.
    for (const code of ['en', 'hi', 'es', 'fr', 'de', 'it', 'pt-BR']) {
      expect(SUPPORTED.has(code)).toBe(true);
    }
    expect(SUPPORTED.size).toBe(7);
  });
});

describe('setLocale — input validation', () => {
  test('rejects missing locale with 400', async () => {
    const req = { body: {}, cookies: {}, headers: {} };
    const res = makeRes();
    await setLocale(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects unsupported locale with 400', async () => {
    const req = { body: { locale: 'klingon' }, cookies: {}, headers: {} };
    const res = makeRes();
    await setLocale(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects non-string locale with 400', async () => {
    const req = { body: { locale: 123 }, cookies: {}, headers: {} };
    const res = makeRes();
    await setLocale(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('setLocale — authenticated customer', () => {
  test('updates customer.preferredLanguage and returns scope=customer', async () => {
    jwt.verify.mockReturnValueOnce({ id: 'cust-1', type: 'customer', businessId: 'biz-1' });
    prisma.customer.updateMany.mockResolvedValueOnce({});

    const req = {
      body:    { locale: 'hi' },
      cookies: { token: 'fake-customer-jwt' },
      headers: {},
    };
    const res = makeRes();
    await setLocale(req, res);

    expect(prisma.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'cust-1', businessId: 'biz-1' },
      data:  { preferredLanguage: 'hi' },
    });
    expect(res.json).toHaveBeenCalledWith({ ok: true, scope: 'customer' });
  });
});

describe('setLocale — authenticated operator (User)', () => {
  test('updates user.preferredLanguage and returns scope=user', async () => {
    // Customer cookie absent / invalid → fall through to operator.
    readOperatorToken.mockReturnValueOnce('fake-user-jwt');
    jwt.verify.mockReturnValueOnce({ id: 'user-1', type: 'user' });
    prisma.user.update.mockResolvedValueOnce({});

    const req = { body: { locale: 'de' }, cookies: {}, headers: {} };
    const res = makeRes();
    await setLocale(req, res);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data:  { preferredLanguage: 'de' },
    });
    expect(res.json).toHaveBeenCalledWith({ ok: true, scope: 'user' });
  });
});

describe('setLocale — guest (no auth)', () => {
  test('returns scope=guest and writes nothing to the DB', async () => {
    readOperatorToken.mockReturnValueOnce(null);

    const req = { body: { locale: 'fr' }, cookies: {}, headers: {} };
    const res = makeRes();
    await setLocale(req, res);

    expect(prisma.customer.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true, scope: 'guest' });
  });

  test('falls back to guest if operator JWT is invalid', async () => {
    readOperatorToken.mockReturnValueOnce('garbage-jwt');
    jwt.verify.mockImplementationOnce(() => { throw new Error('bad sig'); });

    const req = { body: { locale: 'es' }, cookies: {}, headers: {} };
    const res = makeRes();
    await setLocale(req, res);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true, scope: 'guest' });
  });
});
