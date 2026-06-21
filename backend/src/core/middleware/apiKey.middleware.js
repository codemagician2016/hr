// Public API authentication — for /api/v1/* routes called by tenant-side
// integrations (their CRM, their Zapier flow, etc.).
//
// Auth shape: `Authorization: Bearer sp_live_<...>`. Hash lookup against
// ApiKey.keyHash; updates lastUsedAt on every accepted request. On
// success attaches:
//   req.business  = { id, slug, name, vertical }
//   req.apiKey    = { id, name, scopes }     // scopes = { read: [...], write: [...] }
//
// Per-resource scope is enforced by `requireScope('read', 'appointments')`
// helper rather than inline in every handler.
'use strict';

const { PrismaClient } = require('@prisma/client');
const { hashKey } = require('../lib/publicApi');

const prisma = new PrismaClient();

async function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing Authorization: Bearer <api-key> header',
    });
  }
  const raw = match[1];
  const hash = hashKey(raw);
  const key = await prisma.apiKey.findUnique({
    where: { keyHash: hash },
    include: { business: { select: { id: true, slug: true, name: true, vertical: true, isActive: true } } },
  });
  if (!key || !key.isActive || !key.business?.isActive) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid or revoked API key' });
  }
  // Fire-and-forget — don't block the request on the touch.
  prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  req.business = key.business;
  req.apiKey = { id: key.id, name: key.name, scopes: key.scopes || { read: [], write: [] } };
  next();
}

// Per-route scope check. Usage: router.get('/foo', requireApiKey, requireScope('read', 'appointments'), handler)
function requireScope(action, resource) {
  return (req, res, next) => {
    const scopes = req.apiKey?.scopes || {};
    const list = Array.isArray(scopes[action]) ? scopes[action] : [];
    if (!list.includes(resource) && !list.includes('*')) {
      return res.status(403).json({
        error: 'forbidden',
        message: `API key missing scope: ${action}:${resource}`,
      });
    }
    next();
  };
}

module.exports = { requireApiKey, requireScope };
