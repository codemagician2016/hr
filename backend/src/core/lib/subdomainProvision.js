'use strict';

// ============================================================================
// subdomainProvision.js — self-service DriftHR subdomain provisioning.
//
// Mode A of Feature 3 (Self-service Domain & Branding): bind a tenant to
// `{slug}-staging.drifthr.com` (staging) / `{slug}.drifthr.com` (prod) by
// writing ONE Cloudflare DNS CNAME → the DEDICATED Cloudflare tunnel, then
// recording it on the tenant's Subscription as an ACTIVE/verified customDomain
// (resolved by the same custom-domain path as demo-staging).
//
// The wildcard ingress `*.drifthr.com → http://localhost:4200` is a ONE-TIME
// manual config on the DEDICATED tunnel, so per-tenant provisioning never
// edits tunnel config at runtime — it only writes a DNS record.
//
// HARD INVARIANT: we only ever point CNAMEs at the DEDICATED tunnel. The
// SHARED tunnel (used by app-staging / demo-staging / etc.) must NEVER be
// touched — a module-load guard asserts the two IDs are distinct so a
// copy-paste swap can never ship.
//
// BEST-EFFORT: every CF interaction is wrapped so that missing creds OR a
// failed API call LOG a warning and return { provisioned: false } instead of
// throwing. The DB slug write in the caller must succeed even when DNS
// provisioning can't run (e.g. local dev with no Cloudflare token).
// ============================================================================

const prisma = require('./prisma');

// The DEDICATED Cloudflare tunnel that carries `*.drifthr.com`. Tenant CNAMEs
// point at `{DEDICATED_TUNNEL_ID}.cfargotunnel.com`.
const DEDICATED_TUNNEL_ID = 'c87a09e3-258a-4c7a-8ab6-b30b01055d94';
// The SHARED tunnel — load-bearing for app-staging/demo-staging and friends.
// Listed ONLY so the not-shared guard below can prove we never use it.
const SHARED_TUNNEL_ID = '1fd39436-6495-4381-9a40-8c663b50c29a';

// Module-load NOT-SHARED guard (QA §5 case 13): if a refactor ever set the
// dedicated ID to the shared one, fail loudly at require() time rather than
// silently CNAME tenants onto the shared tunnel.
if (DEDICATED_TUNNEL_ID === SHARED_TUNNEL_ID) {
  throw new Error(
    'subdomainProvision: DEDICATED_TUNNEL_ID must NEVER equal the SHARED tunnel ' +
    '1fd39436-6495-4381-9a40-8c663b50c29a — refusing to load.'
  );
}

const DEFAULT_CF_ACCOUNT = 'a1a83e9621188bda80ef2203a0368f6a';

function isStaging() {
  // Staging when explicitly flagged, or whenever we are not in production.
  if (String(process.env.IS_STAGING || '').trim()) return true;
  return String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production';
}

function cfToken() {
  return String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
}

function cfAccount() {
  return String(process.env.CF_ACCOUNT || DEFAULT_CF_ACCOUNT).trim();
}

function platformZoneName() {
  return String(process.env.PLATFORM_DOMAIN || 'drifthr.com')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/\.$/, '')
    .trim() || 'drifthr.com';
}

// The CNAME content that points a tenant host at the DEDICATED tunnel.
function dedicatedTunnelTarget() {
  return `${DEDICATED_TUNNEL_ID}.cfargotunnel.com`;
}

// The audit/safety tag stamped onto every DNS record we own, so deprovision
// can refuse to delete records it didn't create (e.g. app-staging/demo-staging).
function tenantTag(businessId) {
  return `drifthr-tenant:${businessId}`;
}

// `{slug}-staging.drifthr.com` (staging) / `{slug}.drifthr.com` (prod).
function hostForSlug(slug, staging = isStaging()) {
  const clean = String(slug || '').trim().toLowerCase();
  const zone = platformZoneName();
  return staging ? `${clean}-staging.${zone}` : `${clean}.${zone}`;
}

// Best-effort Cloudflare API call. Throws on failure — callers wrap it.
async function cf(path, options = {}) {
  const token = cfToken();
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const msg = Array.isArray(json.errors) ? json.errors.map((e) => e.message).filter(Boolean).join('; ') : '';
    const err = new Error(msg || `Cloudflare API failed (${res.status})`);
    err.status = res.status;
    err.cloudflare = json;
    throw err;
  }
  return json.result;
}

// Resolve the drifthr.com zone id: explicit env wins, else look it up by name.
async function resolveZoneId() {
  const explicit = String(process.env.CF_ZONE_ID || process.env.CLOUDFLARE_ZONE_ID || '').trim();
  if (explicit) return explicit;
  const zones = await cf(`/zones?name=${encodeURIComponent(platformZoneName())}`);
  return Array.isArray(zones) ? zones[0]?.id || null : null;
}

async function findCnameRecord(zoneId, host) {
  const params = new URLSearchParams({ type: 'CNAME', name: host });
  const records = await cf(`/zones/${zoneId}/dns_records?${params.toString()}`);
  return Array.isArray(records) ? records[0] || null : null;
}

// Idempotent provision: write (or correct) the tenant CNAME, then bind it onto
// the Subscription. Best-effort — on missing creds or any CF failure, logs and
// returns { provisioned: false } WITHOUT throwing (the caller's slug write must
// still succeed). Returns { host, url, provisioned }.
async function provisionSubdomain({ businessId, slug, staging = isStaging() } = {}) {
  const host = hostForSlug(slug, staging);
  const url = `https://${host}`;

  if (!cfToken()) {
    console.warn(`[subdomainProvision] CLOUDFLARE_API_TOKEN unset — skipping DNS for ${host} (best-effort).`);
    return { host, url, provisioned: false };
  }

  try {
    const zoneId = await resolveZoneId();
    if (!zoneId) {
      console.warn(`[subdomainProvision] could not resolve zone for ${platformZoneName()} — skipping ${host}.`);
      return { host, url, provisioned: false };
    }

    const target = dedicatedTunnelTarget();
    const body = {
      type: 'CNAME',
      name: host,
      content: target,
      proxied: true,
      ttl: 1,
      comment: tenantTag(businessId),
    };

    const expected = tenantTag(businessId);
    const existing = await findCnameRecord(zoneId, host);
    if (!existing) {
      // No record → CREATE it (tagged for this business).
      await cf(`/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify(body) });
    } else if (existing.comment === expected) {
      // It's ours (tag matches) → PATCH only if the content drifted (idempotent
      // re-runs are no-ops).
      if (existing.content !== target) {
        await cf(`/zones/${zoneId}/dns_records/${existing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      }
    } else {
      // WRITE tag-safety (mirror of the deprovision tag-gate): a record with a
      // DIFFERENT or EMPTY comment is NOT ours — it could be infra (app-staging/
      // demo-staging/saas-origin) or another tenant's host. REFUSE: do NOT PATCH
      // the record and do NOT bind the subscription, so a slug can never hijack
      // an existing host.
      console.warn(
        `[subdomainProvision] refusing to write ${host}: comment ` +
        `${JSON.stringify(existing.comment)} !== ${JSON.stringify(expected)} (host-not-owned).`
      );
      return { provisioned: false, refused: true, reason: 'host-not-owned', host };
    }

    // Bind the host onto the tenant's subscription so resolveBusinessId routes
    // it (same path as demo-staging). Best-effort: a DB miss here still leaves
    // a live DNS record, and the slug itself was already written by the caller.
    if (businessId) {
      try {
        await prisma.subscription.update({
          where: { businessId },
          data: {
            customDomain: host,
            customDomainStatus: 'ACTIVE',
            customDomainVerified: true,
            customDomainCheckedAt: new Date(),
          },
        });
      } catch (dbErr) {
        // Unique-constraint collision on customDomain — another tenant already
        // owns this host. Surface as a refusal so the caller can 409 {taken}.
        if (dbErr?.code === 'P2002') {
          console.warn(`[subdomainProvision] customDomain ${host} already taken (P2002) — refusing bind.`);
          return { host, url, provisioned: false, refused: true, reason: 'taken' };
        }
        throw dbErr;
      }
    }

    return { host, url, provisioned: true };
  } catch (err) {
    console.warn(`[subdomainProvision] provision for ${host} failed (best-effort): ${err?.message || err}`);
    return { host, url, provisioned: false };
  }
}

// Tag-gated deprovision (QA §5 case 3 — tag-safety): delete the CNAME ONLY if
// its comment is our tenant tag for THIS business. A record without the tag, or
// tagged for a different business (e.g. app-staging/demo-staging), is left
// untouched. Missing record (404) is a no-op success. Best-effort throughout.
async function deprovisionSubdomain({ businessId, host } = {}) {
  const cleanHost = String(host || '').trim().toLowerCase();
  if (!cleanHost) return { host: cleanHost, deprovisioned: false };

  if (!cfToken()) {
    console.warn(`[subdomainProvision] CLOUDFLARE_API_TOKEN unset — skipping deprovision for ${cleanHost}.`);
    return { host: cleanHost, deprovisioned: false };
  }

  try {
    const zoneId = await resolveZoneId();
    if (!zoneId) {
      console.warn(`[subdomainProvision] could not resolve zone — skipping deprovision for ${cleanHost}.`);
      return { host: cleanHost, deprovisioned: false };
    }

    const record = await findCnameRecord(zoneId, cleanHost);
    if (!record) return { host: cleanHost, deprovisioned: false }; // already gone (404-equivalent)

    const expected = tenantTag(businessId);
    if (record.comment !== expected) {
      // Tag mismatch — NOT ours. Never delete app-staging/demo-staging/etc.
      console.warn(
        `[subdomainProvision] refusing to delete ${cleanHost}: comment ` +
        `${JSON.stringify(record.comment)} !== ${JSON.stringify(expected)} (tag-safety).`
      );
      return { host: cleanHost, deprovisioned: false, refused: true };
    }

    await cf(`/zones/${zoneId}/dns_records/${record.id}`, { method: 'DELETE' });
    return { host: cleanHost, deprovisioned: true };
  } catch (err) {
    if (err?.status === 404) return { host: cleanHost, deprovisioned: false };
    console.warn(`[subdomainProvision] deprovision for ${cleanHost} failed (best-effort): ${err?.message || err}`);
    return { host: cleanHost, deprovisioned: false };
  }
}

module.exports = {
  DEDICATED_TUNNEL_ID,
  SHARED_TUNNEL_ID,
  DEFAULT_CF_ACCOUNT,
  isStaging,
  hostForSlug,
  dedicatedTunnelTarget,
  tenantTag,
  provisionSubdomain,
  deprovisionSubdomain,
};
