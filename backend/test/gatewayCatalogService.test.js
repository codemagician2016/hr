// Publish-to-gateways service: preview is read-only; publish (re)creates gateway
// plans at the current TierPrice amount and writes the ids back; idempotent —
// reuses a plan whose live amount already matches.

const mockPrisma = {
  pricingTier: { findMany: jest.fn() },
  tierPrice: { update: jest.fn(async () => ({})) },
};
const mockGw = { isConfigured: jest.fn(() => true), getPlan: jest.fn(), createPlan: jest.fn() };
const mockStripe = { products: { create: jest.fn() }, prices: { create: jest.fn(), retrieve: jest.fn() } };

jest.mock('../src/core/lib/prisma', () => mockPrisma);
jest.mock('../src/core/lib/billing/gateways', () => ({ getGateway: () => mockGw }));
jest.mock('../src/core/lib/billing/gateways/stripeGateway', () => ({ getStripe: () => mockStripe }));

const { previewPublish, publishToGateways } = require('../src/core/lib/gatewayCatalogService');

function tierRow(slug, vertical, priceOverrides = {}) {
  return {
    id: `t_${slug}`, slug, name: slug, vertical, isActive: true, isCustomPriced: false,
    prices: [{
      id: `p_${slug}`, countryCode: 'IN', currencyCode: 'INR',
      amountMonthlyMinor: 599000, amountAnnualMinor: 5990000,
      razorpayPlanIdMonthly: null, razorpayPlanIdAnnual: null, ...priceOverrides,
    }],
  };
}

beforeEach(() => { jest.clearAllMocks(); mockGw.isConfigured.mockReturnValue(true); });

describe('gatewayCatalogService — Razorpay publish', () => {
  test('preview computes create actions but mutates nothing', async () => {
    mockPrisma.pricingTier.findMany.mockResolvedValue([tierRow('professional', 'ECOMMERCE')]);
    const r = await previewPublish({ gateways: ['RAZORPAY'] });
    expect(r.dryRun).toBe(true);
    const rz = r.results.find((x) => x.gateway === 'RAZORPAY');
    expect(rz.rows).toHaveLength(2);
    expect(rz.rows.every((row) => row.status === 'preview' && row.action === 'create')).toBe(true);
    expect(mockGw.createPlan).not.toHaveBeenCalled();
    expect(mockPrisma.tierPrice.update).not.toHaveBeenCalled();
  });

  test('publish creates plans for new tiers and writes the ids back to TierPrice', async () => {
    mockPrisma.pricingTier.findMany.mockResolvedValue([tierRow('professional', 'ECOMMERCE')]);
    mockGw.createPlan.mockResolvedValueOnce({ id: 'plan_m' }).mockResolvedValueOnce({ id: 'plan_a' });
    const r = await publishToGateways({ gateways: ['RAZORPAY'] });
    expect(mockGw.createPlan).toHaveBeenCalledTimes(2);
    expect(mockPrisma.tierPrice.update).toHaveBeenCalledWith({ where: { id: 'p_professional' }, data: { razorpayPlanIdMonthly: 'plan_m' } });
    expect(mockPrisma.tierPrice.update).toHaveBeenCalledWith({ where: { id: 'p_professional' }, data: { razorpayPlanIdAnnual: 'plan_a' } });
    expect(r.summary.created).toBe(2);
  });

  test('reuses a gateway plan whose amount AND period already match (idempotent)', async () => {
    mockPrisma.pricingTier.findMany.mockResolvedValue([tierRow('professional', 'ECOMMERCE', { razorpayPlanIdMonthly: 'plan_existing_m', razorpayPlanIdAnnual: 'plan_existing_a' })]);
    mockGw.getPlan.mockImplementation(async (id) => (id === 'plan_existing_m'
      ? { item: { amount: 599000 }, period: 'monthly' }
      : { item: { amount: 5990000 }, period: 'yearly' }));
    const r = await publishToGateways({ gateways: ['RAZORPAY'] });
    expect(mockGw.createPlan).not.toHaveBeenCalled();
    expect(mockPrisma.tierPrice.update).not.toHaveBeenCalled();
    expect(r.summary.reused).toBe(2);
  });

  test('B11: recreates a plan whose amount matches but PERIOD drifted (monthly id in the annual slot)', async () => {
    mockPrisma.pricingTier.findMany.mockResolvedValue([tierRow('professional', 'ECOMMERCE', { razorpayPlanIdMonthly: 'plan_existing_m', razorpayPlanIdAnnual: 'plan_wrong_period' })]);
    // annual slot's stored plan has the right annual AMOUNT but a MONTHLY period
    mockGw.getPlan.mockImplementation(async (id) => (id === 'plan_existing_m'
      ? { item: { amount: 599000 }, period: 'monthly' }
      : { item: { amount: 5990000 }, period: 'monthly' }));
    mockGw.createPlan.mockResolvedValue({ id: 'plan_new_annual' });
    const r = await publishToGateways({ gateways: ['RAZORPAY'] });
    // monthly reused, annual re-minted because its period was wrong
    expect(mockGw.createPlan).toHaveBeenCalledTimes(1);
    expect(mockPrisma.tierPrice.update).toHaveBeenCalledWith({ where: { id: 'p_professional' }, data: { razorpayPlanIdAnnual: 'plan_new_annual' } });
    expect(r.summary.reused).toBe(1);
    expect(r.summary.created).toBe(1);
  });

  test('recreates when the existing plan amount has drifted', async () => {
    mockPrisma.pricingTier.findMany.mockResolvedValue([tierRow('professional', 'ECOMMERCE', { razorpayPlanIdMonthly: 'plan_old_m' })]);
    mockGw.getPlan.mockResolvedValue({ item: { amount: 100 } }); // stale amount
    mockGw.createPlan.mockResolvedValue({ id: 'plan_new' });
    const r = await publishToGateways({ gateways: ['RAZORPAY'] });
    expect(mockGw.createPlan).toHaveBeenCalledTimes(2); // monthly drifted + annual missing
    expect(r.summary.created).toBe(2);
  });

  test('skips a tier with no price row for the gateway country', async () => {
    mockPrisma.pricingTier.findMany.mockResolvedValue([{ id: 't_x', slug: 'x', name: 'x', vertical: 'STATIC', isActive: true, isCustomPriced: false, prices: [] }]);
    const r = await publishToGateways({ gateways: ['RAZORPAY'] });
    expect(r.summary.skipped).toBe(1);
    expect(mockGw.createPlan).not.toHaveBeenCalled();
  });
});

describe('gatewayCatalogService — Stripe publish', () => {
  test('creates a product + monthly/annual prices and writes the ids back', async () => {
    mockPrisma.pricingTier.findMany.mockResolvedValue([tierRow('professional', 'ECOMMERCE')]);
    mockStripe.products.create.mockResolvedValue({ id: 'prod_1' });
    mockStripe.prices.create.mockResolvedValueOnce({ id: 'price_m' }).mockResolvedValueOnce({ id: 'price_a' });
    const r = await publishToGateways({ gateways: ['STRIPE'] });
    expect(mockStripe.products.create).toHaveBeenCalledTimes(1);
    expect(mockStripe.prices.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.tierPrice.update).toHaveBeenCalledWith({ where: { id: 'p_professional' }, data: { stripePriceIdMonthly: 'price_m' } });
    expect(r.summary.created).toBe(2);
  });
});
