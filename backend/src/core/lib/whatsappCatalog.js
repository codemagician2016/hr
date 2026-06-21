// Sprint 2.5b — WhatsApp Catalog publishing.
//
// Skeleton module — wired but inactive until WHATSAPP_CATALOG_ID +
// WHATSAPP_BUSINESS_TOKEN env vars are set.
//
// Meta's Commerce API:
//   POST  graph.facebook.com/v18.0/{catalog_id}/products  — bulk add/update
//   GET   graph.facebook.com/v18.0/{catalog_id}/products
//
// Tenant-side flow (when activated):
//   1. Tenant connects WhatsApp Business Account (Meta OAuth)
//   2. Stored on Business.whatsappCatalogId + token (encrypted)
//   3. On Product create/update/delete, syncProductToCatalog() fires
//   4. WhatsApp Order endpoint (Sprint 2.5) hands customers a product picker
//
// Today's hold: requires Meta Business Verification ($0 but multi-day
// approval). Re-enable in this file's `isConfigured()` once tenant onboarded.
'use strict';

const { getDefaultCurrency } = require('./currency');

function isConfigured() {
  return !!(process.env.WHATSAPP_CATALOG_ID && process.env.WHATSAPP_BUSINESS_TOKEN);
}

// Map a Sitepresso Product → Meta Catalog product payload.
function productToCatalogPayload(product, business) {
  const baseUrl = `https://${business.slug}.${process.env.PLATFORM_DOMAIN || 'sitepresso.com'}`;
  const imageUrls = Array.isArray(product.imageUrls) ? product.imageUrls : [];
  return {
    retailer_id: product.id,                  // our internal ID
    name: product.name,
    description: (product.shortDescription || product.description || '').slice(0, 9999),
    url: `${baseUrl}/shop/${product.slug}`,
    image_url: imageUrls[0] || null,
    additional_image_urls: imageUrls.slice(1, 11),
    brand: business.name,
    price: `${(product.priceMinor / 100).toFixed(2)} ${product.currency || getDefaultCurrency({ business })}`,
    availability: (product.stockQty == null || product.stockQty > 0) ? 'in stock' : 'out of stock',
    condition: 'new',
  };
}

async function syncProductToCatalog({ product, business }) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  const payload = productToCatalogPayload(product, business);
  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_CATALOG_ID}/products`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_BUSINESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests: [{ method: 'CREATE', data: payload }] }),
      },
    );
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      return { ok: false, reason: 'API_ERROR', message: errBody.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

async function deleteProductFromCatalog({ retailerId }) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_CATALOG_ID}/products`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_BUSINESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests: [{ method: 'DELETE', data: { retailer_id: retailerId } }] }),
      },
    );
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      return { ok: false, reason: 'API_ERROR', message: errBody.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'NETWORK', message: err.message };
  }
}

module.exports = { isConfigured, productToCatalogPayload, syncProductToCatalog, deleteProductFromCatalog };
