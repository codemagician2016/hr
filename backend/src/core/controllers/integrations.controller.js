//
// integrations.controller.js — AapkaConnect: connect a tenant to ANY external
// service app and talk to it through one generic engine. No per-provider code.
//
const prisma = require('../lib/prisma');
const connect = require('../lib/aapkaConnect');

const VALID_CATEGORY = /^[a-z][a-z0-9_-]{1,30}$/;

// The storefront chat snippet we auto-install when a 'chat' provider connects.
// Tagged with data-aapka-connect so disconnect can tell OUR snippet from a
// custom one the seller pasted by hand (which we must never touch).
function chatWidgetSnippet(baseUrl, workspaceId) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return `<script src="${base}/widget.js" data-aapka-chat data-aapka-connect="1" data-api-base="${base}" data-workspace="${workspaceId}" data-installation="web" async></script>`;
}
function isOurChatSnippet(script) {
  return typeof script === 'string' && script.includes('data-aapka-connect="1"');
}

function serialize(c) {
  return {
    id: c.id, category: c.category, provider: c.provider, baseUrl: c.baseUrl,
    status: c.status, workspaceId: c.workspaceId || null,
    manifest: c.manifest || null,
    hasKey: Boolean(c.apiKeyEnc), webhookActive: Boolean(c.webhookSecret),
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

// GET /api/integrations
async function listConnections(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'Set up your business first.' });
  const rows = await prisma.serviceConnection.findMany({ where: { businessId: req.user.businessId }, orderBy: { createdAt: 'asc' } });
  return res.json({ connections: rows.map(serialize) });
}

// POST /api/integrations  { category, baseUrl, apiKey }
// Discovers the app's manifest, stores the (encrypted) key, and best-effort
// registers our webhook so the provider can push events back.
async function connectService(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'Set up your business first.' });
  const category = String(req.body?.category || '').trim().toLowerCase();
  const baseUrl = String(req.body?.baseUrl || '').trim();
  const apiKey = String(req.body?.apiKey || '').trim();
  if (!VALID_CATEGORY.test(category)) return res.status(422).json({ message: 'Invalid category.' });
  if (!/^https?:\/\//.test(baseUrl)) return res.status(422).json({ message: 'baseUrl must be an http(s) URL.' });

  let manifest;
  try {
    manifest = await connect.fetchManifest(baseUrl);
  } catch (err) {
    const timeout = err.status === 504;
    return res.status(timeout ? 504 : 422).json({
      message: timeout
        ? `${baseUrl} didn't respond. Check the address and that the app is online.`
        : `${baseUrl} isn't a connectable app — no AapkaConnect manifest found there. Double-check the address.`,
      code: timeout ? 'timeout' : 'not_aapka',
    });
  }
  if (manifest.category && manifest.category !== category) {
    return res.status(422).json({ message: `That app is a '${manifest.category}' app, not '${category}'. Pick the matching slot.`, code: 'category_mismatch' });
  }

  // Verify the key actually works BEFORE we save — so "Connected" always means
  // "working". A rejected key fails loudly here instead of a silent dead badge.
  let workspaceId = null;
  if (apiKey) {
    try {
      const me = await connect.pingProvider({ baseUrl, apiKeyEnc: connect.encryptApiKey(apiKey), manifest });
      workspaceId = me?.workspace?.id ? String(me.workspace.id) : null;
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        return res.status(422).json({ message: `${manifest.name || 'The app'} rejected that API key. Copy the full key from the app and try again.`, code: 'key_rejected' });
      }
      if (err.status === 504) {
        return res.status(504).json({ message: `${manifest.name || 'The app'} didn't respond in time. Try again in a moment.`, code: 'timeout' });
      }
      // 404 (no identity endpoint) / other: can't verify, but don't block the connect.
    }
  }

  const data = {
    businessId: req.user.businessId, category, provider: manifest.name || baseUrl, baseUrl,
    apiKeyEnc: apiKey ? connect.encryptApiKey(apiKey) : null, manifest, workspaceId, status: 'ACTIVE',
  };
  const saved = await prisma.serviceConnection.upsert({
    where: { businessId_category: { businessId: req.user.businessId, category } },
    create: data, update: { ...data, updatedAt: new Date() },
  });

  // Register our webhook so the provider pushes events to us. (Surfaced in the UI:
  // if it doesn't take, the tenant sees "events off" + a one-click re-enable.)
  if (apiKey && manifest.webhooks?.register) {
    try {
      const ourUrl = `${req.protocol}://${req.get('host')}/api/integrations/${saved.id}/webhook`;
      const secret = await connect.registerProviderWebhook(saved, ourUrl, manifest.events || ['*']);
      if (secret) await prisma.serviceConnection.update({ where: { id: saved.id }, data: { webhookSecret: secret } });
    } catch { /* non-fatal — surfaced in UI as "events off", re-enable available */ }
  }

  // For 'chat', auto-install the storefront widget (never clobbering a hand-pasted
  // script) so it's instantly useful to the tenant's visitors.
  if (workspaceId && category === 'chat') {
    try {
      const seo = await prisma.businessSeoSettings.findUnique({ where: { businessId: req.user.businessId } });
      if (!seo?.customChatWidgetScript || isOurChatSnippet(seo.customChatWidgetScript)) {
        const snippet = chatWidgetSnippet(baseUrl, workspaceId);
        await prisma.businessSeoSettings.upsert({
          where: { businessId: req.user.businessId },
          create: { businessId: req.user.businessId, customChatWidgetScript: snippet },
          update: { customChatWidgetScript: snippet },
        });
      }
    } catch { /* non-fatal — widget can still be added manually in Settings → SEO */ }
  }

  const fresh = await prisma.serviceConnection.findUnique({ where: { id: saved.id } });
  return res.status(201).json({ connection: serialize(fresh) });
}

// DELETE /api/integrations/:id
async function disconnectService(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'Set up your business first.' });
  const row = await prisma.serviceConnection.findFirst({ where: { id: req.params.id, businessId: req.user.businessId } });
  if (!row) return res.status(404).json({ message: 'Connection not found.' });
  await prisma.serviceConnection.delete({ where: { id: row.id } });
  // If we auto-installed the storefront chat widget for this connection,
  // remove it. A hand-pasted custom script is left alone.
  if (row.category === 'chat') {
    const seo = await prisma.businessSeoSettings.findUnique({ where: { businessId: req.user.businessId } }).catch(() => null);
    if (seo && isOurChatSnippet(seo.customChatWidgetScript)) {
      await prisma.businessSeoSettings.update({ where: { businessId: req.user.businessId }, data: { customChatWidgetScript: '' } }).catch(() => {});
    }
  }
  return res.json({ disconnected: true });
}

// POST /api/integrations/:id/test — verify the connection actually works right now
// (pings the provider's identity endpoint). Returns 200 with {ok} so the UI can
// show the result inline. The "is it really working?" button.
async function testConnection(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'Set up your business first.' });
  const row = await prisma.serviceConnection.findFirst({ where: { id: req.params.id, businessId: req.user.businessId } });
  if (!row) return res.status(404).json({ message: 'Connection not found.' });
  try {
    const me = await connect.pingProvider(row);
    const ws = me?.workspace?.id ? String(me.workspace.id) : (row.workspaceId || null);
    if (ws && ws !== row.workspaceId) await prisma.serviceConnection.update({ where: { id: row.id }, data: { workspaceId: ws } });
    return res.json({ ok: true, workspace: me?.workspace || null, webhookActive: Boolean(row.webhookSecret) });
  } catch (err) {
    const code = (err.status === 401 || err.status === 403) ? 'key_rejected' : err.status === 504 ? 'timeout' : 'error';
    const message = code === 'key_rejected'
      ? 'The app rejected this key — it may have been revoked. Reconnect with a fresh key.'
      : code === 'timeout' ? 'The app didn’t respond in time. Try again.'
        : (err.message || 'Could not reach the app.');
    return res.json({ ok: false, code, message });
  }
}

// POST /api/integrations/:id/register-webhook — (re)register our webhook so the
// provider pushes events back. Fixes the silent "connected but events off" case.
async function registerWebhook(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'Set up your business first.' });
  const row = await prisma.serviceConnection.findFirst({ where: { id: req.params.id, businessId: req.user.businessId } });
  if (!row) return res.status(404).json({ message: 'Connection not found.' });
  const manifest = row.manifest || {};
  if (!manifest.webhooks?.register) return res.json({ ok: false, message: 'This app doesn’t push event webhooks.' });
  try {
    const ourUrl = `${req.protocol}://${req.get('host')}/api/integrations/${row.id}/webhook`;
    const secret = await connect.registerProviderWebhook(row, ourUrl, manifest.events || ['*']);
    if (secret) {
      await prisma.serviceConnection.update({ where: { id: row.id }, data: { webhookSecret: secret } });
      return res.json({ ok: true, webhookActive: true });
    }
    return res.json({ ok: false, message: 'The app didn’t return a webhook secret.' });
  } catch (err) {
    return res.json({ ok: false, message: err.message || 'Could not enable events.' });
  }
}

// POST /api/integrations/:category/call  { method, path, body }
// Generic pass-through so the rest of Sitepresso can invoke a connected provider
// without knowing which provider it is.
async function callConnection(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'Set up your business first.' });
  const category = String(req.params.category || '').toLowerCase();
  const row = await prisma.serviceConnection.findFirst({ where: { businessId: req.user.businessId, category, status: 'ACTIVE' } });
  if (!row) return res.status(404).json({ message: `No active '${category}' connection.` });
  try {
    const result = await connect.callProvider(row, { method: req.body?.method || 'GET', path: req.body?.path, body: req.body?.body });
    return res.json({ result });
  } catch (err) {
    return res.status(err.status || 502).json({ message: err.message, data: err.data || null });
  }
}

// POST /api/integrations/:category/sso
// Returns a short-lived, workspace-scoped URL to open the connected app, signed
// in as this tenant. Scoped to this connection only — no cross-tenant access.
async function ssoConnection(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'Set up your business first.' });
  const category = String(req.params.category || '').toLowerCase();
  const row = await prisma.serviceConnection.findFirst({ where: { businessId: req.user.businessId, category, status: 'ACTIVE' } });
  if (!row) return res.status(404).json({ message: `No active '${category}' connection.` });
  try {
    const url = await connect.requestSso(row);
    if (!url) return res.status(502).json({ message: 'The app did not return an SSO URL.' });
    return res.json({ url });
  } catch (err) {
    return res.status(err.status || 502).json({ message: err.message });
  }
}

// POST /api/integrations/:id/webhook  (PUBLIC — the provider calls it; verified by HMAC)
// Mounted with a raw-body parser (see index.js) so the signature can be checked.
async function receiveWebhook(req, res) {
  const row = await prisma.serviceConnection.findUnique({ where: { id: req.params.id } }).catch(() => null);
  if (!row || !row.webhookSecret) return res.status(404).json({ message: 'unknown connection' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  const sig = req.get('x-rider-signature') || req.get('x-aapka-signature') || req.get('x-signature') || '';
  if (!connect.verifyWebhook(row.webhookSecret, raw, sig)) return res.status(400).json({ message: 'invalid signature' });

  let event; try { event = JSON.parse(raw.toString('utf8')); } catch { event = null; }
  // Verified, authentic provider event. Per-category dispatch (e.g. delivery.delivered
  // → update the order) is wired per integration; for now we acknowledge + log.
  console.log(`[aapka-connect] ${row.category}/${row.provider} event:`, event?.type || 'unknown');
  return res.json({ received: true });
}

module.exports = { listConnections, connectService, disconnectService, testConnection, registerWebhook, callConnection, ssoConnection, receiveWebhook };
