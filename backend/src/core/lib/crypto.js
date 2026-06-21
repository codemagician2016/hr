// Symmetric encryption helpers used to store third-party tokens
// (Google / Zoom / MS Teams refresh + access tokens) at rest.
//
// AES-256-GCM with a key derived from the existing JWT_SECRET via SHA-256
// (so the env-var rotation story stays "rotate JWT_SECRET → re-encrypt").
// GCM gives integrity for free — if a token is tampered with, decrypt
// throws.
//
// Output format: base64( iv (12 bytes) | tag (16 bytes) | ciphertext )
//
// Why not store tokens as-is?
// - Compromised DB backup ≠ instant access to every tenant's calendar /
//   meeting account. Attacker also needs the JWT_SECRET (env var on the
//   running process; not in DB).
// - Every popular SaaS that touches OAuth tokens does at-rest encryption;
//   doing the same makes the eventual SOC 2 / pen-test path easier.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set — refusing to encrypt without a key');
  }
  // SHA-256 collapses arbitrary-length JWT_SECRET into a 32-byte key.
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(payload) {
  if (payload === null || payload === undefined || payload === '') return null;
  const key = deriveKey();
  const buf = Buffer.from(String(payload), 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Ciphertext too short — not a valid encrypted token');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString('utf8');
}

module.exports = { encrypt, decrypt };
