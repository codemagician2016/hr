const { getRegistrarConfig } = require('../config');
const { assertValidDomainName, normalizeTld, sldFromDomain, tldFromDomain } = require('../domainNames');
const { RegistrarAdapter } = require('./interface');
const { withRegistrarRetry } = require('./retry');
const {
  mockAuthCode,
  mockRegisterResult,
  mockSearchResults,
  mockTransferResult,
} = require('./mockRegistrar');

// Openprovider REST API (v1beta) adapter — the single registrar for Sitepresso.
//
// Auth: POST {base}/auth/login {username,password[,ip]} -> { code, desc, data:{ token, reseller_id } }
//   The bearer token has a 48h TTL, so it is cached module-wide (keyed by
//   base+username) and refreshed early / on an auth failure. createDefaultAdapters()
//   is called per request, so per-instance caching would re-login every call.
// Calls: JSON over HTTPS with `Authorization: Bearer <token>`; responses are
//   { code, desc, data } where code === 0 means success.
//
// When credentials are absent the adapter falls back to deterministic mock
// results (DOMAIN_RESELLER_MODE stays 'sandbox' until OPENPROVIDER_USERNAME/
// PASSWORD + an IP whitelist are set on the box), so search/register stay
// testable before the account is wired.
//
// ⚠️ The live request/response field names below follow the v1beta docs; verify
// them against a sandbox round-trip before flipping DOMAIN_RESELLER_MODE=live.

const TOKEN_CACHE = new Map(); // `${baseUrl}::${username}` -> { token, expiresAt }
const TOKEN_TTL_MS = 47 * 60 * 60 * 1000; // refresh ~1h before the 48h expiry

function splitDomain(domainName) {
  return {
    name: sldFromDomain(domainName) || String(domainName || '').trim().toLowerCase(),
    extension: tldFromDomain(domainName),
  };
}

function numericId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function pathWithDomainQuery(path, domainName) {
  if (!domainName) return path;
  const domain = splitDomain(domainName);
  if (!domain.name || !domain.extension) return path;
  const query = new URLSearchParams({
    'domain.name': domain.name,
    'domain.extension': domain.extension,
  });
  return `${path}?${query.toString()}`;
}

function openproviderExpiration(data, fallback) {
  return data?.expiration_date
    || data?.expirationDate
    || data?.expiration_date_openprovider
    || data?.renewal_date
    || data?.registry_expiration_date
    || fallback;
}

function isRetryableOpenproviderFailure(result) {
  if (result.authFailed) return true;
  if (result.status === 408 || result.status === 429 || result.status >= 500) return true;
  return !Number.isFinite(result.code);
}

class OpenproviderAdapter extends RegistrarAdapter {
  constructor(options = {}) {
    const config = options.config || getRegistrarConfig('OPENPROVIDER', options.env);
    super({
      ...options,
      mode: config.mode,
      baseUrl: config.baseUrl,
      credentials: {
        username: config.username,
        password: config.password,
      },
    });
    this.config = config;
  }

  get registrar() {
    return 'OPENPROVIDER';
  }

  canCallApi() {
    return Boolean(this.config.hasCredentials && this.fetchImpl);
  }

  canRegisterWithApi() {
    return Boolean(
      this.canCallApi() &&
      this.config.customerHandle &&
      this.config.nameservers?.length >= 2
    );
  }

  cacheKey() {
    return `${this.baseUrl}::${this.config.username}`;
  }

  async login() {
    const url = `${this.baseUrl.replace(/\/$/, '')}/auth/login`;
    const body = { username: this.config.username, password: this.config.password };
    if (this.config.authIp) body.ip = this.config.authIp;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    const token = json?.data?.token;
    if (!response.ok || Number(json.code) !== 0 || !token) {
      const err = new Error(json.desc || `Openprovider auth failed with ${response.status}`);
      err.status = response.status;
      err.openprovider = json;
      throw err;
    }
    TOKEN_CACHE.set(this.cacheKey(), { token, expiresAt: this.now().getTime() + TOKEN_TTL_MS });
    return token;
  }

  async ensureToken(force = false) {
    const cached = TOKEN_CACHE.get(this.cacheKey());
    if (!force && cached && cached.expiresAt > this.now().getTime()) return cached.token;
    return this.login();
  }

  async send(path, { method = 'GET', body, token } = {}) {
    const url = `${this.baseUrl.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json().catch(() => ({}));
    const code = Number(json.code);
    // 196 = "Not authenticated", 12 = invalid token (re-auth and retry once).
    const authFailed = response.status === 401 || code === 196 || code === 12;
    return { ok: response.ok, status: response.status, json, code, authFailed };
  }

  async request(path, { method = 'GET', body, retryOptions } = {}) {
    return withRegistrarRetry({ registrar: this.registrar, path }, async () => {
      let token = await this.ensureToken();
      let result = await this.send(path, { method, body, token });
      if (result.authFailed) {
        TOKEN_CACHE.delete(this.cacheKey());
        token = await this.ensureToken(true);
        result = await this.send(path, { method, body, token });
      }
      if (!result.ok || result.code !== 0) {
        const err = new Error(result.json?.desc || `Openprovider API failed with ${result.status}`);
        err.status = result.status;
        err.openprovider = result.json;
        err.retryable = isRetryableOpenproviderFailure(result);
        throw err;
      }
      return result.json?.data || {};
    }, retryOptions);
  }

  normalizeAvailabilityResponse(label, tlds, data) {
    const fallback = mockSearchResults({ registrar: this.registrar, label, tlds });
    const results = Array.isArray(data?.results) ? data.results : [];
    const byDomain = new Map();
    for (const row of results) {
      const dn = String(row.domain || (row.name && row.extension ? `${row.name}.${row.extension}` : '')).toLowerCase();
      if (dn) byDomain.set(dn, row);
    }
    return fallback.map((row) => {
      const apiRow = byDomain.get(row.domainName.toLowerCase());
      if (!apiRow) return row;
      const status = String(apiRow.status || '').toLowerCase();
      const available = status ? status === 'free' : row.available;
      return {
        ...row,
        available,
        premium: row.premium || Boolean(apiRow.is_premium || apiRow.premium),
        registrarPayload: apiRow,
      };
    });
  }

  async searchAvailable(domainName, tlds = []) {
    const label = sldFromDomain(domainName) || String(domainName || '').trim().toLowerCase();
    const cleanTlds = tlds.map(normalizeTld);
    if (this.canCallApi()) {
      const data = await this.request('domains/check', {
        method: 'POST',
        body: {
          domains: cleanTlds.map((tld) => ({ name: label, extension: tld })),
          with_price: true,
        },
      });
      return this.normalizeAvailabilityResponse(label, cleanTlds, data);
    }
    return mockSearchResults({ registrar: this.registrar, label, tlds: cleanTlds });
  }

  async register(opts = {}) {
    const domainName = assertValidDomainName(opts.domainName);
    if (this.canRegisterWithApi()) {
      const handle = this.config.customerHandle;
      const nameservers = (opts.nameservers?.length ? opts.nameservers : this.config.nameservers).map((name) => ({ name }));
      const fallback = mockRegisterResult({ prefix: 'OP', domainName, years: opts.years || 1, now: this.now() });
      const data = await this.request('domains', {
        method: 'POST',
        body: {
          domain: splitDomain(domainName),
          period: opts.years || 1,
          unit: 'yearly',
          owner_handle: handle,
          admin_handle: handle,
          tech_handle: handle,
          billing_handle: handle,
          name_servers: nameservers,
          is_private_whois_enabled: Boolean(opts.privacyEnabled),
        },
      });
      return {
        registrarRef: String(data.id || data.domain_id || domainName),
        expiresAt: openproviderExpiration(data, fallback.expiresAt),
        registrarPayload: data,
      };
    }
    return mockRegisterResult({
      prefix: 'OP',
      domainName,
      years: opts.years || 1,
      now: this.now(),
    });
  }

  async renew(registrarRef, years = 1, opts = {}) {
    if (this.canCallApi()) {
      const domainName = opts.domainName ? assertValidDomainName(opts.domainName) : '';
      const id = numericId(registrarRef);
      const body = { period: years };
      if (id) body.id = id;
      if (domainName) body.domain = splitDomain(domainName);
      const data = await this.request(`domains/${encodeURIComponent(registrarRef)}/renew`, {
        method: 'POST',
        body,
      });
      return {
        expiresAt: openproviderExpiration(
          data,
          mockRegisterResult({ prefix: 'OP-REN', domainName: domainName || registrarRef, years, now: this.now() }).expiresAt
        ),
        registrarPayload: data,
      };
    }
    return mockRegisterResult({
      prefix: 'OP-REN',
      domainName: registrarRef,
      years,
      now: this.now(),
    });
  }

  async transferIn(domainName, authCode, opts = {}) {
    assertValidDomainName(domainName);
    if (!authCode) {
      const err = new Error('Authorization code is required for transfer-in.');
      err.code = 'AUTH_CODE_REQUIRED';
      throw err;
    }
    if (this.canRegisterWithApi()) {
      const handle = this.config.customerHandle;
      const data = await this.request('domains/transfer', {
        method: 'POST',
        body: {
          domain: splitDomain(domainName),
          period: opts.years || 1,
          unit: 'yearly',
          auth_code: authCode,
          owner_handle: handle,
          admin_handle: handle,
          tech_handle: handle,
          billing_handle: handle,
          name_servers: this.config.nameservers.map((name) => ({ name })),
        },
      });
      return {
        registrarRef: String(data.id || data.domain_id || domainName),
        status: 'TRANSFER_IN_PENDING',
        registrarPayload: data,
      };
    }
    return mockTransferResult({ prefix: 'OP', domainName });
  }

  async getAuthCode(registrarRef, opts = {}) {
    if (this.canCallApi()) {
      const idPath = `domains/${encodeURIComponent(registrarRef)}`;
      let data;
      try {
        data = await this.request(pathWithDomainQuery(`${idPath}/authcode`, opts.domainName), {
          method: 'GET',
          retryOptions: { attempts: 1 },
        });
      } catch (err) {
        if (err.status && err.status !== 404) throw err;
        data = await this.request(pathWithDomainQuery(idPath, opts.domainName), { method: 'GET' });
      }
      return {
        authCode: data.auth_code || data.authCode || data.authcode,
        registrarPayload: data,
      };
    }
    return mockAuthCode('OP', registrarRef);
  }

  async setPrivacy(registrarRef, enabled, opts = {}) {
    if (this.canCallApi()) {
      const body = { is_private_whois_enabled: Boolean(enabled) };
      if (opts.domainName) body.domain = splitDomain(assertValidDomainName(opts.domainName));
      const data = await this.request(`domains/${encodeURIComponent(registrarRef)}`, {
        method: 'PUT',
        body,
      });
      return { registrarRef, privacyEnabled: Boolean(enabled), registrarPayload: data };
    }
    return { registrarRef, privacyEnabled: Boolean(enabled) };
  }

  async setNameservers(registrarRef, nameservers = [], opts = {}) {
    if (this.canCallApi()) {
      const body = { name_servers: nameservers.map((name) => ({ name })) };
      if (opts.domainName) body.domain = splitDomain(assertValidDomainName(opts.domainName));
      const data = await this.request(`domains/${encodeURIComponent(registrarRef)}`, {
        method: 'PUT',
        body,
      });
      return { registrarRef, nameservers: nameservers.map((ns) => String(ns).toLowerCase()), registrarPayload: data };
    }
    return { registrarRef, nameservers: nameservers.map((ns) => String(ns).toLowerCase()) };
  }
}

module.exports = {
  OpenproviderAdapter,
  TOKEN_CACHE,
};
