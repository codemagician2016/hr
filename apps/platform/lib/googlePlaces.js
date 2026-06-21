// Lazy Google Maps (Places) loader. The browser key is fetched at runtime from
// /api/geo/config (referrer-restricted, safe to expose). If no key is set the
// loader resolves to null and callers fall back to manual address entry.

let cachedKey;          // undefined = not fetched, null = none configured
let loadPromise = null;

async function getMapsKey() {
  if (cachedKey !== undefined) return cachedKey;
  try {
    const res = await fetch('/api/geo/config', { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    cachedKey = data?.googleMapsApiKey || null;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

// Resolves with window.google.maps (with the places library) or null.
export function loadGoogleMaps() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.google?.maps?.places) return Promise.resolve(window.google.maps);
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const key = await getMapsKey();
    if (!key) return null;
    await new Promise((resolve, reject) => {
      const id = 'google-maps-js';
      const existing = document.getElementById(id);
      if (existing) {
        if (window.google?.maps?.places) return resolve();
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.id = id;
      script.async = true;
      script.defer = true;
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&loading=async`;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    return window.google?.maps || null;
  })().catch(() => null);

  return loadPromise;
}

// Map a Google PlaceResult's address_components into our normalized shape.
export function parseGooglePlace(place) {
  const comps = place?.address_components || [];
  const pick = (type) => comps.find((c) => c.types?.includes(type));
  const streetNumber = pick('street_number')?.long_name || '';
  const route = pick('route')?.long_name || '';
  const sublocality = pick('sublocality')?.long_name || pick('sublocality_level_1')?.long_name || '';
  const locality = pick('locality')?.long_name || pick('postal_town')?.long_name || '';
  const region = pick('administrative_area_level_1')?.long_name || '';
  const postalCode = pick('postal_code')?.long_name || '';
  const city = locality || sublocality || '';
  const line1 = [streetNumber, route].filter(Boolean).join(' ') || place?.name || '';
  return {
    line1,
    line2: sublocality && sublocality !== city ? sublocality : '',
    city,
    state: region,
    postalCode,
  };
}
