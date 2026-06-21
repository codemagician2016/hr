const CHAT_CHANNELS = {
  CUSTOMER_SUPPORT: 'CUSTOMER_SUPPORT',
  TENANT_SUPPORT: 'TENANT_SUPPORT',
  SALES_SUPPORT: 'SALES_SUPPORT',
};

const CHAT_PROJECTS = {
  SITEPRESSO: 'sitepresso',
  SHOP: 'shop',
  BOOKING: 'booking',
  WEB: 'web',
};

function normalizeProjectKey(value, fallback = CHAT_PROJECTS.SITEPRESSO) {
  const clean = String(value || fallback || CHAT_PROJECTS.SITEPRESSO)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return clean || fallback || CHAT_PROJECTS.SITEPRESSO;
}

function normalizeChannel(value, fallback = CHAT_CHANNELS.CUSTOMER_SUPPORT) {
  const clean = String(value || fallback || CHAT_CHANNELS.CUSTOMER_SUPPORT)
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
  return clean || fallback || CHAT_CHANNELS.CUSTOMER_SUPPORT;
}

function chatStorageKey({ namespace = 'sitepresso-chat', tenantSlug = 'tenant', projectKey = CHAT_PROJECTS.SITEPRESSO } = {}) {
  return `${namespace}:${normalizeProjectKey(projectKey)}:${String(tenantSlug || 'tenant').toLowerCase()}`;
}

const DEFAULT_SELF_HELP = [
  {
    id: 'orders',
    title: 'Orders and tracking',
    summary: 'Track orders, delivery status, pickup readiness, and missing order confirmations.',
    keywords: ['order', 'track', 'tracking', 'delivery', 'delivered', 'dispatch', 'pickup', 'confirmation', 'receipt'],
    answer: 'You can track recent orders from My account > My orders. Open an order to see its current status, payment state, delivery or pickup method, and order items.',
    actions: [
      { label: 'Open my orders', href: '/account' },
      { label: 'Contact support', action: 'human' },
    ],
  },
  {
    id: 'payments',
    title: 'Payments and refunds',
    summary: 'Payment method, failed payment, COD, prepaid orders, refunds, and payment receipts.',
    keywords: ['payment', 'paid', 'cod', 'cash', 'refund', 'failed', 'card', 'online', 'receipt', 'invoice'],
    answer: 'Payment options depend on the store settings. If an order was paid online, the receipt and payment status appear on the order details page. Refund requests should include the order number and reason.',
    actions: [
      { label: 'View account', href: '/account' },
      { label: 'Ask about a refund', action: 'human' },
    ],
  },
  {
    id: 'delivery-pickup',
    title: 'Delivery and pickup',
    summary: 'Delivery address, slots, rider handover, pickup readiness, and store collection.',
    keywords: ['slot', 'address', 'rider', 'handover', 'pickup', 'collect', 'delivery area', 'delivery time', 'change address'],
    answer: 'Delivery and pickup availability is controlled by the store. For active orders, check My account > My orders. If the order is already being prepared, address or slot changes may require store approval.',
    actions: [
      { label: 'Check orders', href: '/account' },
      { label: 'Talk to the store', action: 'human' },
    ],
  },
  {
    id: 'account',
    title: 'Account and login',
    summary: 'Sign in, customer profile, addresses, wishlist, and saved account details.',
    keywords: ['login', 'sign in', 'password', 'profile', 'account', 'address', 'wishlist', 'email', 'phone'],
    answer: 'Use the account area to view orders, manage addresses, wishlist items, and profile details. If you cannot access your account, use the sign-in page and reset your password if needed.',
    actions: [
      { label: 'Open account', href: '/account' },
      { label: 'Sign in', href: '/login' },
    ],
  },
  {
    id: 'products-stock',
    title: 'Products, stock, and pricing',
    summary: 'Availability, location-specific stock, product price, substitutions, and out-of-stock items.',
    keywords: ['product', 'stock', 'available', 'out of stock', 'price', 'pricing', 'substitute', 'quantity', 'inventory'],
    answer: 'Product availability and pricing can depend on the selected store or fulfilment location. If an item is unavailable, the store team can confirm substitutes or restock timing.',
    actions: [
      { label: 'Browse products', href: '/shop' },
      { label: 'Ask store team', action: 'human' },
    ],
  },
  {
    id: 'returns',
    title: 'Returns and complaints',
    summary: 'Damaged items, wrong items, returns, quality complaints, and replacement requests.',
    keywords: ['return', 'wrong', 'damaged', 'missing', 'complaint', 'quality', 'replace', 'replacement', 'spoiled'],
    answer: 'For a return or quality issue, include your order number, item name, and a short description. The store team can review and approve refund, replacement, or pickup according to policy.',
    actions: [
      { label: 'Submit support request', action: 'human' },
    ],
  },
];

function normalise(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreArticle(query, article) {
  const haystack = normalise([
    article.title,
    article.summary,
    article.answer,
    ...(article.keywords || []),
  ].join(' '));
  const words = normalise(query).split(' ').filter((word) => word.length > 2);
  if (!words.length) return 0;
  return words.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
}

function answerSelfHelp(query, articles = DEFAULT_SELF_HELP) {
  const cleanQuery = normalise(query);
  const ranked = articles
    .map((article) => ({ ...article, score: scoreArticle(cleanQuery, article) }))
    .filter((article) => article.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (!cleanQuery) {
    return {
      resolved: false,
      answer: 'Choose a topic below or type your question. If the help content does not solve it, you can still talk to the team.',
      suggestions: articles.slice(0, 5),
    };
  }

  if (!ranked.length) {
    return {
      resolved: false,
      answer: 'I could not find a confident answer for that. You can start a human support chat and the team will help from here.',
      suggestions: articles.slice(0, 3),
    };
  }

  const best = ranked[0];
  return {
    resolved: best.score >= 2,
    answer: best.answer,
    suggestions: ranked,
  };
}

module.exports = {
  CHAT_CHANNELS,
  CHAT_PROJECTS,
  DEFAULT_SELF_HELP,
  chatStorageKey,
  normalizeChannel,
  normalizeProjectKey,
  answerSelfHelp,
};
