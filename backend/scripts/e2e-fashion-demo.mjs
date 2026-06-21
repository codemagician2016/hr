// Live end-to-end smoke for the Fashion flagship storefront on staging.
// Exercises the REAL runtime path a shopper hits: browse → filter-data → PDP →
// related → guest cart add → cart totals → checkout-readiness → account gate.
// Run: node backend/scripts/e2e-fashion-demo.mjs  (no deps; uses global fetch)

const HOST = process.env.E2E_HOST || 'https://fashion-demo.aapkatech.com';
const SLUG = process.env.E2E_SLUG || 'fashion-demo';
const API = `${HOST}/api/storefront/${SLUG}`;
const SESSION = 'e2e-' + Array.from({ length: 16 }, (_, i) => ((i * 7 + 3) % 16).toString(16)).join('');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
}
async function getJson(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

(async () => {
  console.log(`\n▶ E2E Fashion storefront — ${HOST}\n`);

  // ── 1. BROWSE: category tree ─────────────────────────────────────────────
  const cats = await getJson(`${API}/categories`);
  const list = cats.body?.categories || [];
  const top = list.filter((c) => !c.parentId);
  const sub = list.filter((c) => c.parentId);
  check('categories load', cats.status === 200 && list.length > 0, `${list.length} cats`);
  check('two-level tree (top + sub-categories)', top.length >= 6 && sub.length >= 12, `${top.length} top / ${sub.length} sub`);
  const everySubHasParent = sub.every((c) => top.some((t) => t.id === c.parentId));
  check('every sub-category resolves to a top-level parent', everySubHasParent);

  // ── 2. BROWSE: parent expands to descendants, leaf is narrow ──────────────
  const parent = top.find((t) => sub.some((s) => s.parentId === t.id));
  const leaf = sub.find((s) => s.parentId === parent?.id);
  const parentProds = await getJson(`${API}/products?categorySlug=${parent.slug}&perPage=100`);
  const leafProds = await getJson(`${API}/products?categorySlug=${leaf.slug}&perPage=100`);
  const pTotal = parentProds.body?.total || 0;
  const lTotal = leafProds.body?.total || 0;
  check(`parent "${parent.slug}" expands to descendants`, pTotal > 0, `${pTotal} products`);
  check(`leaf "${leaf.slug}" narrows`, lTotal > 0 && lTotal <= pTotal, `${lTotal} ≤ ${pTotal}`);
  const leafCats = new Set((leafProds.body?.products || []).map((p) => p.category?.slug));
  check('leaf page returns only its own products', leafCats.size === 1 && leafCats.has(leaf.slug), [...leafCats].join(','));

  // ── 3. FILTER data integrity (facets are client-side over these fields) ───
  const all = await getJson(`${API}/products?perPage=100`);
  const prods = all.body?.products || [];
  check('catalog non-empty', prods.length > 0, `${prods.length} products`);
  const withVariants = prods.filter((p) => (p.variants || []).length);
  const sizeColour = withVariants.filter((p) => p.variants.some((v) => v.option1Value) && p.variants.some((v) => v.option2Value));
  check('products carry Size × Colour variants (size/colour facets)', sizeColour.length >= prods.length * 0.8, `${sizeColour.length}/${prods.length}`);
  const withFabric = prods.filter((p) => p.specs?.fabric);
  check('products carry specs.fabric (fabric facet + PDP details)', withFabric.length >= prods.length * 0.8, `${withFabric.length}/${prods.length}`);
  const withBrand = prods.filter((p) => p.brand);
  check('products carry brand (brand facet)', withBrand.length >= prods.length * 0.8, `${withBrand.length}/${prods.length}`);
  const onSale = prods.filter((p) => p.comparePriceMinor && p.comparePriceMinor > p.priceMinor);
  check('some products are on sale (on-sale facet + strikethrough)', onSale.length > 0, `${onSale.length} on sale`);

  // ── 4. PDP: full product detail ───────────────────────────────────────────
  const pick = sizeColour.find((p) => p.specs?.fabric) || prods[0];
  const pdp = await getJson(`${API}/products/${pick.slug}`);
  const prod = pdp.body?.product || pdp.body;
  check(`PDP loads "${pick.slug}"`, pdp.status === 200 && !!prod?.id);
  check('PDP has specs (fabric/fit/details)', !!(prod?.specs?.fabric && prod?.specs?.fit && Array.isArray(prod?.specs?.details)), prod?.specs?.fit || '');
  check('PDP has image gallery', Array.isArray(prod?.imageUrls) && prod.imageUrls.length >= 1, `${prod?.imageUrls?.length || 0} images`);
  check('PDP has purchasable variants', (prod?.variants || []).length > 0, `${prod?.variants?.length || 0} variants`);

  // ── 5. Related ("Complete the look" / "You may also like") ─────────────────
  const related = await getJson(`${API}/products/${prod.id}/related`);
  const rel = related.body?.products || related.body?.related || related.body || [];
  check('related products endpoint responds', related.status === 200, `${Array.isArray(rel) ? rel.length : '?'} related`);

  // ── 6. CART: guest add → totals ───────────────────────────────────────────
  const variant = (prod.variants || []).find((v) => v.stockQty == null || v.stockQty > 0) || prod.variants?.[0];
  const headers = { 'Content-Type': 'application/json', 'x-cart-session': SESSION };
  const add = await getJson(`${API}/cart/items`, {
    method: 'POST', headers,
    body: JSON.stringify({ productId: prod.id, variantId: variant?.id || null, quantity: 2 }),
  });
  check('add to cart (guest session)', add.status === 200 || add.status === 201, `HTTP ${add.status}`);
  const cart = await getJson(`${API}/cart`, { headers });
  const c = cart.body?.cart || cart.body;
  const items = c?.items || [];
  const itemCount = c?.itemCount ?? items.reduce((n, i) => n + (i.quantity || 0), 0);
  check('cart persists the line', items.length >= 1 && itemCount >= 2, `${items.length} line(s), qty ${itemCount}`);
  const subtotal = c?.subtotalMinor ?? c?.subtotal ?? c?.totalMinor;
  check('cart computes a subtotal', subtotal != null && subtotal > 0, String(subtotal));
  // Myntra-style line data the redesigned cart renders.
  const line = items[0] || {};
  check('cart line exposes brand', !!line.product?.brand, line.product?.brand || '(none)');
  check('cart line exposes the variant (size/colour)', !!line.product?.variant?.label, line.product?.variant?.label || '(none)');
  check('cart line exposes MRP (comparePriceMinor) for strikethrough', line.product?.comparePriceMinor != null, String(line.product?.comparePriceMinor));

  // ── 7. CHECKOUT readiness ─────────────────────────────────────────────────
  const pay = await getJson(`${API}/payment-providers`, { headers });
  const providers = pay.body?.providers || pay.body || [];
  check('payment providers resolve (checkout can render)', pay.status === 200, `${Array.isArray(providers) ? providers.length : Object.keys(providers || {}).length} provider(s)`);

  // ── 8. ACCOUNT gate (portal is themed; verify auth boundary) ──────────────
  const me = await getJson(`${HOST}/api/customer/me`);
  check('account gate returns 401 for guest', me.status === 401, `HTTP ${me.status}`);
  const login = await fetch(`${HOST}/login`);
  check('login page renders', login.status === 200, `HTTP ${login.status}`);

  console.log(`\n${fail === 0 ? '🎉 ALL PASS' : '⚠️  FAILURES'} — ${pass} passed, ${fail} failed.\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
