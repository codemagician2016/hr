'use strict';

// SCIM bearer authentication + rate limiting (mirrors the ApiKey pattern:
// sha256-hashed token lookup, lastUsedAt touch, per-token rate key).
//
// On success attaches req.scim = { businessId, tokenId, tokenName }.
// All failures return the SCIM error envelope (IdP provisioning engines
// surface `detail` in their admin consoles).

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const prisma = require('../../core/lib/prisma');
const { hashKey } = require('../../core/lib/publicApi'); // sha256 hex — same as ApiKey
const { scimError } = require('./envelope');

function send(res, status, detail, scimType) {
  return res.status(status).type('application/scim+json').json(scimError(status, detail, scimType));
}

async function requireScimToken(req, res, next) {
  try {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!match) {
      return send(res, 401, 'Missing Authorization: Bearer <provisioning-token> header');
    }
    const token = await prisma.scimToken.findUnique({
      where: { tokenHash: hashKey(match[1]) },
      include: { business: { select: { id: true, isActive: true } } },
    });
    if (!token || !token.isActive || !token.business || token.business.isActive === false) {
      return send(res, 401, 'Invalid or revoked provisioning token');
    }
    // Best-effort touch — never block the request on it.
    prisma.scimToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    req.scim = { businessId: token.businessId, tokenId: token.id, tokenName: token.name };
    return next();
  } catch (err) {
    console.error('[scim] auth error:', err && err.message ? err.message : err);
    return send(res, 500, 'Internal error during authentication');
  }
}

// Keyed per token (post-auth), falling back to IP — the apiKeyLimiter shape
// (abuse.middleware.js) with a SCIM error envelope on 429.
const scimLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.scim?.tokenId
    ? `scim:${req.scim.tokenId}`
    : ipKeyGenerator(
        (req.headers['cf-connecting-ip'] || '').toString().trim()
        || (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()
        || req.ip
        || '',
      )),
  handler: (req, res) => send(res, 429, 'Too many requests — retry later'),
});

module.exports = { requireScimToken, scimLimiter, sendScimError: send };
