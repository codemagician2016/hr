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

export async function request(path, init = {}) {
  const res = await fetch(resolveUrl(path), {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
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
  return request(`${path}${params ? qs(params) : ''}`, { method: 'GET' });
}

export function post(path, data) {
  return request(path, { method: 'POST', body: JSON.stringify(data ?? {}) });
}

export function patch(path, data) {
  return request(path, { method: 'PATCH', body: JSON.stringify(data ?? {}) });
}

export const api = { request, get, post, patch, qs };
export default api;
