'use strict';

/**
 * mobileHost.js — Feature 41 (mobile-web hosts). One convention everywhere:
 *
 *   m-<slug>.<platformDomain>      → <slug>.<platformDomain>        (prod)
 *   m-<slug>-<platformDomain>      → <slug>-<platformDomain>        (staging hyphen form)
 *   m.<custom-domain>              → <custom-domain>                (BYO domain)
 *
 * i.e. a leading "m-" or "m." on the host marks the MOBILE-WEB alias of the
 * tenant's base host. The ESS app is mobile-first, so the alias serves the same
 * app — the alias only has to RESOLVE to the same tenant.
 *
 * IMPORTANT — fallback, never rewrite: a tenant could legitimately own a slug
 * starting with "m-" (slug regex allows it) or bind "m.example.com" itself as a
 * custom domain. Every caller therefore resolves the EXACT host first and only
 * tries the stripped base when the exact host matched nothing.
 */

/** The base host this host would be a mobile alias OF, or null when it isn't one. */
function mobileHostBase(host) {
  const h = String(host || '').toLowerCase().split(':')[0].trim();
  if (h.startsWith('m-') || h.startsWith('m.')) {
    const base = h.slice(2);
    return base && base.includes('.') ? base : null;
  }
  return null;
}

/** Candidate hosts to try in order: the exact host, then its mobile base (if any). */
function hostCandidates(host) {
  const h = String(host || '').toLowerCase().split(':')[0].trim();
  if (!h) return [];
  const base = mobileHostBase(h);
  return base ? [h, base] : [h];
}

module.exports = { mobileHostBase, hostCandidates };
