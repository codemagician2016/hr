'use client';

// Shared pricing section: vertical tabs (Website / Appointments / Commerce)
// + monthly/yearly toggle + plan cards. Used on the public landing
// page and the admin subscription tab. Each consumer passes its own
// `renderCard` so the marketing card (signup CTAs) and the admin card
// (upgrade/downgrade buttons, "your plan" badge) can stay distinct.
//
// Pricing for visible verticals is fetched in parallel on mount and
// cached, so tab switches are instant when tabs are enabled.

import { useEffect, useState } from 'react';

export const VERTICAL_TABS = [
  { key: 'STATIC',      label: 'Website' },
  { key: 'APPOINTMENT', label: 'Appointments' },
  { key: 'ECOMMERCE',   label: 'Commerce' },
];

function buildPlans(pricing) {
  const region = pricing?.regions?.[0] || null;
  const symbol = region?.symbol || '$';
  const tiers = Array.isArray(pricing?.tiers) ? pricing.tiers : [];
  const plans = tiers
    .slice()
    .filter((t) => String(t.slug || '').toLowerCase() !== 'free')
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map((t) => {
      const regionPrice = region?.plans?.[t.slug] || {};
      const features = Array.isArray(t.features) ? [...t.features] : [];
      if (regionPrice.extraStaffMonthly && t.includedStaff) {
        const line = `Extra staff at ${symbol}${Number(regionPrice.extraStaffMonthly).toLocaleString('en-IN')}/month each`;
        const idx = features.findIndex((f) => f.toLowerCase().includes('staff members included'));
        if (idx >= 0) features.splice(idx + 1, 0, line);
        else features.push(line);
      }
      const trialDays = Number(t.trialDays) > 0 ? Number(t.trialDays) : null;
      let cta = t.ctaLabel || (trialDays ? `Start ${trialDays}-day trial` : 'Get started');
      if (!trialDays && /trial/i.test(cta)) cta = 'Get started';
      return {
        slug: t.slug,
        name: t.name,
        tagline: t.tagline || '',
        features,
        cta,
        ctaHref: t.ctaHref || undefined,
        popular: !!t.highlighted,
        badge: t.badge,
        includedStaff: t.includedStaff || undefined,
        trialDays,
        isCustomPriced: !!t.isCustomPriced,
        sortOrder: t.sortOrder || 0,
        monthly: Number(regionPrice.monthly) || 0,
        yearly: Number(regionPrice.yearly) || 0,
      };
    });
  return { plans, region, symbol };
}

// Real annual saving across the visible plans: max of 1 − (yearly ÷ monthly×12).
// Computed from the catalog prices so the toggle badge never drifts from what's
// actually charged (vs. a hardcoded "−20%").
function annualDiscountPct(plans) {
  let best = 0;
  for (const p of plans || []) {
    const m = Number(p.monthly);
    const y = Number(p.yearly);
    if (m > 0 && y > 0) {
      const pct = Math.round((1 - y / (m * 12)) * 100);
      if (pct > best) best = pct;
    }
  }
  return best;
}

export default function PricingPlanCards({
  initialVertical = 'APPOINTMENT',
  initialBilling = 'yearly',
  billing: billingProp,           // optional controlled mode
  onBillingChange,                // fires when user toggles
  fetcher,
  countryOverride,
  renderCard,
  renderSkeleton,
  className = '',
  toolbarLabels = {},
  showVerticalTabs = true,
  verticals = VERTICAL_TABS.map((tab) => tab.key),
}) {
  const visibleVerticals = VERTICAL_TABS.filter((tab) => verticals.includes(tab.key));
  const [billingState, setBillingState] = useState(initialBilling);
  const billing = billingProp !== undefined ? billingProp : billingState;
  const setBilling = (next) => {
    if (onBillingChange) onBillingChange(next);
    if (billingProp === undefined) setBillingState(next);
  };
  const [verticalTab, setVerticalTab] = useState(initialVertical);
  const [country, setCountry] = useState(countryOverride ?? null);
  const [resolvedCountry, setResolvedCountry] = useState(false);
  const [pricingByVertical, setPricingByVertical] = useState({});

  const { monthlyLabel = 'Monthly', yearlyLabel = 'Yearly', discountLabel = '−17%' } = toolbarLabels;

  useEffect(() => {
    if (!visibleVerticals.some((tab) => tab.key === verticalTab)) {
      setVerticalTab(visibleVerticals[0]?.key || initialVertical);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialVertical, verticals.join('|')]);

  // Resolve country once. If consumer passed countryOverride we trust it;
  // otherwise look up /geo (Cloudflare CF-IPCountry header).
  useEffect(() => {
    if (countryOverride !== undefined) {
      setCountry(countryOverride || null);
      setResolvedCountry(true);
      return;
    }
    let cancelled = false;
    (async () => {
      const override = typeof window !== 'undefined'
        ? (new URLSearchParams(window.location.search).get('country') || '').toUpperCase().slice(0, 2)
        : '';
      const geo = override
        ? { country: override }
        : await fetch('/geo').then((r) => r.json()).catch(() => ({ country: null }));
      if (cancelled) return;
      setCountry(geo.country || null);
      setResolvedCountry(true);
    })();
    return () => { cancelled = true; };
  }, [countryOverride]);

  // Pre-fetch all visible verticals in parallel.
  useEffect(() => {
    if (!resolvedCountry || !fetcher) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        visibleVerticals.map(async (tab) => [tab.key, await fetcher(country, tab.key)]),
      );
      if (cancelled) return;
      setPricingByVertical(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedCountry, country, fetcher, verticals.join('|')]);

  const pricing = pricingByVertical[verticalTab] || null;
  const { plans, region, symbol } = buildPlans(pricing);
  // Prefer the real computed saving; fall back to the passed label until prices load.
  const computedDiscount = annualDiscountPct(plans);
  const effectiveDiscountLabel = computedDiscount > 0 ? `−${computedDiscount}%` : discountLabel;

  return (
    <div className={className}>
      <div className="flex items-center justify-center gap-3 flex-wrap">
        {showVerticalTabs && visibleVerticals.length > 1 && (
          <div className="inline-flex items-center gap-1 p-1 rounded-full bg-gray-100 border border-gray-200 text-sm">
            {visibleVerticals.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setVerticalTab(v.key)}
              className={`px-4 py-2 rounded-full font-medium transition-colors ${
                verticalTab === v.key
                  ? 'bg-gray-900 text-white shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {v.label}
            </button>
            ))}
          </div>
        )}
        <div className="inline-flex items-center gap-1 p-1 rounded-full bg-gray-900 text-sm">
          <button
            type="button"
            onClick={() => setBilling('monthly')}
            className={`px-5 py-2 rounded-full font-medium transition-colors ${billing === 'monthly' ? 'bg-white text-gray-900' : 'text-gray-300 hover:text-white'}`}
          >{monthlyLabel}</button>
          <button
            type="button"
            onClick={() => setBilling('yearly')}
            className={`px-5 py-2 rounded-full font-medium transition-colors flex items-center gap-2 ${billing === 'yearly' ? 'bg-white text-gray-900' : 'text-gray-300 hover:text-white'}`}
          >
            {yearlyLabel}
            <span className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-semibold">{effectiveDiscountLabel}</span>
          </button>
        </div>
      </div>

      <div className="mt-8 grid md:grid-cols-2 xl:grid-cols-5 gap-3">
        {plans.length > 0
          ? plans.map((p) => renderCard(p, { billing, region, symbol, vertical: verticalTab }))
          : (renderSkeleton ? Array.from({ length: 5 }).map((_, i) => renderSkeleton(i)) : null)
        }
      </div>
    </div>
  );
}
