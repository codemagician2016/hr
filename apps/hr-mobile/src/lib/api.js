// DriftHR mobile API client.
//
// The web ESS relies on the browser to persist the httpOnly customer-session
// cookie set by POST /api/customer/login. React Native's fetch has no cookie
// jar, so we capture the raw `Set-Cookie` header from the login response and
// replay it verbatim as a `Cookie` header on every subsequent request. The
// cookie value is persisted in expo-secure-store so the session survives app
// restarts. We also accept a JSON `token` in the login body as a Bearer
// fallback in case the deployment is configured for token auth.
//
// Base origin comes from process.env.EXPO_PUBLIC_API_URL (e.g.
// https://api.drifthr.app). EXPO_PUBLIC_* vars are inlined into the bundle by
// the Expo/Metro build, so this works on-device.

import * as SecureStore from 'expo-secure-store';

const COOKIE_KEY = 'drifthr.session.cookie';
const TOKEN_KEY = 'drifthr.session.token';

// Trim a trailing slash so path concatenation is predictable.
const BASE = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/+$/, '');

// In-memory mirror of the persisted credentials (avoids a SecureStore read on
// every request). Hydrated by loadSession() at app start.
let sessionCookie = null;
let sessionToken = null;

// Reduce a possibly-multi-cookie `Set-Cookie` header to the `name=value` pairs
// the server needs back, dropping attributes (Path, HttpOnly, Expires, …).
function extractCookiePairs(setCookieHeader) {
  if (!setCookieHeader) return null;
  // Multiple cookies may be comma-joined; split on commas that precede a
  // `name=` token (not inside Expires=... which also contains commas).
  const parts = setCookieHeader.split(/,(?=\s*[^=;,\s]+=)/);
  const pairs = parts
    .map((c) => c.split(';')[0].trim())
    .filter((p) => p.includes('='));
  return pairs.length ? pairs.join('; ') : null;
}

export async function loadSession() {
  try {
    sessionCookie = await SecureStore.getItemAsync(COOKIE_KEY);
    sessionToken = await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    sessionCookie = null;
    sessionToken = null;
  }
  return { cookie: sessionCookie, token: sessionToken };
}

export function hasSession() {
  return Boolean(sessionCookie || sessionToken);
}

async function setSession({ cookie, token }) {
  if (cookie) {
    sessionCookie = cookie;
    await SecureStore.setItemAsync(COOKIE_KEY, cookie);
  }
  if (token) {
    sessionToken = token;
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  }
}

export async function clearSession() {
  sessionCookie = null;
  sessionToken = null;
  try {
    await SecureStore.deleteItemAsync(COOKIE_KEY);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // best effort
  }
}

function authHeaders(extra) {
  const headers = { Accept: 'application/json', ...(extra || {}) };
  if (sessionCookie) headers.Cookie = sessionCookie;
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  return headers;
}

async function jsonOrThrow(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.errors = body.errors || body.issues || [];
    err.body = body;
    throw err;
  }
  return body;
}

export async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'GET',
    headers: authHeaders(),
  });
  return jsonOrThrow(res);
}

export async function apiSend(path, method, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: body == null ? undefined : JSON.stringify(body),
  });
  return jsonOrThrow(res);
}

export const apiPost = (path, body) => apiSend(path, 'POST', body);
export const apiPatch = (path, body) => apiSend(path, 'PATCH', body);

// ── Auth ────────────────────────────────────────────────────────────────────

// POST /api/customer/login. Persists the returned session cookie (and/or token)
// then returns the customer object.
export async function login(email, password) {
  const res = await fetch(`${BASE}/api/customer/login`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await jsonOrThrow(res);

  // React Native exposes the raw Set-Cookie via the Headers map.
  const rawSetCookie =
    (res.headers.get && (res.headers.get('set-cookie') || res.headers.get('Set-Cookie'))) || null;
  const cookie = extractCookiePairs(rawSetCookie);
  const token = body.token || body.accessToken || null;

  if (cookie || token) {
    await setSession({ cookie, token });
  }
  return body.customer || body;
}

export async function logout() {
  try {
    await apiPost('/api/customer/logout');
  } catch {
    // Clearing the local session is what matters even if the call fails.
  }
  await clearSession();
}

// ── ESS data ─────────────────────────────────────────────────────────────────

export const fetchMe = () => apiGet('/api/customer/me');

export const fetchPayslips = () => apiGet('/api/hr/me/payslips');
export const fetchPayslip = (id) => apiGet(`/api/hr/me/payslips/${id}`);

export const fetchLeaveRequests = () => apiGet('/api/hr/leave/requests');
export const applyLeave = (payload) => apiPost('/api/hr/leave/requests', payload);
export const fetchLeaveBalances = (employeeId) =>
  apiGet(`/api/hr/leave/employees/${employeeId}/balances`);

export const punch = (payload) => apiPost('/api/hr/attendance/punch', payload);
export const fetchPunches = (query) =>
  apiGet(`/api/hr/attendance/punches${query ? `?${query}` : ''}`);

export default {
  loadSession,
  hasSession,
  clearSession,
  apiGet,
  apiPost,
  apiPatch,
  login,
  logout,
  fetchMe,
  fetchPayslips,
  fetchPayslip,
  fetchLeaveRequests,
  applyLeave,
  fetchLeaveBalances,
  punch,
  fetchPunches,
};
