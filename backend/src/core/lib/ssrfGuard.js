'use strict';

// ssrfGuard.js — outbound-request egress validation (SSRF defence).
//
// Tenant-controlled URLs (webhook subscriptions, integration base URLs, brand
// logo URLs) must never be able to make the server reach internal/private
// network space — cloud metadata (169.254.169.254), loopback, RFC-1918, ULA,
// link-local, CGNAT, etc. This module resolves the host to IPs and rejects any
// request whose target resolves to a non-public address, and re-validates on
// every redirect hop (undici/fetch follows redirects by default, so we force
// redirect:'manual' and walk them ourselves).
//
// Zero dependencies — pure Node (dns/net/url). The residual DNS-rebind window
// (resolve → connect) is small and bounded by re-validating on each redirect;
// the practical exploits (literal-IP metadata fetch, internal hostname reach,
// redirect-to-internal) are all closed.

const dns = require('dns').promises;
const net = require('net');

class SsrfBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfBlockedError';
    this.status = 400;
  }
}

// Non-production allows http:// + loopback so local dev / tests against
// 127.0.0.1 mock servers keep working. Production is https-only + public-IP-only.
function loopbackAllowed() {
  return process.env.NODE_ENV !== 'production' || process.env.SSRF_ALLOW_LOOPBACK === '1';
}

function ipv4IsPublic(ip) {
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0) return false;                    // 0.0.0.0/8 "this network"
  if (a === 10) return false;                   // 10/8 private
  if (a === 127) return false;                  // loopback
  if (a === 169 && b === 254) return false;     // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12 private
  if (a === 192 && b === 168) return false;     // 192.168/16 private
  if (a === 192 && b === 0) return false;       // 192.0.0/24 + 192.0.2/24 (test)
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18/15 benchmark
  if (a >= 224) return false;                   // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return true;
}

function ipv6IsPublic(ip) {
  const lower = ip.toLowerCase().split('%')[0]; // strip zone id
  if (lower === '::1' || lower === '::') return false;      // loopback / unspecified
  // IPv4-mapped / NAT64 / 6to4 — extract embedded v4 and validate it.
  const embedded = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded) return ipv4IsPublic(embedded[1]);
  const head = lower.split(':')[0];
  if (head.startsWith('fe8') || head.startsWith('fe9') || head.startsWith('fea') || head.startsWith('feb')) return false; // fe80::/10 link-local
  if (head.startsWith('fc') || head.startsWith('fd')) return false; // fc00::/7 ULA
  if (head.startsWith('ff')) return false;      // ff00::/8 multicast
  if (lower.startsWith('2002:')) return false;  // 6to4 (may tunnel private v4) — reject conservatively
  return true;
}

function ipIsPublic(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return loopbackAllowed() ? true : ipv4IsPublic(ip);
  if (kind === 6) return loopbackAllowed() ? true : ipv6IsPublic(ip);
  return false;
}

// Validate a single URL string. Throws SsrfBlockedError on any violation.
// Returns the parsed URL when safe.
async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new SsrfBlockedError('Invalid URL');
  }

  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'https:' && !(scheme === 'http:' && loopbackAllowed())) {
    throw new SsrfBlockedError(`Blocked URL scheme: ${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new SsrfBlockedError('URL has no host');

  // Literal IP — validate directly, no DNS.
  if (net.isIP(host)) {
    if (!ipIsPublic(host)) throw new SsrfBlockedError(`Blocked non-public address: ${host}`);
    return url;
  }

  // Hostname — resolve every A/AAAA record and require all to be public.
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError(`Could not resolve host: ${host}`);
  }
  if (!records.length) throw new SsrfBlockedError(`Host did not resolve: ${host}`);
  for (const { address } of records) {
    if (!ipIsPublic(address)) throw new SsrfBlockedError(`Host ${host} resolves to a non-public address`);
  }
  return url;
}

// Drop-in replacement for fetch() that validates the target (and every redirect
// hop) against the egress policy. Follows up to `maxRedirects` redirects
// manually, re-validating each Location. Everything else is passed through to
// the global fetch. Callers keep their existing timeout/AbortController.
async function safeFetch(rawUrl, options = {}, { maxRedirects = 3 } = {}) {
  let currentUrl = (await assertPublicUrl(rawUrl)).toString();
  let redirects = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(currentUrl, { ...options, redirect: 'manual' });
    const status = res.status;
    if (status >= 300 && status < 400 && res.headers.get('location')) {
      if (redirects >= maxRedirects) throw new SsrfBlockedError('Too many redirects');
      redirects += 1;
      const next = new URL(res.headers.get('location'), currentUrl);
      currentUrl = (await assertPublicUrl(next.toString())).toString();
      continue;
    }
    return res;
  }
}

module.exports = { assertPublicUrl, safeFetch, ipIsPublic, SsrfBlockedError };
