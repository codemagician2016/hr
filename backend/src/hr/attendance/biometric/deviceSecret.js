'use strict';

/**
 * deviceSecret.js — Feature 28 per-device shared-secret helpers for the push door.
 * Mirrors core/lib/publicApi.js (sha256 hash stored, constant-time verify, the raw
 * secret returned ONCE on mint). The device/agent presents the raw secret as
 * `X-Device-Secret`; we store only the hash + a last-4 display hint. NEVER the raw.
 */

const crypto = require('crypto');

const SECRET_PREFIX = 'dvc_';
const SECRET_BYTES = 24;

/** Mint a new raw secret → { raw, hash, last4 }. The raw is shown ONCE. */
function mintSecret() {
  const raw = SECRET_PREFIX + crypto.randomBytes(SECRET_BYTES).toString('hex');
  return { raw, hash: hashSecret(raw), last4: raw.slice(-4) };
}

function hashSecret(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/** Constant-time compare of a presented raw secret against the stored hash. */
function verifySecret(raw, storedHash) {
  if (!raw || !storedHash) return false;
  const computed = hashSecret(raw);
  if (computed.length !== storedHash.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
  } catch (_e) {
    return false;
  }
}

module.exports = { mintSecret, hashSecret, verifySecret, SECRET_PREFIX };
