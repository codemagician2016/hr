export const ADMIN_SEARCH_TARGETS = [
  {
    key: 'products',
    label: 'Products',
    eyebrow: 'Catalog',
    hint: 'name, SKU, barcode, category',
    aliases: ['product', 'products', 'catalog', 'catalogue', 'sku', 'barcode', 'category', 'item', 'items'],
  },
  {
    key: 'orders',
    label: 'Orders',
    eyebrow: 'Fulfillment',
    hint: 'order ID, customer, email, phone',
    aliases: ['order', 'orders', 'fulfillment', 'fulfilment', 'dispatch', 'delivery', 'invoice'],
  },
  {
    key: 'customers',
    label: 'Customers',
    eyebrow: 'CRM',
    hint: 'name, email, phone',
    aliases: ['customer', 'customers', 'buyer', 'buyers', 'email', 'phone', 'mobile'],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    eyebrow: 'Stock',
    hint: 'SKU, barcode, pick code, aisle, rack',
    aliases: ['inventory', 'stock', 'stocks', 'low stock', 'out of stock', 'grn', 'transfer', 'warehouse'],
  },
  {
    key: 'returns',
    label: 'Returns',
    eyebrow: 'Fulfillment',
    hint: 'return code, customer, order',
    aliases: ['return', 'returns', 'refund', 'refunds', 'damage', 'damaged'],
  },
  {
    key: 'ecom-coupons',
    label: 'Coupons',
    eyebrow: 'Marketing',
    hint: 'coupon code or description',
    aliases: ['coupon', 'coupons', 'discount', 'discounts', 'promo', 'promotion', 'code'],
  },
  {
    key: 'banners',
    label: 'Banners',
    eyebrow: 'Marketing',
    hint: 'hero, promo, campaign placement',
    aliases: ['banner', 'banners', 'hero', 'promo', 'campaign'],
  },
  {
    key: 'cms',
    label: 'CMS blocks',
    eyebrow: 'Storefront',
    hint: 'homepage shelf, trust block, content block',
    aliases: ['cms', 'block', 'blocks', 'homepage', 'home page', 'shelf', 'content'],
  },
];

export const EMPTY_SEARCH_SHORTCUTS = ['products', 'orders', 'inventory', 'customers', 'banners', 'cms'];

const DEFAULT_SEARCH_ORDER = new Map(ADMIN_SEARCH_TARGETS.map((target, index) => [target.key, index + 10]));

const ADMIN_NAV_TARGETS = [
  {
    key: 'payments',
    eyebrow: 'Finance',
    hint: 'Payment gateways, Razorpay Route, Stripe Connect, payouts, KYC',
    aliases: [
      'finance', 'payment', 'payments', 'gateway', 'gateways', 'razorpay', 'razorpay route',
      'razorpay partner', 'stripe', 'stripe connect', 'connect', 'payout', 'settlement',
      'settlements', 'kyc', 'linked account', 'merchant account',
    ],
  },
  {
    key: 'ecom-reports',
    eyebrow: 'Finance',
    hint: 'Sales, basket, inventory, revenue, customer analytics',
    aliases: ['finance', 'report', 'reports', 'analytics', 'revenue', 'sales report', 'basket', 'aov'],
  },
  {
    key: 'tax',
    eyebrow: 'Finance',
    hint: 'GST, VAT, tax rates, invoices',
    aliases: ['finance', 'tax', 'gst', 'vat', 'invoice', 'invoices', 'tax rate', 'tax rates'],
  },
  {
    key: 'subscription',
    eyebrow: 'Billing',
    hint: 'Plan, subscription, trial, Paddle/MOR billing',
    aliases: [
      'billing', 'plan', 'plans', 'subscription', 'subscriptions', 'trial', 'upgrade',
      'downgrade', 'paddle', 'mor', 'merchant of record', 'invoice billing',
    ],
  },
  {
    key: 'ecom-coupons',
    eyebrow: 'Marketing',
    hint: 'Coupons, discounts, promo codes, offers',
    aliases: ['marketing'],
  },
  {
    key: 'banners',
    eyebrow: 'Marketing',
    hint: 'Hero banners, campaigns, storefront promos',
    aliases: ['marketing', 'banner', 'banners', 'hero', 'campaign', 'campaigns', 'promo banner', 'deal banner'],
  },
  {
    key: 'cms',
    eyebrow: 'Marketing',
    hint: 'Homepage blocks, shelves, trust blocks, storytelling',
    aliases: ['marketing', 'cms', 'block', 'blocks', 'homepage', 'home page', 'shelf', 'shelves', 'storytelling'],
  },
  {
    key: 'ecom-notifications',
    eyebrow: 'Marketing',
    hint: 'Email, SMS, WhatsApp templates',
    aliases: ['marketing', 'notification', 'notifications', 'email', 'sms', 'whatsapp', 'template', 'templates'],
  },
  {
    key: 'reviews',
    eyebrow: 'Marketing',
    hint: 'Ratings and customer feedback',
    aliases: ['marketing', 'review', 'reviews', 'rating', 'ratings', 'feedback'],
  },
  {
    key: 'store-setup',
    eyebrow: 'Setup',
    hint: 'Locations, delivery, pickup, branch setup, currency',
    aliases: ['setup', 'store setup', 'location', 'locations', 'branch', 'branches', 'delivery', 'pickup', 'currency', 'language'],
  },
  {
    key: 'domains',
    eyebrow: 'System',
    hint: 'Domains, DNS, custom domain, OpenProvider',
    aliases: ['domain', 'domains', 'dns', 'custom domain', 'openprovider', 'subdomain'],
  },
  {
    key: 'content',
    eyebrow: 'System',
    hint: 'Storefront branding, logo, header, social links',
    aliases: ['storefront', 'logo', 'brand', 'branding', 'header', 'footer', 'social', 'social links'],
  },
  {
    key: 'policies',
    eyebrow: 'System',
    hint: 'Privacy, terms, refund, signup legal content',
    aliases: ['policy', 'policies', 'privacy', 'terms', 'refund', 'returns policy', 'legal'],
  },
  {
    key: 'settings',
    eyebrow: 'System',
    hint: 'Business settings, feature settings, account configuration',
    aliases: ['setting', 'settings', 'configuration', 'config', 'feature', 'features'],
  },
  {
    key: 'roles',
    eyebrow: 'System',
    hint: 'Roles and permissions',
    aliases: ['role', 'roles', 'permission', 'permissions', 'rbac', 'access'],
  },
  {
    key: 'ecom-staff',
    eyebrow: 'System',
    hint: 'Staff, team members, access and 2FA',
    aliases: ['staff', 'employee', 'employees', 'team member', 'team members', '2fa'],
  },
  {
    key: 'activity',
    eyebrow: 'System',
    hint: 'Activity log and audit history',
    aliases: ['activity', 'activity log', 'audit', 'audit log', 'history'],
  },
];

const DEFAULT_NAV_ORDER = new Map(ADMIN_NAV_TARGETS.map((target, index) => [target.key, index + 1]));

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function includesWord(source, query) {
  if (!query) return false;
  return normalize(source).includes(query);
}

function targetMatchesQuery(target, query) {
  const q = normalize(query);
  if (!q) return false;
  const haystack = [target.key, target.label, target.hint, ...(target.aliases || [])].join(' ');
  return includesWord(haystack, q) || (target.aliases || []).some((alias) => includesWord(q, alias));
}

function navTargetMatchesQuery(target, query) {
  const q = normalize(query);
  if (!q) return false;
  const haystack = [target.key, target.eyebrow, target.hint, ...(target.aliases || [])].join(' ');
  return includesWord(haystack, q) || (target.aliases || []).some((alias) => includesWord(q, alias));
}

function scoreTarget(target, query, activeKey) {
  const q = normalize(query);
  if (target.key === activeKey) return 0;
  if (targetMatchesQuery(target, q)) return 1;
  if (/@/.test(q) && target.key === 'customers') return 2;
  if (/\b(ord|order|invoice|dispatch|delivery)\b/.test(q) && target.key === 'orders') return 2;
  if (/\b(sku|barcode|stock|inventory|grn)\b/.test(q) && ['products', 'inventory'].includes(target.key)) return 2;
  if (/\b(return|refund)\b/.test(q) && target.key === 'returns') return 2;
  if (/\b(coupon|discount|promo)\b/.test(q) && target.key === 'ecom-coupons') return 2;
  return DEFAULT_SEARCH_ORDER.get(target.key) || 99;
}

function asAvailableSet(availableKeys) {
  if (availableKeys instanceof Set) return availableKeys;
  return new Set(availableKeys || []);
}

export function buildEcommerceAdminSearchResults({ navItems = [], query = '', activeKey = '' } = {}) {
  const q = normalize(query);
  const availableKeys = asAvailableSet(navItems.map((item) => item.key));
  const navByKey = new Map(navItems.map((item) => [item.key, item]));
  const quickLinks = EMPTY_SEARCH_SHORTCUTS
    .map((key) => navItems.find((item) => item.key === key))
    .filter(Boolean);
  const fallbackLinks = quickLinks.length ? quickLinks : navItems.slice(0, 6);

  if (!q) {
    return fallbackLinks.map((item) => ({
      type: 'nav',
      key: item.key,
      label: item.label,
      eyebrow: 'Open',
      hint: item.sub || 'Go to this admin area',
    }));
  }

  const aliasedNavMatches = ADMIN_NAV_TARGETS
    .filter((target) => availableKeys.has(target.key))
    .filter((target) => navTargetMatchesQuery(target, q))
    .map((target) => {
      const item = navByKey.get(target.key);
      return {
        type: 'nav',
        key: target.key,
        label: item?.label || target.key,
        eyebrow: target.eyebrow || 'Open',
        hint: target.hint || item?.sub || 'Go to this admin area',
        score: target.key === activeKey ? 0 : (DEFAULT_NAV_ORDER.get(target.key) || 99),
      };
    })
    .sort((a, b) => a.score - b.score || (DEFAULT_NAV_ORDER.get(a.key) || 99) - (DEFAULT_NAV_ORDER.get(b.key) || 99));

  const navMatches = navItems
    .filter((item) => includesWord([item.label, item.sub, item.key].filter(Boolean).join(' '), q))
    .filter((item) => !aliasedNavMatches.some((match) => match.key === item.key))
    .slice(0, 6)
    .map((item) => ({
      type: 'nav',
      key: item.key,
      label: item.label,
      eyebrow: 'Open',
      hint: item.sub || 'Go to this admin area',
    }));

  const searchableTargets = ADMIN_SEARCH_TARGETS
    .filter((target) => availableKeys.has(target.key))
    .map((target) => ({
      type: 'search',
      key: target.key,
      label: `Search ${target.label} for "${query.trim()}"`,
      eyebrow: target.eyebrow,
      hint: target.hint,
      score: scoreTarget(target, q, activeKey),
      directMatch: targetMatchesQuery(target, q) || target.key === activeKey,
    }))
    .sort((a, b) => a.score - b.score || (DEFAULT_SEARCH_ORDER.get(a.key) || 99) - (DEFAULT_SEARCH_ORDER.get(b.key) || 99));

  const directTargets = searchableTargets.filter((target) => target.directMatch || target.score <= 2);
  const broadTargets = searchableTargets.filter((target) => !directTargets.some((match) => match.key === target.key));

  if (aliasedNavMatches.length > 0) return [...aliasedNavMatches, ...navMatches, ...directTargets, ...broadTargets].slice(0, 8);
  if (directTargets.length > 0) return [...directTargets, ...navMatches.filter((item) => !directTargets.some((target) => target.key === item.key)), ...broadTargets].slice(0, 8);
  if (navMatches.length > 0) return [...navMatches, ...broadTargets].slice(0, 8);
  return broadTargets.slice(0, 8);
}
