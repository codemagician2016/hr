// Sprint 2.8b — POS (Square / Clover / Shopify POS) inventory sync.
//
// Skeleton module — wired but inactive until tenant onboards a POS
// integration via PosIntegration table (provider-specific OAuth tokens,
// stored encrypted).
//
// Two operating modes:
//   1. Pull: cron polls each connected POS every 5-15 min, reconciles
//      stock + product info into Sitepresso DB.
//   2. Push: webhook from POS fires on order/inventory change → updates here.
//
// First provider: Square. Easiest API, widest IN/SG/global coverage.
//
// Today's hold: requires SQUARE_APPLICATION_ID + redirect URLs registered
// with Square. Re-enable per-provider once tenant onboarded.
'use strict';

const PROVIDERS = Object.freeze({
  SQUARE: {
    apiBase: 'https://connect.squareup.com',
    listInventoryPath: (locationId) => `/v2/inventory/changes/batch-retrieve`,
    listCatalogPath: () => `/v2/catalog/list`,
    authHeader: (accessToken) => ({ Authorization: `Bearer ${accessToken}`, 'Square-Version': '2024-04-17' }),
  },
  CLOVER: {
    apiBase: 'https://api.clover.com',
    // Clover uses merchant-id-scoped paths. Tokens are merchant-scoped from OAuth.
    listInventoryPath: (merchantId) => `/v3/merchants/${merchantId}/inventory/items`,
    authHeader: (accessToken) => ({ Authorization: `Bearer ${accessToken}` }),
  },
});

function isConfiguredForProvider(provider) {
  if (provider === 'SQUARE') return !!process.env.SQUARE_APPLICATION_ID;
  if (provider === 'CLOVER') return !!process.env.CLOVER_APP_ID;
  return false;
}

// Pull recent inventory changes from the POS for one PosIntegration row.
// Returns { ok, items: [{externalId, quantity, ...}] } or {ok:false, reason}.
async function pullInventory({ integration }) {
  if (!isConfiguredForProvider(integration.provider)) {
    return { ok: false, reason: 'NOT_CONFIGURED' };
  }
  const cfg = PROVIDERS[integration.provider];
  if (!cfg) return { ok: false, reason: 'UNSUPPORTED_PROVIDER' };

  // Provider-specific implementation goes here. Skeleton returns empty.
  // Square: POST /v2/inventory/changes/batch-retrieve with location_ids.
  // Clover: GET /v3/merchants/:mid/inventory/items.
  return { ok: true, items: [] };
}

// Reconcile pulled items against Sitepresso products. Skeleton — no-ops.
// Future: match by externalId on Product, update stockQty, log discrepancies.
async function reconcile({ businessId, items }) {
  // implementation deferred
  return { ok: true, updated: 0, discrepancies: [] };
}

module.exports = { PROVIDERS, isConfiguredForProvider, pullInventory, reconcile };
