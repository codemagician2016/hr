'use strict';

/*
 * candidateAuth.js — Feature 38 passwordless CANDIDATE identity for the careers
 * portal. Distinct from operator (User) and employee (Customer) sessions.
 *
 * Magic-link flow (no passwords): a candidate enters their email → we email a short-
 * lived signed MAGIC token → clicking it verifies and mints a longer-lived SESSION
 * token in an httpOnly cookie. "Forgot" is a non-issue — request a fresh link.
 *
 * Tokens are stateless JWTs signed with the shared JWT_SECRET, tagged `typ` so a
 * candidate token can never be confused with an operator/customer token.
 */

const jwt = require('jsonwebtoken');
const prisma = require('../../../core/lib/prisma');

const COOKIE = 'drifthr_candidate';
const MAGIC_TTL = '30m';
const SESSION_TTL = '30d';

function secret() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
  return process.env.JWT_SECRET;
}

// A magic-link token proves control of an email for a tenant (business) — it does
// NOT itself grant a session; verifying it does.
function signMagicToken({ businessId, email }) {
  return jwt.sign({ typ: 'candidate_magic', businessId, email: String(email).toLowerCase() }, secret(), { expiresIn: MAGIC_TTL });
}
function signSessionToken({ candidateId, businessId }) {
  return jwt.sign({ typ: 'candidate', candidateId, businessId }, secret(), { expiresIn: SESSION_TTL });
}
function verifyTyped(token, typ) {
  const decoded = jwt.verify(token, secret());
  if (!decoded || decoded.typ !== typ) throw new Error('wrong token type');
  return decoded;
}

function setCandidateCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000, path: '/',
  });
}
function clearCandidateCookie(res) { res.clearCookie(COOKIE, { path: '/' }); }

function readCandidateToken(req) {
  const fromCookie = req.cookies && req.cookies[COOKIE];
  if (fromCookie) return fromCookie;
  const auth = req.headers && req.headers.authorization;
  if (auth && /^Bearer /i.test(auth)) return auth.replace(/^Bearer /i, '').trim();
  return null;
}

// Express middleware: require a valid candidate session; sets req.candidate.
async function requireCandidate(req, res, next) {
  try {
    const token = readCandidateToken(req);
    if (!token) return res.status(401).json({ message: 'Please sign in to continue.' });
    const decoded = verifyTyped(token, 'candidate');
    const candidate = await prisma.candidate.findFirst({
      where: { id: decoded.candidateId, businessId: decoded.businessId, deletedAt: null },
    });
    if (!candidate) return res.status(401).json({ message: 'Your session has expired — request a new sign-in link.' });
    req.candidate = candidate;
    return next();
  } catch (_e) {
    return res.status(401).json({ message: 'Your session has expired — request a new sign-in link.' });
  }
}

module.exports = {
  COOKIE,
  signMagicToken, signSessionToken, verifyTyped,
  setCandidateCookie, clearCandidateCookie, readCandidateToken,
  requireCandidate,
};
