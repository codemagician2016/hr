// Return the API base URL deterministically from env config — never
// from request headers.
//
// Calendar feeds, .ics download links, OAuth callback redirects, and
// any other URL we hand to a third party (Google, Outlook, etc.) all
// must be served from `api.<domain>`, not whichever frontend host the
// user happened to be browsing.
//
// Bug history (2026-04-27):
//   - Staff Notifications page showed an http://www.aapkatech.com/api/...
//     calendar URL because the request came from www and Cloudflare's
//     Flexible-SSL proxy passed `X-Forwarded-Proto: http` to the origin.
//     Google Calendar refused to subscribe; even if it had, the URL
//     pointed at the wrong host.
//   - Fix: ignore request headers entirely; build from env vars.
//
// Resolution order:
//   1. PUBLIC_API_URL                 (preferred — the canonical override)
//   2. NEXT_PUBLIC_API_URL            (frontend env, often set on backend too)
//   3. https://api.<PLATFORM_DOMAIN>  (computed from the tenant root)
//   4. https://api.sitepresso.com     (last-resort default for prod)

function resolveApiBaseUrl() {
  const explicit = process.env.PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const domain = process.env.PLATFORM_DOMAIN || 'sitepresso.com';
  return `https://api.${domain}`;
}

module.exports = { resolveApiBaseUrl };
