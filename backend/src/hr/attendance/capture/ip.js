'use strict';

/**
 * ip.js — PURE IP / CIDR math for the IP_RESTRICTED attendance capture mode.
 *
 * No DB, no I/O, no prisma, no Date.now. Plain-`node` unit-testable. The caller
 * (policy.js / the punch controllers) resolves the punch's TRUSTED client IP and
 * the location's allowed CIDR list, then asks this module whether the punch fell
 * inside an office network.
 *
 * TRUSTED IP — NOT SPOOFABLE via raw XFF. The caller passes Express's `req.ip`,
 * which with `app.set('trust proxy', 1)` (see src/index.js) resolves to the real
 * client across the SINGLE trusted nginx hop. We deliberately do NOT read raw
 * `x-forwarded-for` here (a client can prepend arbitrary tokens to it); reusing
 * `req.ip` is the same anti-spoof posture as the public-careers rate-limit fix.
 *
 * Supports IPv4, IPv6, IPv4-mapped IPv6 (::ffff:a.b.c.d → a.b.c.d), and a bare
 * address as a /32 (v4) or /128 (v6). Matching is done on the big-integer form of
 * the address masked to the prefix length — no string prefix games.
 */

// Parse an IPv4 dotted-quad into a BigInt (0 .. 2^32-1), or null if malformed.
function parseV4(str) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(str).trim());
  if (!m) return null;
  let n = 0n;
  for (let i = 1; i <= 4; i += 1) {
    const o = Number(m[i]);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8n) | BigInt(o);
  }
  return n;
}

// Parse an IPv6 string into a BigInt (0 .. 2^128-1), or null if malformed.
// Handles "::" compression and a trailing embedded IPv4 (e.g. "::ffff:1.2.3.4").
function parseV6(str) {
  let s = String(str).trim();
  if (s.indexOf(':') === -1) return null;
  // Strip a zone id (fe80::1%eth0) — irrelevant to CIDR membership.
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);

  // Expand a trailing dotted-quad into two hextets.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.indexOf('.') !== -1) {
    const v4 = parseV4(tail);
    if (v4 == null) return null;
    const hi = (v4 >> 16n) & 0xffffn;
    const lo = v4 & 0xffffn;
    s = `${s.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null; // more than one "::" is illegal

  const toGroups = (part) => (part === '' ? [] : part.split(':'));
  const head = toGroups(halves[0]);
  const back = halves.length === 2 ? toGroups(halves[1]) : null;

  let groups;
  if (back === null) {
    groups = head;
    if (groups.length !== 8) return null;
  } else {
    const fill = 8 - head.length - back.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...back];
  }
  if (groups.length !== 8) return null;

  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

// Normalise an address string → { version: 4|6, value: BigInt } or null.
// An IPv4-mapped IPv6 ("::ffff:1.2.3.4") is folded down to plain IPv4 so it
// matches an IPv4 CIDR (browsers/proxies sometimes hand back the mapped form).
function parseIp(str) {
  if (str == null) return null;
  let s = String(str).trim();
  if (!s) return null;
  // ::ffff:a.b.c.d or ::ffff:hhhh:hhhh → IPv4 fold.
  const mapped = /^::ffff:(.+)$/i.exec(s);
  if (mapped) {
    const inner = mapped[1];
    const v4dotted = parseV4(inner);
    if (v4dotted != null) return { version: 4, value: v4dotted };
    // ::ffff:7f00:0001 form
    const m = /^([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4})$/.exec(inner);
    if (m) {
      const v = (BigInt(parseInt(m[1], 16)) << 16n) | BigInt(parseInt(m[2], 16));
      return { version: 4, value: v };
    }
  }
  if (s.indexOf(':') === -1) {
    const v4 = parseV4(s);
    return v4 == null ? null : { version: 4, value: v4 };
  }
  const v6 = parseV6(s);
  return v6 == null ? null : { version: 6, value: v6 };
}

// Parse a CIDR string ("a.b.c.d/nn", "::/0", or a bare address) into
// { version, base: BigInt, prefix: Number } or null. A bare address → full mask.
function parseCidr(str) {
  if (str == null) return null;
  const raw = String(str).trim();
  if (!raw) return null;
  const slash = raw.indexOf('/');
  const addrPart = slash === -1 ? raw : raw.slice(0, slash);
  const ip = parseIp(addrPart);
  if (!ip) return null;
  const maxBits = ip.version === 4 ? 32 : 128;
  let prefix = maxBits;
  if (slash !== -1) {
    const p = Number(raw.slice(slash + 1));
    if (!Number.isInteger(p) || p < 0 || p > maxBits) return null;
    prefix = p;
  }
  return { version: ip.version, base: ip.value, prefix, maxBits };
}

// Is `ipStr` inside `cidrStr`? false on any parse failure or version mismatch.
function ipInCidr(ipStr, cidrStr) {
  const ip = parseIp(ipStr);
  const net = parseCidr(cidrStr);
  if (!ip || !net) return false;
  if (ip.version !== net.version) return false;
  if (net.prefix === 0) return true; // 0.0.0.0/0 or ::/0 — everything
  const shift = BigInt(net.maxBits - net.prefix);
  const mask = (~0n << shift);
  return (ip.value & mask) === (net.base & mask);
}

/**
 * evaluatePunchIp(ip, cidrs) → { evaluated, allowed, ip, matchedCidr }.
 *
 * GRACEFUL DEGRADATION — returns `{ evaluated:false }` (never blocks) when:
 *   - the cidrs list is empty/absent (the location has no IP allow-list), OR
 *   - the punch carries no resolvable IP (e.g. a kiosk/biometric punch).
 * Otherwise `allowed` = the IP matched ANY active CIDR. Off-network → allowed:false.
 */
function evaluatePunchIp(ip, cidrs) {
  const list = Array.isArray(cidrs) ? cidrs.filter((c) => typeof c === 'string' && c.trim()) : [];
  if (!list.length) return { evaluated: false, allowed: null, ip: ip || null, matchedCidr: null };
  if (!parseIp(ip)) return { evaluated: false, allowed: null, ip: ip || null, matchedCidr: null };
  for (const c of list) {
    if (ipInCidr(ip, c)) return { evaluated: true, allowed: true, ip, matchedCidr: c };
  }
  return { evaluated: true, allowed: false, ip, matchedCidr: null };
}

module.exports = { parseIp, parseCidr, ipInCidr, evaluatePunchIp };
