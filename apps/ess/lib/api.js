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
