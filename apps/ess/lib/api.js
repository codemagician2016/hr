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
    // Machine-readable error discriminator when the backend sends one (e.g. the
    // attendance punch 403 reason:'CAPTURE_POLICY', face-enroll 422 reason:'NO_FACE')
    // plus the full body for callers that need more than the message.
    err.reason = body.reason || null;
    err.body = body;
    throw err;
  }
  return body;
}

// ── PERF: in-flight dedupe + short-TTL cache for session-stable lookups ───────
// Every avoided round-trip is ~one RTT of page time on a high-latency link.
// Concurrent GETs of the same URL share one promise, and a small allowlist of
// session-stable reads (tenant brand, enum/meta, country context) is reused
// instead of refetched on every screen. Any write clears the cache. Guarded to
// the browser so a module-level map can never be shared across users.
const isBrowser = typeof window !== 'undefined';
const CACHEABLE = [
  /^\/api\/tenant\/resolve(\?|$)/,
  /^\/api\/hr\/meta(\?|$)/,
  /^\/api\/hr\/me\/meta(\?|$)/,
  /^\/api\/hr\/me\/country-context(\?|$)/,
];
const TTL_MS = 30000;
const _cache = new Map();
const _inflight = new Map();

function isCacheable(p) { return isBrowser && CACHEABLE.some((re) => re.test(p)); }
function clone(v) {
  try { return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }
  catch { return v; }
}
/** Drop every cached lookup. Called automatically after any write. */
export function invalidateApiCache() { _cache.clear(); _inflight.clear(); }

async function rawGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  return jsonOrThrow(res);
}

export function apiGet(path) {
  if (!isCacheable(path)) return rawGet(path);

  const hit = _cache.get(path);
  if (hit && Date.now() - hit.t < TTL_MS) return Promise.resolve(clone(hit.v));

  const pending = _inflight.get(path);
  if (pending) return pending.then(clone);

  const p = rawGet(path)
    .then((v) => { _cache.set(path, { t: Date.now(), v }); _inflight.delete(path); return v; })
    .catch((e) => { _inflight.delete(path); throw e; });
  _inflight.set(path, p);
  return p.then(clone);
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
  // Any write may invalidate a cached lookup — clear defensively.
  if (isBrowser) invalidateApiCache();
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

// Resolve the signed-in employee's operating country + pay currency AND their
// profile details. This is the AUTHORITATIVE country source for the ESS app
// (single-country India) — the backend resolves country from the employee's
// StatutoryProfile / Employee row / the entity they work in. Returns
// { employeeId, countryCode, payCurrency, profile } where countryCode is null
// when it cannot be determined — callers must FAIL CLOSED (render neither
// country's blocks) rather than assume a default. `profile` carries the rich
// employee detail (code, dept, designation, location, DOJ, phone) the ESS profile
// page + sidebar render — the bare customer session does NOT carry it.
export function fetchMyProfile() {
  return apiGet('/api/hr/me/profile');
}

// Phase 5b — the employee's tenant-defined custom fields on their own profile.
// GET returns only definitions the employee may see (essPolicy !== 'HIDDEN'); each
// carries essPolicy READ_ONLY or SELF_EDIT. Returns { fields:[{ definition, value }] }.
export function fetchMyCustomFields() {
  return apiGet('/api/hr/me/custom-fields');
}
// PATCH { values:{ <key>: <raw> } } → refreshed { fields:[...] }. The server rejects
// non-SELF_EDIT keys with 403, so only submit SELF_EDIT ones.
export function saveMyCustomFields(values) {
  return apiPatch('/api/hr/me/custom-fields', { values });
}

// Feature 14 — the AUTHORITATIVE tenant country/capability matrix for the ESS
// app. Returns { country, currency, capabilities } sourced from Business.hrCountry
// (the single source of truth). The ESS app gates its onboarding statutory step /
// tax declaration / currency formatting off `capabilities`, never a hard-coded
// literal. A pre-setup / ambiguous tenant returns 409 (HR_NOT_SET_UP /
// HR_COUNTRY_AMBIGUOUS) — callers FAIL CLOSED (render an "HR not configured" state).
export function fetchMyCountryContext() {
  return apiGet('/api/hr/me/country-context');
}

// The employee's outstanding self-service tasks (in-progress onboarding, unsigned
// e-sign envelopes, un-acknowledged assets, + approvals awaiting them). Powers the
// dashboard "Pending tasks" card and the conditional Onboarding nav item.
export function fetchMyTasks() {
  return apiGet('/api/hr/me/tasks');
}

// ── Feature 10 (ESS) ─────────────────────────────────────────────────────────
// Unified approvals inbox (everything awaiting me, all modules). Customer session
// — the caller's portal user is resolved server-side from the session.
export function fetchMyApprovals(query = '') {
  return apiGet(`/api/hr/me/approvals${query}`);
}
export function decideApproval(id, body) {
  return apiPost(`/api/hr/me/approvals/${id}/decide`, body);
}
// "Who will approve this?" hint for a submit form. { module, ctx } → resolved chain.
export function previewApprovalChain(body) {
  return apiPost('/api/hr/me/approvals/preview', body);
}

// Minimal colleague directory (id + name) for the delegation stand-in picker.
export function fetchColleagues() {
  return apiGet('/api/hr/me/approvals/colleagues');
}

// Out-of-office delegation ("let someone approve for me while I'm away").
export function fetchMyDelegations() {
  return apiGet('/api/hr/me/delegations');
}
export function createDelegation(body) {
  return apiPost('/api/hr/me/delegations', body);
}
export function revokeDelegation(id) {
  return apiSend(`/api/hr/me/delegations/${id}`, 'DELETE');
}

// ── Feature 11 (ESS) — Reimbursement/Claims + Travel ──────────────────────────
// Reference data (categories + active policy summary) for the apply forms.
export function fetchExpenseReference() {
  return apiGet('/api/hr/me/expenses/reference');
}
// Live policy verdict for a draft bill line ("within / over budget" badge).
export function previewExpensePolicy(body) {
  return apiPost('/api/hr/me/expenses/policy/preview', body);
}
// Claims
export function fetchMyClaims(query = '') {
  return apiGet(`/api/hr/me/expenses/claims${query}`);
}
export function fetchMyClaim(id) {
  return apiGet(`/api/hr/me/expenses/claims/${id}`);
}
export function createClaim(body) {
  return apiPost('/api/hr/me/expenses/claims', body);
}
export function addClaimLine(id, body) {
  return apiPost(`/api/hr/me/expenses/claims/${id}/lines`, body);
}
export function removeClaimLine(id, lineId) {
  return apiSend(`/api/hr/me/expenses/claims/${id}/lines/${lineId}`, 'DELETE');
}
export function submitClaim(id) {
  return apiPost(`/api/hr/me/expenses/claims/${id}/submit`);
}
export function cancelClaim(id) {
  return apiPost(`/api/hr/me/expenses/claims/${id}/cancel`);
}
// Trips (outdoor duty / travel)
export function fetchMyTrips(query = '') {
  return apiGet(`/api/hr/me/expenses/trips${query}`);
}
export function fetchMyTrip(id) {
  return apiGet(`/api/hr/me/expenses/trips/${id}`);
}
export function createTrip(body) {
  return apiPost('/api/hr/me/expenses/trips', body);
}
export function submitTrip(id) {
  return apiPost(`/api/hr/me/expenses/trips/${id}/submit`);
}
export function cancelTrip(id) {
  return apiPost(`/api/hr/me/expenses/trips/${id}/cancel`);
}

// ── Cycle 1 (ESS) — Company Directory ─────────────────────────────────────────
// A tenant-wide, searchable, paginated colleague directory exposing ONLY safe
// work/professional fields (name/photo/designation/department/work email/work
// phone/entity/location/manager). The backend is the privacy boundary — personal
// email/phone, address, DOB, salary and any HR-gated field are never returned.
// `query` is a pre-built ?page=&pageSize=&q=&departmentId=&entityId= string.
export function fetchDirectory(query = '') {
  return apiGet(`/api/hr/me/directory${query}`);
}
// Distinct department / entity / location facets for the filter bar (no PII).
export function fetchDirectoryFilters() {
  return apiGet('/api/hr/me/directory/filters');
}
// A colleague's safe work profile (reporting line + "in <department>" + F19 org link).
export function fetchColleague(id) {
  return apiGet(`/api/hr/me/directory/${id}`);
}
// The signed-in employee's OWN directory opt-out state (work-phone sharing).
export function fetchMyDirectoryPreferences() {
  return apiGet('/api/hr/me/directory/preferences');
}
// Toggle the caller's OWN work-phone opt-out (self-only write).
export function updateMyDirectoryPreferences(body) {
  return apiPatch('/api/hr/me/directory/preferences', body);
}

// ── Feed social layer (reactions + threaded comments + @mentions) ─────────────
// All SELF-scope + audience-gated server-side (a caller can only react/comment on a
// post in their own feed). Single-reaction model: PUT upserts/replaces the caller's
// one reaction; DELETE removes it. Both return { ok, reactionSummary }.
export function setFeedReaction(announcementId, kind) {
  return apiSend(`/api/hr/me/engagement/feed/${announcementId}/reaction`, 'PUT', { kind });
}
export function removeFeedReaction(announcementId) {
  return apiSend(`/api/hr/me/engagement/feed/${announcementId}/reaction`, 'DELETE');
}
// Threaded comments: { items:[{ …, replies:[] }], total, page, pageSize }.
export function fetchFeedComments(announcementId, query = '') {
  return apiGet(`/api/hr/me/engagement/feed/${announcementId}/comments${query}`);
}
export function postFeedComment(announcementId, body) {
  return apiPost(`/api/hr/me/engagement/feed/${announcementId}/comments`, body);
}
export function editFeedComment(announcementId, commentId, body) {
  return apiPatch(`/api/hr/me/engagement/feed/${announcementId}/comments/${commentId}`, body);
}
export function deleteFeedComment(announcementId, commentId) {
  return apiSend(`/api/hr/me/engagement/feed/${announcementId}/comments/${commentId}`, 'DELETE');
}

// ── ESS notification inbox (the top-bar bell) ─────────────────────────────────
// SELF-ONLY; the recipient is resolved from the session. `unlinked:true` in the list
// means the employee has no operator User → render an empty bell gracefully.
export function fetchNotifications(query = '') {
  return apiGet(`/api/hr/me/notifications${query}`);
}
export function fetchNotificationsUnreadCount() {
  return apiGet('/api/hr/me/notifications/unread-count');
}
export function markNotificationRead(id) {
  return apiPost(`/api/hr/me/notifications/${id}/read`);
}
export function markAllNotificationsRead() {
  return apiPost('/api/hr/me/notifications/read-all');
}

// ── Cycle 1 (ESS) — Celebration opt-out (privacy control) ─────────────────────
// The signed-in employee's OWN celebration opt-out state. When opted out, their
// birthday/anniversary is hidden from the company celebration feed for everyone.
export function fetchMyCelebrationPreferences() {
  return apiGet('/api/hr/me/engagement/celebrations/preferences');
}
// Set the caller's OWN celebration opt-out (self-only write).
export function updateMyCelebrationPreferences(body) {
  return apiPatch('/api/hr/me/engagement/celebrations/preferences', body);
}
