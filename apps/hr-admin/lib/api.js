// Fetch wrapper for the HR admin console. Mirrors the platform's
// lib/adminApi.js contract: returns parsed JSON on 2xx, throws an Error
// with .status + .data on non-2xx so callers can branch on 401 (→ login)
// or inspect structured validation fields.
//
// All requests go to the backend at NEXT_PUBLIC_API_URL with
// credentials:'include' (cookie auth — the ae_operator session cookie).
// next.config.js also rewrites /api/* to the backend, so relative paths
// work same-origin; we resolve against the configured origin to be
// explicit and to work in server components too.

const API_BASE = String(process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');

function resolveUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  const rel = path.startsWith('/') ? path : `/${path}`;
  return API_BASE ? `${API_BASE}${rel}` : rel;
}

// ── PERF: in-flight dedupe + short-TTL cache for session-stable lookups ───────
// On a high-latency link every avoided round-trip is ~one RTT of page time. Two
// wins, both BROWSER-ONLY:
//   1) dedupe — concurrent GETs of the same URL share one promise (React mounts
//      routinely request the same lookup from several components at once).
//   2) cache  — a small allowlist of session-stable reads (who am I, tenant
//      brand, enum/meta, org lookups) is reused for TTL_MS instead of refetched
//      on every page navigation. /api/auth/me alone was fetched by AdminShell
//      AND again by many pages.
// SECURITY: this module also runs in server components. A module-level cache
// there would be shared across ALL users of the Node process and leak one
// session's data to another, so both maps are hard-gated to the browser, where
// there is exactly one user.
const isBrowser = typeof window !== 'undefined';
const CACHEABLE = [
  /^\/api\/auth\/me(\?|$)/,
  /^\/api\/tenant\/resolve(\?|$)/,
  /^\/api\/hr\/meta(\?|$)/,
  /^\/api\/hr\/me\/meta(\?|$)/,
  /^\/api\/hr\/country-context(\?|$)/,
  /^\/api\/hr\/org\/(departments|designations|locations|grades|bands|entities)(\?|$)/,
  /^\/api\/rbac\/permissions(\?|$)/,
];
const TTL_MS = 30000;
const _cache = new Map();
const _inflight = new Map();

function isCacheable(p) { return isBrowser && CACHEABLE.some((re) => re.test(p)); }

// Hand back a COPY so a caller mutating the result can never corrupt the cache.
function clone(v) {
  try { return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }
  catch { return v; }
}

/** Drop every cached lookup. Called automatically after any mutation. */
export function invalidateApiCache() { _cache.clear(); _inflight.clear(); }

export async function request(path, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const res = await fetch(resolveUrl(path), {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  // Any write may invalidate any cached lookup — clear defensively. Done here
  // (not in the post/patch helpers) so direct request() callers are covered too.
  if (method !== 'GET' && isBrowser) invalidateApiCache();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = body;
    throw err;
  }
  return body;
}

// Build a query string from an object, dropping empty/undefined values.
export function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function get(path, params) {
  const full = `${path}${params ? qs(params) : ''}`;
  if (!isCacheable(full)) return request(full, { method: 'GET' });

  const hit = _cache.get(full);
  if (hit && Date.now() - hit.t < TTL_MS) return Promise.resolve(clone(hit.v));

  const pending = _inflight.get(full);
  if (pending) return pending.then(clone);

  const p = request(full, { method: 'GET' })
    .then((v) => { _cache.set(full, { t: Date.now(), v }); _inflight.delete(full); return v; })
    .catch((e) => { _inflight.delete(full); throw e; });
  _inflight.set(full, p);
  return p.then(clone);
}

export function post(path, data) {
  return request(path, { method: 'POST', body: JSON.stringify(data ?? {}) });
}

export function patch(path, data) {
  return request(path, { method: 'PATCH', body: JSON.stringify(data ?? {}) });
}

// FLAG (Feature 29 — shared edit): PUT for idempotent upserts (e.g. a roster cell).
export function put(path, data) {
  return request(path, { method: 'PUT', body: JSON.stringify(data ?? {}) });
}

export function del(path) {
  return request(path, { method: 'DELETE' });
}

/**
 * downloadFile — GET a binary/attachment endpoint and save it to disk. On a
 * non-2xx response it parses the JSON error body (so callers can surface a
 * structured failure such as payroll's 422 MISSING_BANK_DETAILS with the
 * offender list) and throws the same Error shape as request() (.status/.data).
 */
export async function downloadFile(path, { filename } = {}) {
  const res = await fetch(resolveUrl(path), { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = body;
    throw err;
  }
  const blob = await res.blob();
  // Honour the server's filename (Content-Disposition) when present.
  let name = filename;
  if (!name) {
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="?([^"]+)"?/.exec(cd);
    name = m ? m[1] : 'download';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}

export const api = { request, get, post, patch, put, del, qs, downloadFile, invalidateApiCache };
export default api;
