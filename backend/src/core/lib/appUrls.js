'use strict';

/**
 * appUrls.js — where a notification's deep link should actually point.
 *
 * THE BUG THIS EXISTS TO KILL
 * ───────────────────────────────────────────────────────────────────────────
 * Notification links were built from NEXT_PUBLIC_PLATFORM_URL / PLATFORM_DOMAIN,
 * which is the MARKETING/platform host (drifthr.com). But every page those links
 * open — /approvals, /leave/…, the recruitment console, the candidate status
 * page — is served by the HR ADMIN app on app.<domain>. So the links resolved to
 * a host that has no such route and answered 404. Measured on production:
 *
 *     drifthr.com/approvals              404      app.drifthr.com/approvals              200
 *     drifthr.com/careers/demo/c/<tok>   404      app.drifthr.com/careers/demo/c/<tok>   200
 *
 * Every approval email and every candidate status link was dead. It surfaced as
 * two separate QA bugs (DRIFTHR-1001/-1002) because a tester meets it one email
 * at a time; it is one defect.
 *
 * NOT every link belongs here. The public careers BOARD is correctly served on
 * the TENANT host (demo.drifthr.com/careers → 200) because the ESS careers routes
 * resolve the tenant FROM the host. Use adminAppBaseUrl() only for pages the HR
 * admin app owns; keep using careersBoardUrl() for the board.
 */

let _hostForSlug;
try {
  ({ hostForSlug: _hostForSlug } = require('./subdomainProvision'));
} catch { _hostForSlug = null; }

/**
 * Base URL of the HR ADMIN app (app.<domain> / app-staging.<domain>).
 *
 * hostForSlug already encodes the environment's host shape — it returns
 * `app.drifthr.com` in production and `app-staging.drifthr.com` on staging —
 * so the admin host is just the "app" subdomain under the same rule that gives
 * every tenant theirs. Verified against both boxes rather than assumed.
 */
function adminAppBaseUrl() {
  // Explicit override wins, for a box whose admin app is somewhere unusual
  // (custom domain, a one-off port during local dev).
  const explicit = String(process.env.ADMIN_APP_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');

  try {
    if (_hostForSlug) {
      const host = _hostForSlug('app');
      if (host) return `https://${host}`;
    }
  } catch { /* fall through */ }

  // Last resort. Deliberately still prefixed with app. — the bare platform host
  // is the very value that produced the 404s, so falling back to it would
  // reintroduce the bug on any box where hostForSlug cannot resolve.
  const domain = String(process.env.PLATFORM_DOMAIN || 'drifthr.com').trim();
  return `https://app.${domain.replace(/^app\./, '')}`;
}

/**
 * Base URL of a TENANT's own host (demo.<domain> / demo-staging.<domain>), which
 * is where the ESS app is served.
 *
 * Not every deep link belongs on the admin host. The employee/candidate-facing
 * ESS pages — the careers board, the e-sign onboarding page — resolve the tenant
 * FROM the host, so they only work there. Returns null without a slug, so callers
 * must decide their own fallback rather than silently getting a wrong host.
 */
function tenantAppBaseUrl(slug) {
  const clean = String(slug || '').trim().toLowerCase();
  if (!clean) return null;
  try {
    if (_hostForSlug) {
      const host = _hostForSlug(clean);
      if (host) return `https://${host}`;
    }
  } catch { /* fall through */ }
  return null;
}

module.exports = { adminAppBaseUrl, tenantAppBaseUrl };
