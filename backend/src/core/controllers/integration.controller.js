// Business integrations controller — manages per-tenant OAuth connections
// to video providers (Google Meet, Zoom, MS Teams).
//
// Endpoints (all BUSINESS_ADMIN):
//   GET    /api/business/integrations              — list connected + available
//   POST   /api/business/integrations/:provider/connect   — start OAuth flow → returns redirect URL
//   GET    /api/business/integrations/:provider/callback  — provider redirects here with ?code=
//   DELETE /api/business/integrations/:provider    — disconnect
//
// Phase A scope: list + disconnect work end-to-end. Connect/callback
// route through to the provider modules which throw NotImplemented for
// now — the abstraction is in place; per-provider bodies land in B/C/D.

const prisma = require('../lib/prisma');
const { getProvider, listProviders, KNOWN_KEYS } = require('../lib/videoProviders');
const { encrypt } = require('../lib/crypto');

function backendBaseUrl(req) {
  // Build the redirect URI back to *this* backend deterministically.
  // x-forwarded-proto + host are nginx-set in production; fall back to
  // request defaults in local dev.
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host');
  return `${proto}://${host}`;
}

function callbackUrl(req, providerKey) {
  return `${backendBaseUrl(req)}/api/business/integrations/${providerKey}/callback`;
}

// GET /api/business/integrations
async function listForBusiness(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const rows = await prisma.businessIntegration.findMany({
    where: { businessId: req.user.businessId },
    select: {
      provider: true,
      status: true,
      externalAccountEmail: true,
      connectedAt: true,
      lastUsedAt: true,
      lastError: true,
    },
  });
  const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));
  // Return one row per known provider — UI shows Connect for missing
  // ones and Status / Disconnect for present ones.
  const providers = listProviders().map((p) => ({
    ...p,
    connection: byProvider[p.key] || null,
  }));
  res.json({ providers });
}

// POST /api/business/integrations/:provider/connect
async function startConnect(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'Set up your business first' });
  const { provider: providerKey } = req.params;
  if (!KNOWN_KEYS.includes(providerKey)) return res.status(404).json({ message: 'Unknown provider' });
  const provider = getProvider(providerKey);
  if (!provider.isConfigured()) {
    return res.status(503).json({
      message: `${provider.displayName} integration isn't enabled on this server yet — env vars missing.`,
    });
  }
  // Sign a short-lived state so the callback can verify it came from us
  // and pluck out which businessId / userId initiated. JWT keeps it tamper-
  // resistant without needing a session store.
  const jwt = require('jsonwebtoken');
  const state = jwt.sign(
    {
      kind: 'integration_oauth',
      provider: providerKey,
      businessId: req.user.businessId,
      userId: req.user.id,
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' },
  );
  try {
    const url = provider.getConnectUrl({
      businessId: req.user.businessId,
      redirectUri: callbackUrl(req, providerKey),
      state,
    });
    res.json({ url });
  } catch (err) {
    if (err.code === 'PROVIDER_NOT_IMPLEMENTED') {
      return res.status(501).json({ message: err.message });
    }
    console.error('[integration/connect] failed:', err.message);
    res.status(500).json({ message: 'Failed to start OAuth flow' });
  }
}

// GET /api/business/integrations/:provider/callback
async function handleCallback(req, res) {
  const { provider: providerKey } = req.params;
  const { code, state, error: providerError } = req.query;
  if (!KNOWN_KEYS.includes(providerKey)) return res.status(404).send('Unknown provider');

  if (providerError) {
    return res.redirect(`/api/business/integrations/__finish?error=${encodeURIComponent(providerError)}`);
  }
  if (!code || !state) return res.status(400).send('Missing code or state');

  const jwt = require('jsonwebtoken');
  let decoded;
  try {
    decoded = jwt.verify(state, process.env.JWT_SECRET);
  } catch {
    return res.status(400).send('Invalid or expired OAuth state — please try connecting again.');
  }
  if (decoded.kind !== 'integration_oauth' || decoded.provider !== providerKey) {
    return res.status(400).send('OAuth state mismatch');
  }

  const provider = getProvider(providerKey);
  try {
    const result = await provider.handleCallback({
      code: String(code),
      redirectUri: callbackUrl(req, providerKey),
    });
    // Persist (upsert by businessId + provider).
    await prisma.businessIntegration.upsert({
      where: { businessId_provider: { businessId: decoded.businessId, provider: providerKey } },
      update: {
        status: 'ACTIVE',
        scopes: result.scopes || null,
        externalAccountId: result.externalAccountId || null,
        externalAccountEmail: result.externalAccountEmail || null,
        refreshTokenEncrypted: result.refreshToken ? encrypt(result.refreshToken) : null,
        accessTokenEncrypted: result.accessToken ? encrypt(result.accessToken) : null,
        accessTokenExpiry: result.expiresAt || null,
        connectedByUserId: decoded.userId,
        connectedAt: new Date(),
        lastError: null,
      },
      create: {
        businessId: decoded.businessId,
        provider: providerKey,
        status: 'ACTIVE',
        scopes: result.scopes || null,
        externalAccountId: result.externalAccountId || null,
        externalAccountEmail: result.externalAccountEmail || null,
        refreshTokenEncrypted: result.refreshToken ? encrypt(result.refreshToken) : null,
        accessTokenEncrypted: result.accessToken ? encrypt(result.accessToken) : null,
        accessTokenExpiry: result.expiresAt || null,
        connectedByUserId: decoded.userId,
      },
    });
    // Redirect back to the admin UI's settings page. Frontend reads ?ok=
    // to show a toast.
    res.redirect(`https://${process.env.PLATFORM_DOMAIN || 'sitepresso.com'}/__connect/done?provider=${providerKey}&ok=1`);
  } catch (err) {
    if (err.code === 'PROVIDER_NOT_IMPLEMENTED') {
      return res.status(501).send(err.message);
    }
    console.error(`[integration/callback ${providerKey}] failed:`, err.message);
    res.redirect(`https://${process.env.PLATFORM_DOMAIN || 'sitepresso.com'}/__connect/done?provider=${providerKey}&error=${encodeURIComponent(err.message)}`);
  }
}

// DELETE /api/business/integrations/:provider
async function disconnect(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'Set up your business first' });
  const { provider: providerKey } = req.params;
  if (!KNOWN_KEYS.includes(providerKey)) return res.status(404).json({ message: 'Unknown provider' });
  // Best-effort revoke at the provider — don't block on failure since
  // user can still revoke manually in the provider's account UI.
  // (Will become real once the provider modules implement revoke.)
  await prisma.businessIntegration.deleteMany({
    where: { businessId: req.user.businessId, provider: providerKey },
  });
  res.json({ ok: true });
}

module.exports = {
  listForBusiness,
  startConnect,
  handleCallback,
  disconnect,
};
