// Persists a logged-in viewer's preferred language to their User or
// Customer row so the same locale follows them across devices /
// surfaces. Anonymous (guest) callers get a 200 no-op so the front-
// end can fire-and-forget without branching on auth state.
//
// The cookie (NEXT_LOCALE) remains the source of truth for the current
// page render — this endpoint is the durable backup.

const prisma = require('../lib/prisma');
const jwt = require('jsonwebtoken');
const { getJwtSecret, readCustomerToken, readOperatorToken } = require('../utils/generateToken');

// Whitelist of locales the app actually ships translations for. Keep
// in sync with platform/i18n/config.js SUPPORTED_LOCALES. Reject
// anything else to keep junk out of the DB.
const SUPPORTED = new Set(['en', 'hi', 'es', 'fr', 'de', 'it', 'pt-BR']);

async function setLocale(req, res) {
  const { locale } = req.body || {};
  if (!locale || typeof locale !== 'string' || !SUPPORTED.has(locale)) {
    return res.status(400).json({ message: 'Unsupported locale' });
  }

  // Try customer token first (HTTP-only `token` cookie).
  const customerToken = readCustomerToken(req);
  if (customerToken) {
    try {
      const decoded = jwt.verify(customerToken, getJwtSecret());
      if (decoded?.type === 'customer' && decoded?.id && decoded?.businessId) {
        await prisma.customer.updateMany({
          where: { id: decoded.id, businessId: decoded.businessId },
          data: { preferredLanguage: locale },
        });
        return res.json({ ok: true, scope: 'customer' });
      }
    } catch { /* fall through to operator token */ }
  }

  // Fall back to operator (User) token.
  const operatorToken = readOperatorToken(req);
  if (operatorToken) {
    try {
      const decoded = jwt.verify(operatorToken, getJwtSecret());
      if (decoded?.id && decoded?.type !== 'customer') {
        await prisma.user.update({
          where: { id: decoded.id },
          data: { preferredLanguage: locale },
        });
        return res.json({ ok: true, scope: 'user' });
      }
    } catch { /* guest */ }
  }

  // Guest — cookie alone is enough; nothing to persist.
  return res.json({ ok: true, scope: 'guest' });
}

module.exports = { setLocale, SUPPORTED };
