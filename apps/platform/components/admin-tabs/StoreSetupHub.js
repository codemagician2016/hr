'use client';

// Store Setup — the single layman-friendly window that replaces hunting
// across Locations + Slots + Pickup + Cities + Settings(multi-store). One
// screen, four plain-language steps:
//   1. How do you sell?           → Business.multiStoreMode
//   2. Where you sell from        → BusinessLocation CRUD (/api/locations)
//   3. How customers get orders   → deliveryMode + pickupEnabled
//   4. Delivery times             → batch slot generator (/api/ecom/slots/generate)
//
// The old tabs still exist as "Advanced" deep-links for power-user edits
// (per-day holiday slots, postcode zones, etc.). This window writes to the
// same APIs — it's an orchestration layer, not a new data model.

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';
import { COUNTRIES } from '@/lib/countries';
import { currencyForCountry, formatCurrencyMinor, getDefaultCurrency } from '@/lib/currency';
import { slugify } from '@/lib/slugify';

// ─── Step "Store basics" ───────────────────────────────────────────────────
const LANGUAGES = [
  { code: '', label: 'Auto-detect (browser / location)' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'es', label: 'Español (Spanish)' },
  { code: 'fr', label: 'Français (French)' },
  { code: 'de', label: 'Deutsch (German)' },
  { code: 'it', label: 'Italiano (Italian)' },
  { code: 'pt-BR', label: 'Português (Brazilian)' },
];

const CURRENCIES = [
  ['USD', 'US Dollar'], ['INR', 'Indian Rupee'], ['EUR', 'Euro'], ['GBP', 'British Pound'],
  ['AUD', 'Australian Dollar'], ['NZD', 'New Zealand Dollar'], ['CAD', 'Canadian Dollar'],
  ['SGD', 'Singapore Dollar'], ['JPY', 'Japanese Yen'], ['KRW', 'South Korean Won'],
  ['AED', 'UAE Dirham'], ['HKD', 'Hong Kong Dollar'], ['ZAR', 'South African Rand'],
  ['BRL', 'Brazilian Real'], ['MXN', 'Mexican Peso'],
];

// Max locations per business — keep in sync with the backend cap in
// backend/src/core/controllers/locations.controller.js.
const MAX_LOCATIONS = 10;

// ─── Step "How customers pay" (plain language → paymentMode) ────────────────
const PAYMENT_MODES = [
  { key: 'BOTH', title: 'Online + cash', blurb: 'Customers choose at checkout. Recommended.' },
  { key: 'PREPAID_ONLY', title: 'Online only', blurb: 'Every order is paid online — no cash on delivery.' },
  { key: 'COD_ONLY', title: 'Cash only', blurb: 'No online payment — customers pay on delivery/pickup.' },
];

// Step 2 "How do you sell?" is now plan-tier cards (see SellingPlanStep) — the
// selling model (multiStoreMode) follows the plan, so the old 3-mode constant
// is gone. CHAIN = several branches, OFF/FULFILLMENT = single store.

// ─── Step 3: delivery method (plain language → deliveryMode) ────────────────
const DELIVERY_MODES = [
  { key: 'SCHEDULED', title: 'Scheduled delivery', blurb: 'Customers pick a delivery time window.' },
  { key: 'ASAP', title: 'Deliver as soon as possible', blurb: 'No time windows — you deliver when ready.' },
  { key: 'NONE', title: 'No delivery (pickup only)', blurb: 'Customers collect their order in person.' },
];

const DOW = [
  { i: 1, label: 'Mon' }, { i: 2, label: 'Tue' }, { i: 3, label: 'Wed' },
  { i: 4, label: 'Thu' }, { i: 5, label: 'Fri' }, { i: 6, label: 'Sat' }, { i: 0, label: 'Sun' },
];

const WINDOW_LENGTHS = [
  { minutes: 0, label: 'One all-day window' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 90, label: '1½ hours' },
  { minutes: 120, label: '2 hours' },
  { minutes: 180, label: '3 hours' },
];

// Mirror of the backend buildWindows() so the seller sees an exact preview.
function buildWindows(openTime, closeTime, windowMinutes) {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toStr = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  const start = toMin(openTime);
  const end = toMin(closeTime);
  const span = end - start;
  if (span <= 0) return [];
  if (!windowMinutes || windowMinutes <= 0 || windowMinutes >= span) {
    return [{ startTime: openTime, endTime: closeTime }];
  }
  const out = [];
  for (let s = start; s < end; s += windowMinutes) {
    const e = Math.min(s + windowMinutes, end);
    if (e - s < 15) break;
    out.push({ startTime: toStr(s), endTime: toStr(e) });
  }
  return out;
}

function prettyTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'pm' : 'am';
  const hr = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${hr}${period}` : `${hr}:${String(m).padStart(2, '0')}${period}`;
}

function splitPostcodes(value) {
  const seen = new Set();
  const out = [];
  const source = Array.isArray(value) ? value.join('\n') : String(value || '');
  source
    .split(/[\n,;]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((raw) => {
      const key = postcodeKey(raw);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(raw);
    });
  return out;
}

function postcodeKey(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function minorFromMajor(value, fallback = null) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number.parseFloat(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function majorFromMinor(minor) {
  const n = Number(minor || 0) / 100;
  return n ? String(Number(n.toFixed(2))) : '';
}

function etaLabel(minutes) {
  const n = Number(minutes || 0);
  if (!n) return 'No ETA';
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const COVERAGE_MODES = [
  { key: 'POSTCODES', title: 'Pincodes', blurb: 'Fast setup with pincode or postcode lists.' },
  { key: 'RADIUS', title: 'Radius', blurb: 'Serve customers within a distance from a center point.' },
  { key: 'POLYGON', title: 'Polygon', blurb: 'Draw an exact boundary with map coordinates.' },
  { key: 'MIXED', title: 'Pincode + map', blurb: 'Let either pincode or GPS location match this area.' },
];

function numberOrNull(value) {
  const n = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

function validLatLng(latValue, lngValue) {
  const lat = numberOrNull(latValue);
  const lng = numberOrNull(lngValue);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function emptyPolygonPoints() {
  return [
    { lat: '', lng: '' },
    { lat: '', lng: '' },
    { lat: '', lng: '' },
  ];
}

function geometryRingFromValue(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const ring = Array.isArray(value[0]?.[0]) ? value[0] : value;
  return ring
    .map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) return null;
      const point = validLatLng(pair[1], pair[0]);
      return point ? { lat: String(point.lat), lng: String(point.lng) } : null;
    })
    .filter(Boolean);
}

function parseZoneGeometry(polygon) {
  if (!polygon) return { mapMode: 'RADIUS', radiusLat: '', radiusLng: '', radiusKm: '3', polygonPoints: emptyPolygonPoints(), info: null };
  const geometry = polygon.type === 'Feature' && polygon.geometry ? polygon.geometry : polygon;
  const type = String(geometry.type || geometry.mode || '').toLowerCase();
  if (type === 'radius' || type === 'circle') {
    const center = validLatLng(geometry.center?.lat ?? geometry.lat ?? geometry.latitude, geometry.center?.lng ?? geometry.lng ?? geometry.lon ?? geometry.longitude);
    const radiusMeters = numberOrNull(geometry.radiusMeters ?? geometry.radius_meters ?? geometry.radius);
    return {
      mapMode: 'RADIUS',
      radiusLat: center ? String(center.lat) : '',
      radiusLng: center ? String(center.lng) : '',
      radiusKm: radiusMeters ? String(Number((radiusMeters / 1000).toFixed(2))) : '3',
      polygonPoints: emptyPolygonPoints(),
      info: radiusMeters ? `Radius ${Number((radiusMeters / 1000).toFixed(2))} km` : 'Radius area',
    };
  }
  const rawCoordinates = Array.isArray(geometry) ? geometry : (geometry.coordinates || geometry.points || []);
  const points = geometryRingFromValue(rawCoordinates);
  return {
    mapMode: 'POLYGON',
    radiusLat: '',
    radiusLng: '',
    radiusKm: '3',
    polygonPoints: points.length ? points : emptyPolygonPoints(),
    info: points.length >= 3 ? `Polygon ${points.length} points` : 'Polygon area',
  };
}

function validPolygonPoints(points) {
  return (points || [])
    .map((point) => validLatLng(point.lat, point.lng))
    .filter(Boolean);
}

function buildAreaGeometry(draft) {
  const mapMode = draft.coverageMode === 'POLYGON'
    ? 'POLYGON'
    : draft.coverageMode === 'RADIUS'
      ? 'RADIUS'
      : draft.mapCoverageMode;

  if (draft.coverageMode === 'POSTCODES') return { polygon: null, mapMode, valid: false, label: null };
  if (mapMode === 'RADIUS') {
    const center = validLatLng(draft.radiusLat, draft.radiusLng);
    const radiusKm = numberOrNull(draft.radiusKm);
    if (!center || radiusKm === null || radiusKm <= 0) return { polygon: null, mapMode, valid: false, label: null };
    return {
      polygon: { type: 'radius', center, radiusMeters: Math.round(radiusKm * 1000) },
      mapMode,
      valid: true,
      label: `Radius ${Number(radiusKm.toFixed(2))} km`,
    };
  }

  const points = validPolygonPoints(draft.polygonPoints);
  if (points.length < 3) return { polygon: null, mapMode, valid: false, label: null };
  return {
    polygon: {
      type: 'polygon',
      coordinates: points.map((point) => [point.lng, point.lat]),
    },
    mapMode,
    valid: true,
    label: `Polygon ${points.length} points`,
  };
}

function zoneGeometryInfo(zone) {
  return parseZoneGeometry(zone?.polygon).info;
}

// ───────────────────────────────────────────────────────────────────────────

export default function StoreSetupHub({ business, subscription, refreshTenant, onTabChange }) {
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [slotCounts, setSlotCounts] = useState({}); // locationId -> active recurring count
  const [banner, setBanner] = useState(null); // { tone, text }
  const [paymentReadiness, setPaymentReadiness] = useState(null);
  const [paymentReadinessLoading, setPaymentReadinessLoading] = useState(true);
  const [planCatalog, setPlanCatalog] = useState(null); // { tiers, region } from public pricing

  const mode = String(business?.multiStoreMode || 'OFF').toUpperCase();
  const deliveryMode = String(business?.deliveryMode || 'ASAP').toUpperCase();
  const pickupEnabled = !!business?.pickupEnabled;
  const isBranchMode = mode === 'CHAIN' || mode === 'REGIONAL' || mode === 'BOTH';
  // Plan gate: only ecom-business+ may sell from several branches. Single-store
  // plans (free/starter/professional) run one Shopify-style storefront.
  // branchesAllowed=null means unlimited.
  const multiBranchAllowed = business?.multiBranchAllowed === true;
  const currentPlanSlug = subscription?.tier?.slug || null;

  // Dynamic step numbering — the delivery sub-steps are conditional, so we count
  // visible steps instead of hard-coding 1-7 (which would leave gaps / put the
  // Scheduled-only "times" step two away from the method that triggers it).
  // Order keeps timing together: method (5) → times (6, Scheduled only) → areas (7).
  let _n = 0;
  const stepBasics = ++_n;
  const stepSell   = ++_n;
  const stepWhere  = ++_n;
  const stepPay    = ++_n;
  const stepGet    = ++_n;
  const stepTimes  = deliveryMode === 'SCHEDULED' ? ++_n : null;
  const stepAreas  = deliveryMode !== 'NONE' ? ++_n : null;

  async function loadLocations() {
    setLoading(true);
    try {
      const data = await api('/api/locations');
      const rows = data.locations || [];
      setLocations(rows);
      // Fetch active recurring slot counts per location (best-effort).
      const counts = {};
      await Promise.all(rows.map(async (loc) => {
        try {
          const r = await api(`/api/ecom/slots?locationId=${loc.id}&isActive=true&pageSize=100`);
          counts[loc.id] = (r.rows || []).filter((s) => !s.specificDate).length;
        } catch { counts[loc.id] = 0; }
      }));
      setSlotCounts(counts);
    } catch (err) {
      setBanner({ tone: 'error', text: err.message || 'Could not load locations' });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { loadLocations(); /* eslint-disable-next-line */ }, []);

  async function loadPaymentReadiness() {
    setPaymentReadinessLoading(true);
    try {
      const data = await api('/api/payments/accounts');
      setPaymentReadiness(data.readiness || null);
    } catch {
      setPaymentReadiness(null);
    } finally {
      setPaymentReadinessLoading(false);
    }
  }
  useEffect(() => { loadPaymentReadiness(); /* eslint-disable-next-line */ }, []);

  // Plan catalog for the "How do you sell?" cards — the four ecommerce tiers
  // and their prices in the tenant's billing region. Best-effort: if it fails
  // the step falls back to a simple single/branches control.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const country = business?.country ? `&country=${encodeURIComponent(business.country)}` : '';
        const data = await api(`/api/public/pricing?vertical=ECOMMERCE${country}`);
        if (cancelled) return;
        // The endpoint wraps the catalog as { pricing: { regions, tiers, ... }, source }.
        const pricing = data?.pricing || data;
        const region = Array.isArray(pricing?.regions) ? pricing.regions[0] : null;
        const tiers = (pricing?.tiers || [])
          .filter((t) => !t.isCustomPriced) // hide Contact-Sales/custom from the picker
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        setPlanCatalog({ tiers, region });
      } catch {
        if (!cancelled) setPlanCatalog(null);
      }
    })();
    return () => { cancelled = true; };
  }, [business?.country]);

  async function patchSettings(payload, okText) {
    setBanner(null);
    try {
      await api('/api/business/settings', { method: 'PATCH', body: JSON.stringify(payload) });
      await refreshTenant?.();
      if (payload.paymentMode !== undefined) loadPaymentReadiness();
      if (okText) setBanner({ tone: 'ok', text: okText });
    } catch (err) {
      setBanner({ tone: 'error', text: err.message || 'Could not save' });
    }
  }

  const activeLocations = locations.filter((l) => l.isActive !== false);
  const hasPrimary = activeLocations.some((l) => l.isPrimary);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Set up your store</h1>
        <p className="text-sm text-gray-500 mt-1">
          Everything to get selling — how you sell, where you sell from, and how customers get their orders — in one place.
        </p>
      </header>

      {banner && (
        <div className={`rounded-xl px-4 py-3 text-sm ${banner.tone === 'error'
          ? 'bg-red-50 border border-red-200 text-red-800'
          : 'bg-emerald-50 border border-emerald-200 text-emerald-800'}`}>
          {banner.text}
        </div>
      )}

      {/* STEP 1 — store basics (language + currency) */}
      <SetupCard step={stepBasics} title="Store basics" hint="The language and currency your store runs in.">
        <StoreBasics business={business} onError={(text) => setBanner({ tone: 'error', text })}
          onSaved={(text) => setBanner({ tone: 'ok', text })} refreshTenant={refreshTenant} />
      </SetupCard>

      {/* STEP 2 — how do you sell? (plan-tier cards; capability follows the plan) */}
      <SetupCard step={stepSell} title="How do you sell?"
        hint="Your plan decides what you can sell. The card you're on is your current plan — pick another to upgrade or downgrade in Billing.">
        <SellingPlanStep
          planCatalog={planCatalog}
          currentPlanSlug={currentPlanSlug}
          multiBranchAllowed={multiBranchAllowed}
          isBranchMode={isBranchMode}
          onUpgrade={() => onTabChange?.('subscription')}
          onSetBranchMode={(on) => {
            if (on && !isBranchMode) patchSettings({ multiStoreMode: 'CHAIN' }, 'Now selling from several branches');
            else if (!on && isBranchMode) patchSettings({ multiStoreMode: 'FULFILLMENT' }, 'Now a single store');
          }}
        />
      </SetupCard>

      {/* STEP 3 — where you sell from */}
      <SetupCard
        step={stepWhere}
        title={isBranchMode ? 'Your branches' : mode === 'FULFILLMENT' ? 'Your store & fulfilment location' : 'Your store address'}
        hint={isBranchMode
          ? 'Add each branch customers can choose from. Each branch keeps its own stock, prices, and delivery times.'
          : mode === 'FULFILLMENT'
            ? 'Customers see one storefront. Orders are fulfilled from the location marked Main — add others only if you plan to switch your Main location later.'
            : 'Where you sell from. Used on your storefront and for pickup.'}
      >
        <LocationsSection
          loading={loading}
          locations={locations}
          slotCounts={slotCounts}
          branchMode={isBranchMode}
          fulfillmentMode={mode === 'FULFILLMENT'}
          onChanged={loadLocations}
          onError={(text) => setBanner({ tone: 'error', text })}
        />
        {isBranchMode && activeLocations.length < 2 && !loading && (
          <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Branch stores work best with at least two locations — add one more so customers have a choice.
          </p>
        )}
      </SetupCard>

      {/* STEP 4 — how customers pay */}
      <SetupCard step={stepPay} title="How do customers pay?">
        <PaymentReadinessNotice
          readiness={paymentReadiness}
          loading={paymentReadinessLoading}
          currentMode={business?.paymentMode || 'BOTH'}
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {PAYMENT_MODES.map((p) => {
            const active = String(business?.paymentMode || 'BOTH').toUpperCase() === p.key;
            const requiresOnline = p.key !== 'COD_ONLY';
            const onlineLocked = requiresOnline && !paymentReadiness?.canAcceptOnline;
            return (
              <button
                key={p.key}
                type="button"
                disabled={onlineLocked}
                onClick={() => {
                  if (onlineLocked) {
                    setBanner({ tone: 'error', text: `${paymentReadiness?.providerLabel || 'Payment gateway'} is not ready yet. Connect it in Payments before turning on online checkout.` });
                    return;
                  }
                  patchSettings({ paymentMode: p.key }, 'Saved payment methods');
                }}
                className={`text-left rounded-2xl border p-4 transition-colors ${active
                  ? onlineLocked
                    ? 'border-amber-400 bg-amber-50 ring-1 ring-amber-400'
                    : 'border-emerald-600 bg-emerald-50 ring-1 ring-emerald-600'
                  : onlineLocked
                    ? 'border-gray-200 bg-gray-50 opacity-70 cursor-not-allowed'
                    : 'border-gray-200 bg-white hover:border-emerald-400'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-gray-900">{p.title}</div>
                  {onlineLocked && <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-mono font-semibold text-amber-700">Gateway first</span>}
                </div>
                <div className="mt-1 text-xs text-gray-500">{p.blurb}</div>
              </button>
            );
          })}
        </div>
      </SetupCard>

      {/* STEP 5 — how customers get orders */}
      <SetupCard step={stepGet} title="How do customers get their order?">
        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              {isBranchMode ? 'Home delivery (all branches)' : 'Home delivery'}
            </p>
            {isBranchMode && (
              <p className="text-xs text-gray-500 -mt-1 mb-2">This delivery method applies to every branch for now. Each branch can still have its own delivery times below.</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {DELIVERY_MODES.map((d) => {
                const active = deliveryMode === d.key;
                return (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => patchSettings({ deliveryMode: d.key }, 'Saved delivery method')}
                    className={`text-left rounded-2xl border p-4 transition-colors ${active
                      ? 'border-emerald-600 bg-emerald-50 ring-1 ring-emerald-600'
                      : 'border-gray-200 bg-white hover:border-emerald-400'}`}
                  >
                    <div className="text-sm font-semibold text-gray-900">{d.title}</div>
                    <div className="mt-1 text-xs text-gray-500">{d.blurb}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={pickupEnabled}
              onChange={(e) => patchSettings({ pickupEnabled: e.target.checked }, 'Saved pickup option')}
            />
            <div>
              <p className="text-sm font-medium text-gray-900">Pickup / Click &amp; Collect</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Let customers collect in person.{' '}
                <button type="button" onClick={() => onTabChange?.('pickup-locations')}
                  className="font-semibold text-emerald-700 underline">Manage pickup counters</button>
              </p>
            </div>
          </label>
        </div>
      </SetupCard>

      {/* STEP — delivery TIMES come right after the method that triggers them
          (Scheduled), so timing stays together. Areas (where/how much) follow. */}
      {deliveryMode === 'SCHEDULED' && (
        <SetupCard step={stepTimes} title="Delivery times" hint="Pick the days and times you deliver — we'll build the windows for you.">
          {isBranchMode && (
            <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-3">Delivery times are set per branch — pick a branch below, then set its days and windows.</p>
          )}
          <DeliveryPatternBuilder
            locations={activeLocations}
            branchMode={isBranchMode}
            onDone={(text) => { setBanner({ tone: 'ok', text }); loadLocations(); }}
            onError={(text) => setBanner({ tone: 'error', text })}
            onAdvanced={() => onTabChange?.('slots')}
          />
          <div className="mt-5 pt-5 border-t border-gray-100">
            <HolidaysSection branchMode={isBranchMode} locations={activeLocations} onError={(text) => setBanner({ tone: 'error', text })} />
          </div>
        </SetupCard>
      )}

      {/* STEP — delivery charges & areas. Single stores get a flat-rate baseline
          (deliver anywhere) plus optional specific areas that restrict/override.
          Branch stores configure each branch's areas; customers map to a branch. */}
      {deliveryMode !== 'NONE' && (
        <SetupCard step={stepAreas} title="Delivery charges & areas"
          hint={isBranchMode
            ? 'Set each branch’s delivery areas and fees. Customers are matched to the branch that covers their pincode or location.'
            : 'Charge a flat rate everywhere, or restrict to specific pincodes / map areas with their own fees.'}>
          {!isBranchMode && (
            <FlatDeliveryEditor
              business={business}
              deliveryMode={deliveryMode}
              onSave={(payload, ok) => patchSettings(payload, ok)}
            />
          )}
          <DeliveryAreasSection
            business={business}
            locations={activeLocations}
            onSaved={(text) => setBanner({ tone: 'ok', text })}
            onError={(text) => setBanner({ tone: 'error', text })}
          />
        </SetupCard>
      )}

      {/* Footer — readiness + advanced */}
      <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-600">
          {loading ? 'Checking your setup…'
            : activeLocations.length === 0 ? 'Add your first location to get started.'
            : !hasPrimary ? 'Mark one location as your main store.'
            : 'Looking good — your store is ready to take orders.'}
        </div>
        <div className="flex gap-2 text-xs">
          <span className="text-gray-400">Advanced:</span>
          {[
            ['locations', 'locations'],
            ['slots', 'slots'],
            ['pickup-locations', 'pickup counters'],
            ['cities', 'delivery areas'],
          ].map(([t, label]) => (
            <button key={t} type="button" onClick={() => onTabChange?.(t)}
              className="font-semibold text-emerald-700 hover:underline capitalize">
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SetupCard({ step, title, hint, children }) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-3 mb-4">
        <span className="w-7 h-7 rounded-full bg-emerald-600 text-white text-sm font-bold flex items-center justify-center">{step}</span>
        <div>
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          {hint && <p className="text-xs text-gray-500">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

// ─── Step 2: "How do you sell?" as plan-tier cards ─────────────────────────
// The four ecommerce plans; the card you're on is your current plan. Selling
// capability (single store → several branches) follows the plan, so picking a
// different card opens Billing to upgrade/downgrade. A branch-capable plan also
// gets a single-store / several-branches operational toggle.
function SellingPlanStep({ planCatalog, currentPlanSlug, multiBranchAllowed, isBranchMode, onUpgrade, onSetBranchMode }) {
  const tiers = planCatalog?.tiers || [];
  const region = planCatalog?.region || null;
  const symbol = region?.symbol || '';
  const priceFor = (slug) => {
    const p = region?.plans?.[slug];
    return p && typeof p.monthly === 'number' ? p.monthly : null;
  };
  const branchCapable = (t) => t.includedBranches != null && Number(t.includedBranches) > 1;
  const currentIdx = tiers.findIndex((t) => t.slug === currentPlanSlug);

  const branchControl = multiBranchAllowed ? (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-sm font-semibold text-gray-900">Run your store as</p>
        <p className="text-xs text-gray-500">Your plan supports several branches — switch any time.</p>
      </div>
      <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
        <button type="button" onClick={() => onSetBranchMode(false)}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${!isBranchMode ? 'bg-emerald-600 text-white' : 'text-gray-600 hover:text-gray-900'}`}>Single store</button>
        <button type="button" onClick={() => onSetBranchMode(true)}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${isBranchMode ? 'bg-emerald-600 text-white' : 'text-gray-600 hover:text-gray-900'}`}>Several branches</button>
      </div>
    </div>
  ) : (
    <p className="text-xs text-gray-500">
      Your current plan runs a single storefront. Pick a higher plan above to sell from several branches — each with its own stock, prices, and delivery.
    </p>
  );

  if (tiers.length === 0) {
    // Catalog unavailable (offline / fetch failed) — still expose the control.
    return <div className="space-y-3">{branchControl}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tiers.map((t, idx) => {
          const isCurrent = t.slug === currentPlanSlug;
          const price = priceFor(t.slug);
          const capable = branchCapable(t);
          const dir = currentIdx < 0 ? 'Switch' : idx > currentIdx ? 'Upgrade' : idx < currentIdx ? 'Downgrade' : 'Current';
          return (
            <button key={t.slug} type="button"
              onClick={() => { if (!isCurrent) onUpgrade(); }}
              disabled={isCurrent}
              className={`relative text-left rounded-2xl border p-3 transition-colors ${isCurrent
                ? 'border-emerald-600 bg-emerald-50 ring-1 ring-emerald-600 cursor-default'
                : 'border-gray-200 bg-white hover:border-emerald-400'}`}>
              {isCurrent && (
                <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold text-white">✓ Your plan</span>
              )}
              <div className="text-sm font-semibold text-gray-900 pr-16">{t.name}</div>
              {price != null && (
                <div className="mt-0.5 text-xs text-gray-500">{symbol}{price}<span className="text-gray-400">/mo</span></div>
              )}
              <div className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${capable ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}>
                {capable ? `Several branches${t.includedBranches ? ` · up to ${t.includedBranches}` : ''}` : 'Single store'}
              </div>
              {!isCurrent && (
                <div className="mt-2 text-[11px] font-semibold text-emerald-700">{dir} →</div>
              )}
            </button>
          );
        })}
      </div>
      {branchControl}
    </div>
  );
}

// ─── Flat delivery rate (deliver-anywhere baseline for single stores) ───────
function FlatDeliveryEditor({ business, deliveryMode, onSave }) {
  const currency = getDefaultCurrency({ business });
  const [fee, setFee] = useState(majorFromMinor(business?.flatDeliveryFeeMinor));
  const [freeOver, setFreeOver] = useState(majorFromMinor(business?.flatFreeDeliveryThresholdMinor));
  const [eta, setEta] = useState(business?.deliveryEtaMinutes != null ? String(business.deliveryEtaMinutes) : '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFee(majorFromMinor(business?.flatDeliveryFeeMinor));
    setFreeOver(majorFromMinor(business?.flatFreeDeliveryThresholdMinor));
    setEta(business?.deliveryEtaMinutes != null ? String(business.deliveryEtaMinutes) : '');
  }, [business?.flatDeliveryFeeMinor, business?.flatFreeDeliveryThresholdMinor, business?.deliveryEtaMinutes]);

  const savedEta = business?.deliveryEtaMinutes != null ? String(business.deliveryEtaMinutes) : '';
  const dirty = majorFromMinor(business?.flatDeliveryFeeMinor) !== fee
    || majorFromMinor(business?.flatFreeDeliveryThresholdMinor) !== freeOver
    || savedEta !== eta;

  async function save() {
    const feeMinor = minorFromMajor(fee, 0);
    const freeMinor = minorFromMajor(freeOver, 0);
    if (feeMinor === null || freeMinor === null) return;
    setSaving(true);
    try {
      await onSave({
        flatDeliveryFeeMinor: feeMinor,
        flatFreeDeliveryThresholdMinor: freeMinor,
        deliveryEtaMinutes: eta === '' ? null : Number(eta),
      }, 'Saved delivery charges');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 mb-4">
      <p className="text-sm font-semibold text-gray-900">Flat delivery rate</p>
      <p className="text-xs text-gray-500 mt-0.5 mb-3">Charged on every delivery order, everywhere — unless a specific area below sets its own fee. Set 0 for free delivery, or free over a threshold.</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <MoneyInput label={`Delivery fee (${currency})`} value={fee} onChange={setFee} />
        <MoneyInput label={`Free delivery above (${currency})`} value={freeOver} onChange={setFreeOver} placeholder="optional" />
        {deliveryMode === 'ASAP' && (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Delivery ETA (minutes)</label>
            <input type="number" min="0" step="1" value={eta} onChange={(e) => setEta(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="45" />
          </div>
        )}
      </div>
      {dirty && (
        <div className="mt-3 flex justify-end">
          <button type="button" onClick={save} disabled={saving}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save delivery charges'}
          </button>
        </div>
      )}
    </div>
  );
}

function PaymentReadinessNotice({ readiness, loading, currentMode }) {
  if (loading) {
    return (
      <div className="mb-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
        Checking payment gateway readiness…
      </div>
    );
  }
  const onlineReady = !!readiness?.canAcceptOnline;
  const mode = String(currentMode || 'BOTH').toUpperCase();
  if (onlineReady) {
    return (
      <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
        <strong>{readiness.providerLabel} is ready.</strong> You can safely allow online checkout.
      </div>
    );
  }
  return (
    <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p>
            <strong>Online checkout is locked.</strong> {readiness?.message || 'Connect the required payment gateway first.'}
          </p>
          {mode !== 'COD_ONLY' && (
            <p className="mt-1">Your storefront will behave as cash-only until payment onboarding is complete.</p>
          )}
        </div>
        <a
          href="/dashboard?tab=payments"
          className="inline-flex shrink-0 items-center justify-center rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-950"
        >
          Open Payments
        </a>
      </div>
    </div>
  );
}

// ─── Locations section ─────────────────────────────────────────────────────
function emptyLoc() {
  return { name: '', addressLine1: '', city: '', state: '', postalCode: '', country: '', phone: '' };
}

function LocationsSection({ loading, locations, slotCounts, branchMode, fulfillmentMode, onChanged, onError }) {
  const [draft, setDraft] = useState(null); // {id?, ...fields}
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!draft.name.trim()) { onError('Give this location a name'); return; }
    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(),
        addressLine1: draft.addressLine1?.trim() || undefined,
        city: draft.city?.trim() || undefined,
        state: draft.state?.trim() || undefined,
        postalCode: draft.postalCode?.trim() || undefined,
        country: draft.country?.trim() || undefined,
        phone: draft.phone?.trim() || undefined,
      };
      if (draft.id) {
        await api(`/api/locations/${draft.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/locations', { method: 'POST', body: JSON.stringify(payload) });
      }
      setDraft(null);
      await onChanged();
    } catch (err) {
      onError(err.message || 'Could not save location');
    } finally {
      setSaving(false);
    }
  }

  async function makePrimary(loc) {
    try {
      await api(`/api/locations/${loc.id}`, { method: 'PUT', body: JSON.stringify({ isPrimary: true }) });
      await onChanged();
    } catch (err) { onError(err.message); }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-3">
      {locations.length > 0 && (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
          {locations.map((loc) => {
            const addr = [loc.addressLine1, loc.city, loc.postalCode].filter(Boolean).join(', ');
            const slots = slotCounts[loc.id];
            return (
              <li key={loc.id} className={`flex items-center gap-3 p-3 ${loc.isActive === false ? 'opacity-60' : ''}`}>
                <span className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center">📍</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900 truncate">{loc.name}</p>
                    {loc.isPrimary && <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">Main</span>}
                    {fulfillmentMode && !loc.isPrimary && loc.isActive !== false && (
                      <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full" title="In this mode the storefront only uses your Main location">Not shown to customers</span>
                    )}
                  </div>
                  {addr && <p className="text-xs text-gray-500 truncate">{addr}</p>}
                  {typeof slots === 'number' && (
                    <p className="text-[11px] text-gray-400">{slots > 0 ? `${slots} delivery window${slots === 1 ? '' : 's'}` : 'no delivery windows yet'}</p>
                  )}
                </div>
                <div className="flex gap-1">
                  {!loc.isPrimary && loc.isActive !== false && (
                    <button type="button" onClick={() => makePrimary(loc)}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-300 hover:bg-gray-50">Make main</button>
                  )}
                  <button type="button" onClick={() => setDraft({ id: loc.id, ...emptyLoc(), ...loc })}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-300 hover:bg-gray-50">Edit</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {draft ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Name *" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })}
              placeholder={branchMode ? 'e.g. Indiranagar Branch' : 'e.g. Main Store'} full />
            <Input label="Address" value={draft.addressLine1} onChange={(v) => setDraft({ ...draft, addressLine1: v })} full />
            <Input label="City" value={draft.city} onChange={(v) => setDraft({ ...draft, city: v })} />
            <Input label="State / region" value={draft.state} onChange={(v) => setDraft({ ...draft, state: v })} />
            <Input label="Postal / ZIP" value={draft.postalCode} onChange={(v) => setDraft({ ...draft, postalCode: v })} />
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Country</label>
              <select value={draft.country || ''} onChange={(e) => setDraft({ ...draft, country: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
                <option value="">—</option>
                {(COUNTRIES || []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </div>
            <Input label="Phone" value={draft.phone} onChange={(v) => setDraft({ ...draft, phone: v })} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setDraft(null)}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={save} disabled={saving}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
              {saving ? 'Saving…' : draft.id ? 'Save' : 'Add location'}
            </button>
          </div>
        </div>
      ) : locations.length >= MAX_LOCATIONS ? (
        <p className="text-center text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-xl py-3">
          You&apos;ve reached the limit of {MAX_LOCATIONS} locations. Delete one to add another.
        </p>
      ) : (
        <button type="button" onClick={() => setDraft(emptyLoc())}
          className="w-full rounded-xl border border-dashed border-gray-300 py-3 text-sm font-medium text-gray-600 hover:border-emerald-400 hover:text-emerald-700">
          + Add {locations.length === 0 ? 'your first location' : branchMode ? 'another branch' : 'another location'}
        </button>
      )}
    </div>
  );
}

// ─── Delivery areas section ────────────────────────────────────────────────
function emptyAreaDraft(location) {
  return {
    id: null,
    cityId: '',
    slug: '',
    locationId: location?.id || '',
    name: location?.city ? `${location.city} delivery` : `${location?.name || 'Main store'} delivery area`,
    coverageMode: 'POSTCODES',
    mapCoverageMode: 'RADIUS',
    postcodes: '',
    radiusLat: '',
    radiusLng: '',
    radiusKm: '3',
    polygonPoints: emptyPolygonPoints(),
    deliveryFeeMajor: '0',
    freeDeliveryMajor: '',
    promiseMinutes: '45',
    isActive: true,
  };
}

function DeliveryAreasSection({ business, locations = [], onSaved, onError }) {
  const [cities, setCities] = useState([]);
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [areaError, setAreaError] = useState('');
  const [testCode, setTestCode] = useState('');
  const [testLat, setTestLat] = useState('');
  const [testLng, setTestLng] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  const currency = getDefaultCurrency({ business });
  const primaryLocation = locations.find((l) => l.isPrimary) || locations[0] || null;

  async function loadAreas() {
    setLoading(true);
    try {
      const [cityData, zoneData] = await Promise.all([
        api('/api/ecom/cities'),
        api('/api/ecom/zones'),
      ]);
      setCities(cityData.rows || []);
      setZones(zoneData.rows || []);
    } catch (err) {
      onError?.(err.message || 'Could not load delivery areas');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAreas(); /* eslint-disable-next-line */ }, []);

  const cityById = useMemo(() => new Map(cities.map((c) => [c.id, c])), [cities]);
  const locationById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);
  const activeZones = zones.filter((z) => z.isActive !== false);
  const totalPostcodes = zones.reduce((sum, z) => sum + splitPostcodes(z.postcodes).length, 0);
  const totalMapZones = zones.filter((z) => zoneGeometryInfo(z)).length;
  const coveredLocationIds = new Set(activeZones.map((z) => z.primaryLocationId).filter(Boolean));
  const uncoveredLocations = locations.filter((l) => !coveredLocationIds.has(l.id));

  function openCreate(location = primaryLocation) {
    setAreaError('');
    setDraft(emptyAreaDraft(location));
  }

  function openEdit(zone) {
    setAreaError('');
    const geometry = parseZoneGeometry(zone.polygon);
    const hasCodes = splitPostcodes(zone.postcodes).length > 0;
    const hasGeometry = !!geometry.info;
    setDraft({
      id: zone.id,
      cityId: zone.cityId || '',
      slug: zone.slug || '',
      locationId: zone.primaryLocationId || '',
      name: zone.name || '',
      coverageMode: hasCodes && hasGeometry ? 'MIXED' : hasGeometry ? geometry.mapMode : 'POSTCODES',
      mapCoverageMode: geometry.mapMode || 'RADIUS',
      postcodes: splitPostcodes(zone.postcodes).join(', '),
      radiusLat: geometry.radiusLat,
      radiusLng: geometry.radiusLng,
      radiusKm: geometry.radiusKm,
      polygonPoints: geometry.polygonPoints,
      deliveryFeeMajor: majorFromMinor(zone.deliveryFeeMinor),
      freeDeliveryMajor: majorFromMinor(zone.freeDeliveryThresholdMinor),
      promiseMinutes: zone.promiseMinutes ? String(zone.promiseMinutes) : '',
      isActive: zone.isActive !== false,
    });
  }

  async function ensureCity(location) {
    if (draft.cityId) return draft.cityId;

    const rawName = location?.city || business?.city || location?.name || 'Main service area';
    const citySlug = slugify(rawName, 60) || 'main-service-area';
    const existing = cities.find((c) => c.slug === citySlug || String(c.name || '').toLowerCase() === String(rawName).toLowerCase());
    if (existing) return existing.id;

    const payload = {
      name: rawName,
      slug: citySlug,
      countryCode: String(location?.country || business?.country || 'US').slice(0, 2).toUpperCase(),
      status: 'LIVE',
      currency,
    };
    if (location?.state || business?.state) payload.region = location?.state || business?.state;
    if (business?.timezone) payload.timezone = business.timezone;

    const created = await api('/api/ecom/cities', { method: 'POST', body: JSON.stringify(payload) });
    setCities((rows) => [...rows, created]);
    return created.id;
  }

  function uniqueZoneSlug(name, cityId, currentId) {
    const base = slugify(name, 70) || 'delivery-area';
    const used = new Set(
      zones
        .filter((z) => z.cityId === cityId && z.id !== currentId)
        .map((z) => z.slug),
    );
    let candidate = base;
    let i = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${i}`;
      i += 1;
    }
    return candidate;
  }

  async function saveArea() {
    if (!draft) return;
    const location = locationById.get(draft.locationId);
    if (!location) { setAreaError('Pick the branch that will deliver to this area.'); return; }
    const postcodes = splitPostcodes(draft.postcodes);
    const showPostcodes = draft.coverageMode === 'POSTCODES' || draft.coverageMode === 'MIXED';
    const geometry = buildAreaGeometry(draft);
    const hasPostcodes = showPostcodes && postcodes.length > 0;
    const hasMapArea = draft.coverageMode !== 'POSTCODES' && geometry.valid;
    if (draft.coverageMode === 'MIXED' && (!hasPostcodes || !hasMapArea)) {
      setAreaError('For Pincode + map, add at least one pincode and a valid radius or polygon.');
      return;
    }
    if (!hasPostcodes && !hasMapArea) {
      setAreaError('Add at least one pincode, or enter a valid radius/polygon area.');
      return;
    }
    if (!draft.name.trim()) { setAreaError('Give this delivery area a name.'); return; }

    const fee = minorFromMajor(draft.deliveryFeeMajor, 0);
    const freeAbove = minorFromMajor(draft.freeDeliveryMajor, 0);
    if (fee === null || freeAbove === null) {
      setAreaError('Delivery fee and free-delivery amount must be valid numbers.');
      return;
    }
    const promiseMinutes = draft.promiseMinutes === '' ? null : Number(draft.promiseMinutes);
    if (promiseMinutes !== null && (!Number.isInteger(promiseMinutes) || promiseMinutes < 0)) {
      setAreaError('Estimated delivery time must be a whole number of minutes.');
      return;
    }

    setSaving(true);
    setAreaError('');
    try {
      const cityId = await ensureCity(location);
      const payload = {
        cityId,
        name: draft.name.trim(),
        slug: draft.slug || uniqueZoneSlug(draft.name, cityId, draft.id),
        primaryLocationId: location.id,
        postcodes: hasPostcodes ? postcodes : [],
        polygon: geometry.polygon,
        deliveryFeeMinor: fee,
        freeDeliveryThresholdMinor: freeAbove,
        promiseMinutes,
        isActive: !!draft.isActive,
      };
      if (draft.id) {
        await api(`/api/ecom/zones/${draft.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/ecom/zones', { method: 'POST', body: JSON.stringify(payload) });
      }
      setDraft(null);
      await loadAreas();
      onSaved?.(draft.id ? 'Saved delivery area' : 'Added delivery area');
    } catch (err) {
      setAreaError(err.message || 'Could not save delivery area');
    } finally {
      setSaving(false);
    }
  }

  async function removeArea(zone) {
    if (typeof window !== 'undefined' && !window.confirm(`Delete "${zone.name}"? Customers in this area will no longer be serviceable unless another area covers them.`)) return;
    try {
      await api(`/api/ecom/zones/${zone.id}`, { method: 'DELETE' });
      await loadAreas();
      onSaved?.('Deleted delivery area');
    } catch (err) {
      onError?.(err.message || 'Could not delete delivery area');
    }
  }

  async function testDeliveryArea(e) {
    e?.preventDefault();
    const testPoint = validLatLng(testLat, testLng);
    if (!testCode.trim() && !testPoint) return;
    setTesting(true);
    setTestResult(null);
    try {
      const qs = testPoint
        ? new URLSearchParams({ lat: String(testPoint.lat), lng: String(testPoint.lng) })
        : new URLSearchParams({ postalCode: testCode.trim() });
      const data = await api(`/api/ecom/delivery-areas/resolve?${qs.toString()}`);
      setTestResult(data);
    } catch (err) {
      setTestResult({ error: err.message || 'Could not test this area' });
    } finally {
      setTesting(false);
    }
  }

  const draftCodes = draft ? new Set(splitPostcodes(draft.postcodes).map(postcodeKey)) : new Set();
  const overlaps = draftCodes.size === 0 ? [] : zones.flatMap((zone) => {
    if (zone.id === draft.id) return [];
    return splitPostcodes(zone.postcodes)
      .filter((code) => draftCodes.has(postcodeKey(code)))
      .map((code) => ({ code, zone }));
  });
  const testResultLabel = testResult?.postalCode
    || (testResult?.point ? `${Number(testResult.point.lat).toFixed(5)}, ${Number(testResult.point.lng).toFixed(5)}` : 'This area');
  const draftGeometry = draft ? buildAreaGeometry(draft) : null;
  const showPostcodeEditor = draft?.coverageMode === 'POSTCODES' || draft?.coverageMode === 'MIXED';
  const showRadiusEditor = draft?.coverageMode === 'RADIUS' || (draft?.coverageMode === 'MIXED' && draft?.mapCoverageMode === 'RADIUS');
  const showPolygonEditor = draft?.coverageMode === 'POLYGON' || (draft?.coverageMode === 'MIXED' && draft?.mapCoverageMode === 'POLYGON');

  if (locations.length === 0) {
    return <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Add a branch above first. Delivery areas belong to a branch.</p>;
  }

  if (loading) return <p className="text-sm text-gray-500">Loading delivery areas…</p>;

  return (
    <div className="space-y-4">
      <form onSubmit={testDeliveryArea} className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-3">
        <label className="block text-xs font-semibold text-emerald-900 mb-2">Test customer serviceability</label>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_0.8fr_0.8fr_auto] gap-2">
          <input
            type="text"
            value={testCode}
            onChange={(e) => setTestCode(e.target.value)}
            placeholder="Pincode / postcode"
            className="flex-1 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
          />
          <input
            type="number"
            step="any"
            value={testLat}
            onChange={(e) => setTestLat(e.target.value)}
            placeholder="Latitude"
            className="rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
          />
          <input
            type="number"
            step="any"
            value={testLng}
            onChange={(e) => setTestLng(e.target.value)}
            placeholder="Longitude"
            className="rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
          />
          <button type="submit" disabled={testing || (!testCode.trim() && !validLatLng(testLat, testLng))}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
            {testing ? 'Checking…' : 'Check'}
          </button>
        </div>
        {testResult?.error && <p className="mt-2 text-xs text-red-700">{testResult.error}</p>}
        {testResult && !testResult.error && (
          <div className={`mt-3 rounded-lg px-3 py-2 text-xs ${testResult.serviceable ? 'bg-white border border-emerald-200 text-emerald-900' : 'bg-amber-50 border border-amber-200 text-amber-800'}`}>
            {testResult.serviceable ? (
              <div className="space-y-1">
                <p className="font-semibold">{testResultLabel} is serviceable</p>
                {(testResult.candidates || []).slice(0, 3).map((item) => (
                  <p key={item.location.id}>
                    {item.location.name}
                    {item.zone?.name ? ` · ${item.zone.name}` : ''}
                    {item.zone?.deliveryFeeMinor ? ` · fee ${formatCurrencyMinor(item.zone.deliveryFeeMinor, currency)}` : ' · no delivery fee'}
                    {item.zone?.promiseMinutes ? ` · ${etaLabel(item.zone.promiseMinutes)}` : ''}
                  </p>
                ))}
              </div>
            ) : (
              <p><strong>{testResultLabel}</strong> is not covered by any active delivery area.</p>
            )}
          </div>
        )}
      </form>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
        <MiniStat label="Delivery areas" value={zones.length} />
        <MiniStat label="Pincodes covered" value={totalPostcodes} />
        <MiniStat label="Map areas" value={totalMapZones} tone={totalMapZones ? 'ok' : undefined} />
        <MiniStat label="Branches without area" value={uncoveredLocations.length} tone={uncoveredLocations.length ? 'warn' : 'ok'} />
      </div>

      {uncoveredLocations.length > 0 && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {uncoveredLocations.map((l) => l.name).join(', ')} {uncoveredLocations.length === 1 ? 'has' : 'have'} no delivery area yet.
        </p>
      )}

      {zones.length > 0 ? (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
          {zones.map((zone) => {
            const loc = locationById.get(zone.primaryLocationId);
            const city = cityById.get(zone.cityId);
            const codes = splitPostcodes(zone.postcodes);
            const geometryInfo = zoneGeometryInfo(zone);
            return (
              <li key={zone.id} className={`p-3 ${zone.isActive === false ? 'bg-gray-50 opacity-70' : 'bg-white'}`}>
                <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900">{zone.name}</p>
                      <span className="text-[10px] rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5">{loc?.name || 'City pool'}</span>
                      {geometryInfo && <span className="text-[10px] rounded-full bg-blue-100 text-blue-800 px-2 py-0.5">{geometryInfo}</span>}
                      {zone.isActive === false && <span className="text-[10px] rounded-full bg-gray-200 text-gray-600 px-2 py-0.5">Paused</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {[city?.name, loc?.city].filter(Boolean).slice(0, 1).join('') || 'Service area'}
                      {' · '}
                      Fee {formatCurrencyMinor(zone.deliveryFeeMinor || 0, currency)}
                      {zone.freeDeliveryThresholdMinor > 0 ? ` · free over ${formatCurrencyMinor(zone.freeDeliveryThresholdMinor, currency)}` : ''}
                      {zone.promiseMinutes ? ` · ${etaLabel(zone.promiseMinutes)}` : ''}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {codes.slice(0, 8).map((code) => (
                        <span key={code} className="text-[11px] rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-gray-700">{code}</span>
                      ))}
                      {codes.length > 8 && <span className="text-[11px] text-gray-400 px-1 py-0.5">+{codes.length - 8} more</span>}
                      {codes.length === 0 && geometryInfo && (
                        <span className="text-[11px] rounded-md border border-blue-100 bg-blue-50 px-2 py-0.5 text-blue-700">GPS-only coverage</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 sm:justify-end">
                    <button type="button" onClick={() => openEdit(zone)}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-300 hover:bg-gray-50">Edit</button>
                    <button type="button" onClick={() => removeArea(zone)}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-red-200 text-red-700 hover:bg-red-50">Delete</button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-5 text-center">
          <p className="text-sm font-semibold text-gray-900">No delivery areas yet</p>
          <p className="mt-1 text-xs text-gray-500">Add the pincodes, radius, or boundary your first branch delivers to. Checkout will use this to pick the right branch.</p>
        </div>
      )}

      {draft ? (
        <div className="rounded-xl border border-emerald-200 bg-white p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Delivery branch *</label>
              <select value={draft.locationId} onChange={(e) => setDraft({ ...draft, locationId: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
                <option value="">Pick branch</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>{loc.name}{loc.isPrimary ? ' (main)' : ''}</option>
                ))}
              </select>
            </div>
            <Input label="Area name *" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-2">Coverage method</label>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                {COVERAGE_MODES.map((mode) => {
                  const selected = draft.coverageMode === mode.key;
                  return (
                    <button
                      key={mode.key}
                      type="button"
                      onClick={() => setDraft({ ...draft, coverageMode: mode.key })}
                      className={`text-left rounded-lg border px-3 py-2 transition-colors ${selected ? 'border-emerald-600 bg-emerald-50 text-emerald-900' : 'border-gray-200 bg-white text-gray-700 hover:border-emerald-300'}`}
                    >
                      <span className="block text-sm font-semibold">{mode.title}</span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-gray-500">{mode.blurb}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {draft.coverageMode === 'MIXED' && (
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-2">Map coverage type</label>
                <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
                  {['RADIUS', 'POLYGON'].map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setDraft({ ...draft, mapCoverageMode: mode })}
                      className={`px-3 py-1.5 rounded-md text-xs font-semibold ${draft.mapCoverageMode === mode ? 'bg-white text-emerald-700 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
                    >
                      {mode === 'RADIUS' ? 'Radius' : 'Polygon'}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {showPostcodeEditor && (
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Pincodes / postal codes</label>
                <textarea
                  value={draft.postcodes}
                  onChange={(e) => setDraft({ ...draft, postcodes: e.target.value })}
                  placeholder="110001, 110002, 110003"
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
                />
                <p className="mt-1 text-[11px] text-gray-400">Separate with commas or one per line. UK-style postcodes can keep their internal space.</p>
              </div>
            )}
            {showRadiusEditor && (
              <div className="sm:col-span-2 rounded-xl border border-blue-100 bg-blue-50/40 p-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Input label="Center latitude" value={draft.radiusLat} onChange={(v) => setDraft({ ...draft, radiusLat: v })} placeholder="28.6139" />
                  <Input label="Center longitude" value={draft.radiusLng} onChange={(v) => setDraft({ ...draft, radiusLng: v })} placeholder="77.2090" />
                  <Input label="Radius (km)" value={draft.radiusKm} onChange={(v) => setDraft({ ...draft, radiusKm: v })} placeholder="3" />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[1, 2, 3, 5, 10].map((km) => (
                    <button
                      key={km}
                      type="button"
                      onClick={() => setDraft({ ...draft, radiusKm: String(km) })}
                      className="rounded-md border border-blue-200 bg-white px-2 py-1 text-[11px] font-semibold text-blue-700 hover:border-blue-400"
                    >
                      {km} km
                    </button>
                  ))}
                </div>
                <CoordinatePreview mode="RADIUS" radiusKm={draft.radiusKm} valid={draftGeometry?.valid} />
              </div>
            )}
            {showPolygonEditor && (
              <div className="sm:col-span-2 rounded-xl border border-blue-100 bg-blue-50/40 p-3">
                <div className="space-y-2">
                  {(draft.polygonPoints || []).map((point, index) => (
                    <div key={index} className="grid grid-cols-[auto_1fr_1fr_auto] gap-2 items-end">
                      <span className="pb-2 text-xs font-semibold text-gray-500">{index + 1}</span>
                      <Input label="Latitude" value={point.lat} onChange={(v) => {
                        const next = [...draft.polygonPoints];
                        next[index] = { ...next[index], lat: v };
                        setDraft({ ...draft, polygonPoints: next });
                      }} placeholder="28.6139" />
                      <Input label="Longitude" value={point.lng} onChange={(v) => {
                        const next = [...draft.polygonPoints];
                        next[index] = { ...next[index], lng: v };
                        setDraft({ ...draft, polygonPoints: next });
                      }} placeholder="77.2090" />
                      <button
                        type="button"
                        onClick={() => {
                          const next = draft.polygonPoints.filter((_, i) => i !== index);
                          setDraft({ ...draft, polygonPoints: next.length ? next : emptyPolygonPoints() });
                        }}
                        className="mb-0.5 rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs font-semibold text-gray-500 hover:border-red-200 hover:text-red-700"
                        aria-label={`Remove point ${index + 1}`}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, polygonPoints: [...(draft.polygonPoints || []), { lat: '', lng: '' }] })}
                  className="mt-3 rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-semibold text-blue-700 hover:border-blue-400"
                >
                  + Add polygon point
                </button>
                <CoordinatePreview mode="POLYGON" points={draft.polygonPoints} valid={draftGeometry?.valid} />
              </div>
            )}
            <MoneyInput label={`Delivery fee (${currency})`} value={draft.deliveryFeeMajor} onChange={(v) => setDraft({ ...draft, deliveryFeeMajor: v })} />
            <MoneyInput label={`Free delivery above (${currency})`} value={draft.freeDeliveryMajor} onChange={(v) => setDraft({ ...draft, freeDeliveryMajor: v })} placeholder="optional" />
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Estimated delivery time</label>
              <input type="number" min="0" step="1" value={draft.promiseMinutes} onChange={(e) => setDraft({ ...draft, promiseMinutes: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="45" />
              <p className="mt-1 text-[11px] text-gray-400">Minutes shown to customers for this area.</p>
            </div>
            <label className="flex items-center gap-2 pt-6 text-sm font-medium text-gray-700">
              <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
              Accept orders in this area
            </label>
          </div>
          {overlaps.length > 0 && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Already covered: {overlaps.slice(0, 4).map((o) => `${o.code} in ${o.zone.name}`).join(', ')}
              {overlaps.length > 4 ? ` and ${overlaps.length - 4} more` : ''}. The first matching active area wins.
            </p>
          )}
          {areaError && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{areaError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setDraft(null)}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={saveArea} disabled={saving}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
              {saving ? 'Saving…' : draft.id ? 'Save area' : 'Add area'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row gap-2">
          <button type="button" onClick={() => openCreate(primaryLocation)}
            className="flex-1 rounded-xl border border-dashed border-gray-300 py-3 text-sm font-medium text-gray-600 hover:border-emerald-400 hover:text-emerald-700">
            + Add delivery area
          </button>
          {uncoveredLocations.slice(0, 2).map((loc) => (
            <button key={loc.id} type="button" onClick={() => openCreate(loc)}
              className="rounded-xl border border-gray-200 px-4 py-3 text-sm font-medium text-gray-600 hover:border-emerald-400 hover:text-emerald-700">
              Add for {loc.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CoordinatePreview({ mode, points = [], radiusKm, valid }) {
  const width = 320;
  const height = 140;
  const pad = 18;
  const polygonPoints = validPolygonPoints(points);

  if (mode === 'RADIUS') {
    const km = numberOrNull(radiusKm) || 0;
    const radius = Math.max(18, Math.min(52, km * 7));
    return (
      <div className="mt-3 h-40 rounded-lg border border-blue-100 bg-white overflow-hidden">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" role="img" aria-label="Radius coverage preview">
          <rect x="0" y="0" width={width} height={height} fill="#f8fafc" />
          <circle cx={width / 2} cy={height / 2} r={radius} fill="#dbeafe" stroke="#2563eb" strokeWidth="2" />
          <circle cx={width / 2} cy={height / 2} r="4" fill="#1d4ed8" />
          <text x={width / 2} y={height - 18} textAnchor="middle" fontSize="12" fill={valid ? '#1d4ed8' : '#64748b'}>
            {valid ? `Radius ${km} km` : 'Enter center latitude, longitude, and radius'}
          </text>
        </svg>
      </div>
    );
  }

  let path = '';
  if (polygonPoints.length >= 3) {
    const lats = polygonPoints.map((point) => point.lat);
    const lngs = polygonPoints.map((point) => point.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const latSpan = Math.max(0.000001, maxLat - minLat);
    const lngSpan = Math.max(0.000001, maxLng - minLng);
    path = polygonPoints.map((point, index) => {
      const x = pad + ((point.lng - minLng) / lngSpan) * (width - pad * 2);
      const y = height - pad - ((point.lat - minLat) / latSpan) * (height - pad * 2);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
  }

  return (
    <div className="mt-3 h-40 rounded-lg border border-blue-100 bg-white overflow-hidden">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" role="img" aria-label="Polygon coverage preview">
        <rect x="0" y="0" width={width} height={height} fill="#f8fafc" />
        {path ? (
          <>
            <path d={`${path} Z`} fill="#dbeafe" stroke="#2563eb" strokeWidth="2" />
            {polygonPoints.map((point, index) => {
              const lats = polygonPoints.map((item) => item.lat);
              const lngs = polygonPoints.map((item) => item.lng);
              const minLat = Math.min(...lats);
              const maxLat = Math.max(...lats);
              const minLng = Math.min(...lngs);
              const maxLng = Math.max(...lngs);
              const latSpan = Math.max(0.000001, maxLat - minLat);
              const lngSpan = Math.max(0.000001, maxLng - minLng);
              const x = pad + ((point.lng - minLng) / lngSpan) * (width - pad * 2);
              const y = height - pad - ((point.lat - minLat) / latSpan) * (height - pad * 2);
              return <circle key={`${point.lat}-${point.lng}-${index}`} cx={x} cy={y} r="4" fill="#1d4ed8" />;
            })}
          </>
        ) : (
          <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="12" fill="#64748b">
            Add at least 3 valid points
          </text>
        )}
      </svg>
    </div>
  );
}

function MiniStat({ label, value, tone }) {
  const toneClass = tone === 'warn'
    ? 'border-amber-200 bg-amber-50 text-amber-900'
    : tone === 'ok'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : 'border-gray-200 bg-white text-gray-900';
  return (
    <div className={`rounded-xl border px-3 py-2 ${toneClass}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-lg font-bold">{value}</p>
    </div>
  );
}

function MoneyInput({ label, value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <input type="number" min="0" step="0.01" value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || '0'}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
    </div>
  );
}

// ─── Delivery pattern builder ──────────────────────────────────────────────
// Infer the builder's pattern fields from a location's existing recurring
// slots, so switching the location dropdown shows THAT branch's real config
// instead of stale defaults.
function inferPatternFromSlots(rows) {
  const recurring = (rows || []).filter((s) => !s.specificDate && typeof s.dayOfWeek === 'number');
  if (recurring.length === 0) return null;
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const presets = [30, 60, 90, 120, 180];
  const modal = (arr) => {
    const c = {}; let best = arr[0], bestN = 0;
    for (const v of arr) { c[v] = (c[v] || 0) + 1; if (c[v] > bestN) { bestN = c[v]; best = v; } }
    return best;
  };
  const days = Array.from(new Set(recurring.map((s) => s.dayOfWeek))).sort((a, b) => a - b);
  const openTime = recurring.reduce((m, s) => (s.startTime < m ? s.startTime : m), recurring[0].startTime);
  const closeTime = recurring.reduce((m, s) => (s.endTime > m ? s.endTime : m), recurring[0].endTime);
  const perDay = {};
  recurring.forEach((s) => { perDay[s.dayOfWeek] = (perDay[s.dayOfWeek] || 0) + 1; });
  const maxPerDay = Math.max(...Object.values(perDay));
  const spanMin = toMin(closeTime) - toMin(openTime);
  const modalDur = modal(recurring.map((s) => toMin(s.endTime) - toMin(s.startTime)));
  // One window/day covering the whole span = all-day (0); otherwise snap the
  // window length to the nearest preset the dropdown offers.
  let windowMinutes = 0;
  if (maxPerDay > 1 || modalDur < spanMin) {
    windowMinutes = presets.reduce((p, x) => (Math.abs(x - modalDur) < Math.abs(p - modalDur) ? x : p), presets[0]);
  }
  const capacity = modal(recurring.map((s) => s.capacity).filter((c) => typeof c === 'number')) || 20;
  return { days, openTime, closeTime, windowMinutes, capacity };
}

function DeliveryPatternBuilder({ locations, branchMode, onDone, onError, onAdvanced }) {
  const [locationId, setLocationId] = useState('');
  const [days, setDays] = useState([1, 2, 3, 4, 5, 6]); // Mon–Sat
  const [openTime, setOpenTime] = useState('09:00');
  const [closeTime, setCloseTime] = useState('18:00');
  const [windowMinutes, setWindowMinutes] = useState(120);
  const [capacity, setCapacity] = useState(20);
  const [busy, setBusy] = useState(false);
  const [loadingPattern, setLoadingPattern] = useState(false);
  const [existingCount, setExistingCount] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  // Pick the primary/first location on mount.
  useEffect(() => {
    if (!locationId && locations.length > 0) {
      const primary = locations.find((l) => l.isPrimary) || locations[0];
      setLocationId(primary.id);
    }
  }, [locations, locationId]);

  // When the chosen location changes (or after a save), load ITS current
  // windows and reflect them in the form. Fixes "switching branch shows the
  // same times" — the per-location data was never fetched before.
  useEffect(() => {
    if (!locationId) return undefined;
    // "All branches" can't reflect one branch's windows — keep the form as a
    // fresh pattern the seller fills in to apply to every branch.
    if (locationId === 'ALL') { setExistingCount(0); return undefined; }
    let cancelled = false;
    setLoadingPattern(true);
    api(`/api/ecom/slots?locationId=${locationId}&isActive=true&pageSize=100`)
      .then((r) => {
        if (cancelled) return;
        setExistingCount((r.rows || []).filter((s) => !s.specificDate).length);
        const inferred = inferPatternFromSlots(r.rows);
        if (inferred) {
          setDays(inferred.days);
          setOpenTime(inferred.openTime);
          setCloseTime(inferred.closeTime);
          setWindowMinutes(inferred.windowMinutes);
          setCapacity(inferred.capacity);
        } else {
          setDays([1, 2, 3, 4, 5, 6]); setOpenTime('09:00'); setCloseTime('18:00');
          setWindowMinutes(120); setCapacity(20);
        }
      })
      .catch(() => { /* keep current form on error */ })
      .finally(() => { if (!cancelled) setLoadingPattern(false); });
    return () => { cancelled = true; };
  }, [locationId, reloadKey]);

  const windows = useMemo(
    () => buildWindows(openTime, closeTime, windowMinutes),
    [openTime, closeTime, windowMinutes],
  );

  function toggleDay(i) {
    setDays((d) => d.includes(i) ? d.filter((x) => x !== i) : [...d, i]);
  }

  async function generate() {
    if (!locationId) { onError('Pick a location for these delivery times'); return; }
    if (days.length === 0) { onError('Pick at least one delivery day'); return; }
    if (closeTime <= openTime) { onError('Closing time must be after opening time'); return; }
    if (Number(capacity) < 1) { onError('Orders per window must be at least 1'); return; }
    // Saving replaces this location's recurring windows — warn if it would wipe
    // existing ones (including any set in the Advanced slots tab).
    if (existingCount > 0 && typeof window !== 'undefined'
      && !window.confirm('This replaces the current delivery windows for this location (including any you set in the Advanced slots tab). Continue?')) {
      return;
    }
    setBusy(true);
    try {
      const res = await api('/api/ecom/slots/generate', {
        method: 'POST',
        body: JSON.stringify({
          locationId,
          days,
          openTime,
          closeTime,
          windowMinutes: windowMinutes || null,
          capacity: Number(capacity) || 20,
          replaceExisting: true,
        }),
      });
      onDone(`Created ${res.created} delivery window${res.created === 1 ? '' : 's'} across ${days.length} day${days.length === 1 ? '' : 's'}.`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      onError(err.message || 'Could not build delivery times');
    } finally {
      setBusy(false);
    }
  }

  if (locations.length === 0) {
    return <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Add a location above first — delivery times belong to a store.</p>;
  }

  return (
    <div className="space-y-4">
      {locations.length > 1 && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Which location?</label>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}
            className="w-full sm:w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            {branchMode && <option value="ALL">All branches (set the same)</option>}
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.isPrimary ? ' (main)' : ''}</option>)}
          </select>
        </div>
      )}

      {locationId === 'ALL' ? (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          These times will be set for <strong>every branch</strong>, replacing their current windows.
        </p>
      ) : locationId && (
        <p className="text-[11px] text-gray-400">
          {loadingPattern ? 'Loading current delivery times…'
            : existingCount > 0 ? 'Showing the windows set for this location — saving replaces them.'
            : 'No delivery windows set for this location yet.'}
        </p>
      )}

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1.5">Days you deliver</label>
        <div className="flex flex-wrap gap-1.5">
          {DOW.map((d) => {
            const on = days.includes(d.i);
            return (
              <button key={d.i} type="button" onClick={() => toggleDay(d.i)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${on
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : 'border-gray-300 bg-white text-gray-600 hover:border-emerald-400'}`}>
                {d.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Opens</label>
          <input type="time" value={openTime} onChange={(e) => setOpenTime(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Closes</label>
          <input type="time" value={closeTime} onChange={(e) => setCloseTime(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Window length</label>
          <select value={windowMinutes} onChange={(e) => setWindowMinutes(Number(e.target.value))}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            {WINDOW_LENGTHS.map((w) => <option key={w.minutes} value={w.minutes}>{w.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Orders per window</label>
          <input type="number" min="1" max="10000" value={capacity} onChange={(e) => setCapacity(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
      </div>

      {/* Live preview */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
          Preview — {windows.length} window{windows.length === 1 ? '' : 's'} per day
        </p>
        {windows.length === 0 ? (
          <p className="text-xs text-gray-400">Set opening and closing times to see windows.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {windows.map((w, i) => (
              <span key={i} className="text-xs font-medium bg-white border border-gray-200 rounded-md px-2 py-1 text-gray-700">
                {prettyTime(w.startTime)}–{prettyTime(w.endTime)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={onAdvanced} className="text-xs font-semibold text-emerald-700 hover:underline">
          Fine-tune individual windows (Advanced) →
        </button>
        <button type="button" onClick={generate} disabled={busy || days.length === 0}
          className="px-5 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
          {busy ? 'Building…' : 'Save delivery times'}
        </button>
      </div>
      <p className="text-[11px] text-gray-400">Saving replaces this location's current weekly delivery windows.</p>
    </div>
  );
}

// ─── Store basics: default language + product currency ─────────────────────
function StoreBasics({ business, onError, onSaved, refreshTenant }) {
  const savedLang = business?.defaultLanguage || '';
  const savedCcy = business?.defaultCurrency || '';
  const [language, setLanguage] = useState(savedLang);
  const [currency, setCurrency] = useState(savedCcy);
  const [saving, setSaving] = useState(false);

  // Re-sync the draft whenever the business object is refreshed (refreshTenant
  // returns a new reference even if values are unchanged), so the form never
  // drifts from server state.
  useEffect(() => {
    setLanguage(business?.defaultLanguage || '');
    setCurrency(business?.defaultCurrency || '');
  }, [business]);

  const countryDefault = currencyForCountry(business?.country);
  const dirty = language !== savedLang || currency !== savedCcy;

  async function save() {
    // Currency change affects carts/checkout/reports — confirm before committing.
    if (currency !== savedCcy && typeof window !== 'undefined') {
      const ok = window.confirm(`Change your store currency to ${currency || `country default (${countryDefault})`}? This applies to new carts, checkout, order totals, and reports.`);
      if (!ok) return;
    }
    setSaving(true);
    try {
      const payload = {};
      if (language !== savedLang) payload.defaultLanguage = language;
      if (currency !== savedCcy) payload.defaultCurrency = currency;
      await api('/api/business/settings', { method: 'PATCH', body: JSON.stringify(payload) });
      await refreshTenant?.();
      onSaved?.('Saved store basics');
    } catch (err) {
      onError?.(err.message || 'Could not save store basics');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Default language</label>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">The language new visitors and emails start in. Anyone can switch their own view.</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Store currency</label>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            <option value="">Use country default ({countryDefault})</option>
            {CURRENCIES.map(([c, n]) => <option key={c} value={c}>{c} — {n}</option>)}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">Pre-fills new product prices. Existing products keep their own.</p>
        </div>
      </div>
      {dirty && (
        <div className="flex justify-end">
          <button type="button" onClick={save} disabled={saving}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save basics'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Days you don't deliver (holidays suppress delivery slots) ──────────────
function HolidaysSection({ branchMode, locations = [], onError }) {
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // 'GLOBAL' = all branches; otherwise a branch's locationId. Only branch
  // (CHAIN) stores get the per-branch picker; everyone else manages global.
  const [scope, setScope] = useState('GLOBAL');
  const perBranch = branchMode && locations.length > 0;
  const branchName = (id) => locations.find((l) => l.id === id)?.name || 'a branch';

  async function load() {
    setLoading(true);
    try {
      const data = await api(`/api/business/holidays?locationId=${encodeURIComponent(scope)}`);
      setHolidays(data.holidays || []);
    } catch (err) {
      onError?.(err.message || 'Could not load holidays');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [scope]);

  async function add() {
    if (!date) { onError?.('Pick a date'); return; }
    setBusy(true);
    try {
      await api('/api/business/holidays', {
        method: 'POST',
        body: JSON.stringify({ date, name: name.trim() || 'Closed', locationId: scope === 'GLOBAL' ? null : scope }),
      });
      setDate(''); setName('');
      await load();
    } catch (err) {
      onError?.(err.message || 'Could not add');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id) {
    try {
      await api(`/api/business/holidays/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      onError?.(err.message || 'Could not remove holiday');
    }
  }

  const sorted = [...holidays].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return (
    <div>
      <p className="text-sm font-semibold text-gray-900">Days you don&apos;t deliver</p>
      <p className="text-xs text-gray-500 mt-0.5 mb-3">
        Add a date and customers won&apos;t see any delivery windows that day — no delivery on holidays.
        {perBranch && ' Different cities can have different public holidays, so pick who each one applies to.'}
      </p>

      {perBranch && (
        <div className="mb-3">
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Applies to</label>
          <select value={scope} onChange={(e) => setScope(e.target.value)}
            className="w-full sm:w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            <option value="GLOBAL">All branches</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.isPrimary ? ' (main)' : ''}</option>)}
          </select>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : sorted.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 mb-3">
          {sorted.map((h) => (
            <li key={h.id} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs">
              <span className="font-medium text-gray-800">{new Date(h.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
              {h.name && h.name !== 'Closed' && <span className="text-gray-400">· {h.name}</span>}
              {perBranch && (
                <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-gray-100 text-gray-500">
                  {h.locationId ? branchName(h.locationId) : 'All branches'}
                </span>
              )}
              <button type="button" onClick={() => remove(h.id)} className="text-gray-400 hover:text-red-600 leading-none">×</button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1">Reason (optional)</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Public holiday"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <button type="button" onClick={add} disabled={busy || !date}
          className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-50 disabled:opacity-50">
          {busy ? 'Adding…' : 'Add day off'}
        </button>
      </div>
    </div>
  );
}

function Input({ label, value, onChange, placeholder, full }) {
  return (
    <div className={full ? 'sm:col-span-2' : ''}>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <input type="text" value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
    </div>
  );
}
