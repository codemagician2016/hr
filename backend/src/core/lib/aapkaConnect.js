//
// aapkaConnect.js — the ONE generic engine that connects Sitepresso to ANY
// external service app (delivery / WMS / chat / POS / …) that speaks the
// AapkaConnect standard:
//   • GET /.well-known/aapka-connect  — a manifest (category, actions, events)
//   • Authorization: Bearer <key>     — auth
//   • HMAC-signed webhooks            — events back (x-*-signature)
//
// Adding a new provider is a ServiceConnection ROW, not new code — exactly like
// the payments layer connects Stripe/Razorpay/Paddle through one interface.
//
const crypto = require('crypto');
const { encrypt, decrypt } = require('./crypto');

async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: ac.signal,
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) { const e = new Error(data?.message || `provider HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') { const e = new Error('provider request timed out'); e.status = 504; throw e; }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Discover an app: pull + validate its manifest.
async function fetchManifest(baseUrl) {
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/.well-known/aapka-connect`;
  const m = await httpJson(url);
  if (!m || m.protocol !== 'aapka-connect') {
    const e = new Error('not an AapkaConnect provider (missing/invalid manifest)'); e.status = 422; throw e;
  }
  return m;
}

function authHeaders(connection) {
  const key = connection?.apiKeyEnc ? decrypt(connection.apiKeyEnc) : null;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// Generic authed call to a connected provider. The caller supplies a concrete
// path (resolved from manifest.resources) — the engine never branches on provider.
async function callProvider(connection, { method = 'GET', path, body } = {}) {
  if (!connection?.baseUrl || !path) throw new Error('connection.baseUrl + path are required');
  const base = String(connection.baseUrl).replace(/\/+$/, '');
  return httpJson(`${base}${path}`, { method, headers: authHeaders(connection), body });
}

// Register OUR webhook URL on the provider; returns the signing secret to store.
async function registerProviderWebhook(connection, ourWebhookUrl, events = ['*']) {
  const reg = connection.manifest?.webhooks?.register || 'POST /partner/webhooks';
  const [method, path] = String(reg).split(' ');
  const res = await callProvider(connection, { method: method || 'POST', path: path || '/partner/webhooks', body: { url: ourWebhookUrl, events } });
  return res?.webhook?.secret || res?.secret || null;
}

// Ask the provider for a short-lived, WORKSPACE-SCOPED SSO URL so a Sitepresso
// user who has access to THIS tenant can open the app — scoped to this
// connection's workspace ONLY. Because each Sitepresso tenant connects with its
// own key (its own app workspace) and the ServiceConnection is per businessId,
// there is no path to another tenant's data.
async function requestSso(connection) {
  const sso = connection?.manifest?.sso;
  if (!sso) { const e = new Error('This app does not support single sign-on.'); e.status = 422; throw e; }
  const [m, p] = String(sso).includes(' ') ? String(sso).split(' ') : ['POST', sso];
  const res = await callProvider(connection, { method: m || 'POST', path: p, body: { workspaceId: connection.workspaceId || undefined } });
  return res?.url || res?.ssoUrl || null;
}

// Ping the provider's identity endpoint (default GET /partner/me) to verify the
// key works and learn the workspace. Errors propagate with a .status so callers
// can tell "key rejected" (401/403) from "unreachable" (504) etc.
async function pingProvider(connection) {
  const idn = connection?.manifest?.identity || 'GET /partner/me';
  const [m, p] = String(idn).includes(' ') ? String(idn).split(' ') : ['GET', idn];
  return callProvider(connection, { method: m || 'GET', path: p || '/partner/me' });
}

// Verify an inbound webhook's HMAC-SHA256 signature against the stored secret.
function verifyWebhook(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const expected = crypto.createHmac('sha256', String(secret)).update(body).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { fetchManifest, callProvider, pingProvider, registerProviderWebhook, requestSso, verifyWebhook, encryptApiKey: encrypt };
