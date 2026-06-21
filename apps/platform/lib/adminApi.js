// Shared API helper for the admin shell + every admin tab. Returns parsed
// JSON on 2xx; throws an Error with .status + .data on non-2xx so callers
// can inspect structured fields (e.g. `missingRequired` from launch).
//
// Originally lived inline in [slug]/admin/page.js. Extracted 2026-04-29 as
// part of the admin-page split — every tab gets its own file and imports
// this helper instead of redefining it.

export async function api(path, init = {}) {
  const res = await fetch(path, {
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
