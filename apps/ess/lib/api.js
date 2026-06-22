'use client';

// Single fetch wrapper for the ESS app. Every request is cookie-authed
// (credentials:'include') against the employee/customer session. The backend
// origin is reached through Next's /api/* rewrite (see next.config.js) so the
// browser always talks to the same origin and the auth cookie is sent.
//
// Mirrors the platform app's jsonOrThrow contract: non-2xx responses throw an
// Error carrying `.status` and `.errors` so callers can branch on them.

const BASE = ''; // same-origin; next.config rewrites /api/* to the backend

async function jsonOrThrow(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.errors = body.errors || body.issues || [];
    throw err;
  }
  return body;
}

export async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  return jsonOrThrow(res);
}

export async function apiSend(path, method, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return jsonOrThrow(res);
}

export const apiPost = (path, body) => apiSend(path, 'POST', body);
export const apiPatch = (path, body) => apiSend(path, 'PATCH', body);

// Resolve the current tenant by Host header (white-label). The backend reads
// the Host from the proxied request; no slug needed for the subdomain/custom
// domain ESS surface.
export function resolveTenant() {
  return apiGet('/api/tenant/resolve');
}

// Current employee (customer) session.
export function fetchMe() {
  return apiGet('/api/customer/me');
}
