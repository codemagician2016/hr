const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const modulePath = path.resolve(__dirname, '../src/core/utils/generateToken.js');

function loadGenerateTokenModule(envOverrides = {}) {
  const previousValues = new Map();

  for (const [key, value] of Object.entries(envOverrides)) {
    previousValues.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  delete require.cache[require.resolve(modulePath)];
  const mod = require(modulePath);

  return {
    mod,
    restore() {
      for (const [key, value] of previousValues.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete require.cache[require.resolve(modulePath)];
    },
  };
}

function createResponseDouble() {
  return {
    cookies: [],
    clears: [],
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
      return this;
    },
    clearCookie(name, options) {
      this.clears.push({ name, options });
      return this;
    },
  };
}

function createRequestDouble(headers = {}, cookies = {}) {
  const map = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  return {
    cookies,
    get(name) {
      return map.get(String(name).toLowerCase()) || '';
    },
    headers: Object.fromEntries(map.entries()),
  };
}

test('operator cookies use shared .aapkatech.com domain with 15 minute access and 7 day refresh in production', () => {
  const { mod, restore } = loadGenerateTokenModule({
    NODE_ENV: 'production',
    AUTH_COOKIE_DOMAIN: '.aapkatech.com',
    JWT_SECRET: 'test-secret',
  });

  try {
    const res = createResponseDouble();
    const req = createRequestDouble({ origin: 'https://admin.aapkatech.com' });
    mod.setTokenCookie(res, { id: 'user-1' }, req);

    assert.deepEqual(res.clears, [
      {
        name: 'ae_operator',
        options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', domain: '.aapkatech.com' },
      },
      {
        name: 'ae_operator_refresh',
        options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', domain: '.aapkatech.com' },
      },
    ]);

    assert.equal(res.cookies.length, 2);
    assert.deepEqual(res.cookies.map((c) => [c.name, c.options.maxAge]), [
      ['ae_operator', 15 * 60 * 1000],
      ['ae_operator_refresh', 7 * 24 * 60 * 60 * 1000],
    ]);
    assert.deepEqual(res.cookies.map((c) => c.options.domain), ['.aapkatech.com', '.aapkatech.com']);

    const access = jwt.verify(res.cookies[0].value, 'test-secret');
    const refresh = jwt.verify(res.cookies[1].value, 'test-secret');
    assert.equal(access.tokenUse, 'access');
    assert.equal(refresh.tokenUse, 'refresh');
  } finally {
    restore();
  }
});

test('operator cookie names stay host-specific outside shared-domain mode for local tenant testing', () => {
  const { mod, restore } = loadGenerateTokenModule({
    NODE_ENV: 'development',
    AUTH_COOKIE_DOMAIN: '.aapkatech.com',
    JWT_SECRET: 'test-secret',
  });

  try {
    const req = createRequestDouble({
      'x-tenant-host': 'shreya.sitepresso.com',
      host: 'backend.internal',
    });

    assert.equal(mod.buildOperatorCookieName(req), 'ae_operator_shreya_sitepresso_com');
  } finally {
    restore();
  }
});

test('readOperatorToken accepts Authorization bearer tokens as well as httpOnly cookies', () => {
  const { mod, restore } = loadGenerateTokenModule({
    NODE_ENV: 'development',
    JWT_SECRET: 'test-secret',
  });

  try {
    const req = createRequestDouble({ authorization: 'Bearer signed.jwt.token' });
    assert.equal(mod.readOperatorToken(req), 'signed.jwt.token');
  } finally {
    restore();
  }
});

test('customer auth cookies also use httpOnly shared-domain access and refresh cookies', () => {
  const { mod, restore } = loadGenerateTokenModule({
    NODE_ENV: 'production',
    AUTH_COOKIE_DOMAIN: '.aapkatech.com',
    JWT_SECRET: 'test-secret',
  });

  try {
    const res = createResponseDouble();
    const req = createRequestDouble({ origin: 'https://shreya.aapkatech.com' });
    mod.setCustomerTokenCookie(res, { id: 'customer-1', businessId: 'business-1' }, req);

    assert.deepEqual(res.cookies.map((c) => c.name), ['token', 'token_refresh']);
    for (const cookie of res.cookies) {
      assert.equal(cookie.options.httpOnly, true);
      assert.equal(cookie.options.secure, true);
      assert.equal(cookie.options.sameSite, 'lax');
      assert.equal(cookie.options.domain, '.aapkatech.com');
    }

    const access = jwt.verify(res.cookies[0].value, 'test-secret');
    const refresh = jwt.verify(res.cookies[1].value, 'test-secret');
    assert.equal(access.type, 'customer');
    assert.equal(access.tokenUse, 'access');
    assert.equal(refresh.type, 'customer');
    assert.equal(refresh.tokenUse, 'refresh');
  } finally {
    restore();
  }
});

test('clearTokenCookie clears shared access and refresh cookies in production', () => {
  const { mod, restore } = loadGenerateTokenModule({
    NODE_ENV: 'production',
    AUTH_COOKIE_DOMAIN: '.aapkatech.com',
    JWT_SECRET: 'test-secret',
  });

  try {
    const res = createResponseDouble();
    const req = createRequestDouble({ host: 'admin.aapkatech.com' });
    mod.clearTokenCookie(res, req);

    assert.deepEqual(res.clears.map((c) => c.name), ['ae_operator', 'ae_operator_refresh']);
  } finally {
    restore();
  }
});
