'use strict';

/*
 * capture.unit.test.js — DB-FREE tests for the multi-mode capture primitives:
 *   - ip.js          : IPv4/IPv6 CIDR membership, v4-mapped-v6 fold, bare address,
 *                      evaluatePunchIp graceful degradation (empty list / no IP).
 *   - faceMatcher.js : the stub matcher's NEEDS_REVIEW / SKIPPED verdicts +
 *                      cosineSimilarity for a future real matcher.
 *   - policy.enforceCapture : the PURE decision function — reject under ENFORCE,
 *                      flag under WARN, for each mode + the review-queue marks.
 *
 * Plain-node (built-in assert, no jest):
 *   node backend/src/hr/attendance/capture/__tests__/capture.unit.test.js
 *
 * The LIVE end-to-end proof (real punch → policy resolved → punch rejected/flagged
 * → review queue → tenant isolation) lives in capture.live.test.js.
 */

const assert = require('assert');
const { ipInCidr, evaluatePunchIp, parseCidr, parseIp } = require('../ip');
const faceMatcher = require('../faceMatcher');
const { enforceCapture, NULL_POLICY } = require('../policy');

let passed = 0;
let failed = 0;
const fails = [];
function check(name, cond) {
  if (cond) { passed += 1; } else { failed += 1; fails.push(name); console.error(`  FAIL  ${name}`); }
}

/* ── ip.js : CIDR membership ─────────────────────────────────────────────────*/
check('v4 inside /24', ipInCidr('10.0.0.5', '10.0.0.0/24') === true);
check('v4 outside /24', ipInCidr('10.0.1.5', '10.0.0.0/24') === false);
check('v4 /32 exact', ipInCidr('203.0.113.7', '203.0.113.7/32') === true);
check('v4 bare address == /32', ipInCidr('203.0.113.7', '203.0.113.7') === true);
check('v4 bare address miss', ipInCidr('203.0.113.8', '203.0.113.7') === false);
check('v4 0.0.0.0/0 matches all', ipInCidr('8.8.8.8', '0.0.0.0/0') === true);
check('v4 /16 boundary in', ipInCidr('172.16.255.1', '172.16.0.0/16') === true);
check('v4 /16 boundary out', ipInCidr('172.17.0.1', '172.16.0.0/16') === false);

check('v6 inside /32', ipInCidr('2001:db8::1', '2001:db8::/32') === true);
check('v6 outside /32', ipInCidr('2001:dead::1', '2001:db8::/32') === false);
check('v6 ::/0 matches all', ipInCidr('2001:db8::1', '::/0') === true);
check('v6 /48 in', ipInCidr('2001:db8:abcd::1', '2001:db8:abcd::/48') === true);
check('v6 /48 out', ipInCidr('2001:db8:abce::1', '2001:db8:abcd::/48') === false);

// v4-mapped-v6 folds to v4 so it matches a v4 CIDR (proxies sometimes hand this back).
check('v4-mapped-v6 folds to v4 in', ipInCidr('::ffff:10.0.0.5', '10.0.0.0/24') === true);
check('v4-mapped-v6 folds to v4 out', ipInCidr('::ffff:10.0.1.5', '10.0.0.0/24') === false);

// Cross-version never matches.
check('v4 ip vs v6 cidr → false', ipInCidr('10.0.0.5', '2001:db8::/32') === false);
// Malformed inputs never throw, always false.
check('garbage ip → false', ipInCidr('not-an-ip', '10.0.0.0/24') === false);
check('garbage cidr → false', ipInCidr('10.0.0.5', 'nope/99') === false);
check('parseCidr rejects /33 v4', parseCidr('10.0.0.0/33') === null);
check('parseIp null on empty', parseIp('') === null);

/* ── ip.js : evaluatePunchIp graceful degradation ───────────────────────────*/
{
  const v = evaluatePunchIp('8.8.8.8', ['10.0.0.0/8', '203.0.113.0/24']);
  check('off-net → evaluated:true allowed:false', v.evaluated === true && v.allowed === false);
}
{
  const v = evaluatePunchIp('10.1.2.3', ['10.0.0.0/8']);
  check('on-net → allowed:true matchedCidr', v.allowed === true && v.matchedCidr === '10.0.0.0/8');
}
{
  const v = evaluatePunchIp('8.8.8.8', []);
  check('empty CIDR list → evaluated:false (no-op)', v.evaluated === false && v.allowed === null);
}
{
  const v = evaluatePunchIp(null, ['10.0.0.0/8']);
  check('no client IP → evaluated:false (no-op)', v.evaluated === false);
}

/* ── faceMatcher : stub verdicts ─────────────────────────────────────────────*/
(async () => {
  const stub = faceMatcher.getMatcher();
  const withSelfie = await stub.matchFace(null, 'data:image/jpeg;base64,AAA', { threshold: 0.7 });
  check('stub w/ selfie → NEEDS_REVIEW', withSelfie.status === 'NEEDS_REVIEW' && withSelfie.score === null);
  const noSelfie = await stub.matchFace(null, null, { threshold: 0.7 });
  check('stub no selfie → SKIPPED', noSelfie.status === 'SKIPPED');
  const emb = await stub.embed('data:image/jpeg;base64,AAA', {});
  check('stub embed → null embedding (selfie still stored by controller)', emb.embedding === null && emb.matcher === 'stub');

  // cosineSimilarity sanity for a future real matcher.
  check('cosine identical = 1', Math.abs(faceMatcher.cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  check('cosine orthogonal = 0', Math.abs(faceMatcher.cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  check('cosine length mismatch → null', faceMatcher.cosineSimilarity([1, 0], [1]) === null);

  /* ── policy.enforceCapture : the PURE decision matrix ─────────────────────*/
  const geoOut = { evaluated: true, outOfGeofence: true, distanceM: 150 };
  const geoIn = { evaluated: true, outOfGeofence: false, distanceM: 10 };
  const ipOff = { evaluated: true, allowed: false };
  const ipOn = { evaluated: true, allowed: true };

  // NULL policy → never rejects, never flags.
  {
    const v = enforceCapture({ policy: NULL_POLICY, geoVerdict: geoOut, ipVerdict: ipOff, faceVerdict: null, hasSelfie: false });
    check('NULL policy → ok, no flags', v.ok && !v.reject && v.flags.length === 0);
  }

  // GEO enforce + out → reject.
  {
    const v = enforceCapture({ policy: { requireGeo: true, geoEnforce: true }, geoVerdict: geoOut, ipVerdict: null, faceVerdict: null, hasSelfie: false });
    check('GEO enforce + out → reject', v.reject === true && /geofence/i.test(v.reason));
  }
  // GEO warn + out → flag, not reject.
  {
    const v = enforceCapture({ policy: { requireGeo: true, geoEnforce: false }, geoVerdict: geoOut, ipVerdict: null, faceVerdict: null, hasSelfie: false });
    check('GEO warn + out → flag OUT_OF_GEOFENCE', !v.reject && v.flags.includes('OUT_OF_GEOFENCE') && v.marks.captureFlagged === true);
  }
  // GEO + in → clean.
  {
    const v = enforceCapture({ policy: { requireGeo: true, geoEnforce: true }, geoVerdict: geoIn, ipVerdict: null, faceVerdict: null, hasSelfie: false });
    check('GEO in radius → clean', v.ok && v.flags.length === 0);
  }

  // IP enforce + off → reject; warn + off → flag; on → clean.
  {
    const r = enforceCapture({ policy: { requireIp: true, ipEnforce: true }, geoVerdict: null, ipVerdict: ipOff, faceVerdict: null, hasSelfie: false });
    check('IP enforce + off → reject', r.reject === true && /network/i.test(r.reason));
    const w = enforceCapture({ policy: { requireIp: true, ipEnforce: false }, geoVerdict: null, ipVerdict: ipOff, faceVerdict: null, hasSelfie: false });
    check('IP warn + off → flag OFF_NETWORK', !w.reject && w.flags.includes('OFF_NETWORK') && w.marks.ipAllowed === false);
    const ok = enforceCapture({ policy: { requireIp: true, ipEnforce: true }, geoVerdict: null, ipVerdict: ipOn, faceVerdict: null, hasSelfie: false });
    check('IP on-net → clean (ipAllowed:true)', ok.ok && ok.marks.ipAllowed === true);
  }

  // FACE required + no selfie: enforce → reject, warn → flag.
  {
    const r = enforceCapture({ policy: { requireFace: true, faceEnforce: true }, geoVerdict: null, ipVerdict: null, faceVerdict: null, hasSelfie: false });
    check('FACE enforce + no selfie → reject', r.reject === true && /selfie/i.test(r.reason));
    const w = enforceCapture({ policy: { requireFace: true, faceEnforce: false }, geoVerdict: null, ipVerdict: null, faceVerdict: null, hasSelfie: false });
    check('FACE warn + no selfie → flag FACE_MISSING_SELFIE', !w.reject && w.flags.includes('FACE_MISSING_SELFIE'));
  }
  // FACE required + selfie + stub NEEDS_REVIEW → always flag (never hard-reject by default).
  {
    const v = enforceCapture({ policy: { requireFace: true, faceEnforce: true }, geoVerdict: null, ipVerdict: null, faceVerdict: { score: null, matched: null, status: 'NEEDS_REVIEW' }, hasSelfie: true });
    check('FACE + stub NEEDS_REVIEW → flag, not reject', !v.reject && v.flags.includes('FACE_NEEDS_REVIEW') && v.marks.faceMatchStatus === 'NEEDS_REVIEW');
  }
  // FACE enforce + NO_MATCH (real matcher) → reject; NO_REFERENCE enforce → reject.
  {
    const nm = enforceCapture({ policy: { requireFace: true, faceEnforce: true }, geoVerdict: null, ipVerdict: null, faceVerdict: { score: 0.3, matched: false, status: 'NO_MATCH' }, hasSelfie: true });
    check('FACE enforce + NO_MATCH → reject', nm.reject === true && /match/i.test(nm.reason));
    const nr = enforceCapture({ policy: { requireFace: true, faceEnforce: true }, geoVerdict: null, ipVerdict: null, faceVerdict: { score: null, matched: null, status: 'NO_REFERENCE' }, hasSelfie: true });
    check('FACE enforce + NO_REFERENCE → reject', nr.reject === true);
  }
  // FACE + MATCHED → clean.
  {
    const v = enforceCapture({ policy: { requireFace: true, faceEnforce: true }, geoVerdict: null, ipVerdict: null, faceVerdict: { score: 0.92, matched: true, status: 'MATCHED' }, hasSelfie: true });
    check('FACE MATCHED → clean', v.ok && v.flags.length === 0 && v.marks.faceMatched === true);
  }

  // Combined: multiple modes, mixed enforce — the captureMethods audit list + flag set.
  {
    const v = enforceCapture({
      policy: { requireGeo: true, geoEnforce: false, requireIp: true, ipEnforce: false, requireFace: true, faceEnforce: false },
      geoVerdict: geoOut, ipVerdict: ipOff, faceVerdict: { status: 'NEEDS_REVIEW', score: null, matched: null }, hasSelfie: true,
    });
    check('combined warn → methods audit all 3', v.methods.join(',') === 'GEO_FENCE,IP_RESTRICTED,FACE');
    check('combined warn → 3 flags, no reject', !v.reject && v.flags.length === 3 && v.marks.captureFlagged === true);
  }

  // ── summary ──────────────────────────────────────────────────────────────
  console.log(`\ncapture.unit: ${passed} passed, ${failed} failed`);
  if (failed) { console.error('FAILED:', fails.join('; ')); process.exit(1); }
  console.log('capture.unit OK');
})();
