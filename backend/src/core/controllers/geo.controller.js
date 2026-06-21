//
// geo.controller.js — address helpers for the country-aware billing/onboarding
// address form.
//   • India PIN-code → state/city lookup (so the buyer never mistypes the state,
//     which keeps the GST place-of-supply / CGST-SGST-vs-IGST correct).
//   • Public client config (Google Maps browser key) served at runtime so the
//     key is never baked into the bundle — mirrors the Paddle client-token
//     pattern.
//
const PINCODE_API = 'https://api.postalpincode.in/pincode';

// GET /api/geo/in-pincode/:pin
// → { pin, state, district, city, localities[], cities[] }
async function lookupIndiaPincode(req, res) {
  const pin = String(req.params.pin || '').trim();
  if (!/^[1-9][0-9]{5}$/.test(pin)) {
    return res.status(400).json({ message: 'Enter a valid 6-digit PIN code.' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch(`${PINCODE_API}/${pin}`, { signal: controller.signal });
    const data = await resp.json().catch(() => null);
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry || entry.Status !== 'Success' || !Array.isArray(entry.PostOffice) || !entry.PostOffice.length) {
      return res.status(404).json({ message: 'No location found for that PIN code.' });
    }
    const offices = entry.PostOffice;
    // State is constant across a PIN; district usually is too. Localities (post
    // office names) and any distinct districts power the "pick exact" dropdown.
    const state = offices[0].State || '';
    const district = offices[0].District || '';
    const localities = [...new Set(offices.map((o) => o.Name).filter(Boolean))];
    const cities = [...new Set(offices.map((o) => o.District).filter(Boolean))];
    return res.json({ pin, state, district, city: district, localities, cities });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({ message: 'PIN lookup timed out. Enter the city/state manually.' });
    }
    console.error('[geo] pincode lookup failed:', err?.message || err);
    return res.status(502).json({ message: 'Could not look up that PIN code right now.' });
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/geo/config — public client config. The Google Maps key is a
// referrer-restricted browser key, so it is safe to expose; serving it here
// (vs NEXT_PUBLIC_* build inlining) means it can be rotated via box env without
// a rebuild, and the address form simply falls back to manual entry if absent.
function getGeoConfig(_req, res) {
  res.json({ googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null });
}

module.exports = { lookupIndiaPincode, getGeoConfig };
