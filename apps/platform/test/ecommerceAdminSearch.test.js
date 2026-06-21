import { describe, expect, test } from 'vitest';
import { buildEcommerceAdminSearchResults } from '../lib/ecommerceAdminSearch.js';

const navItems = [
  { key: 'overview', label: 'Overview', sub: 'Dashboard' },
  { key: 'orders', label: 'Fulfillment', sub: 'Orders, dispatch, pickup' },
  { key: 'products', label: 'Products', sub: 'Catalog + inventory' },
  { key: 'inventory', label: 'Inventory', sub: 'Stock by location' },
  { key: 'customers', label: 'Customers', sub: 'Customer retention' },
  { key: 'ecom-coupons', label: 'Coupons', sub: 'Discount codes' },
  { key: 'banners', label: 'Banners', sub: 'Hero promos' },
  { key: 'cms', label: 'CMS', sub: 'Storefront content blocks' },
  { key: 'ecom-notifications', label: 'Notifications', sub: 'Email + SMS + WhatsApp templates' },
  { key: 'reviews', label: 'Reviews', sub: 'Ratings + customer feedback' },
  { key: 'payments', label: 'Payments', sub: 'Settlements + gateway fees' },
  { key: 'ecom-reports', label: 'Reports', sub: 'Sales, basket, inventory analytics' },
  { key: 'tax', label: 'Tax', sub: 'UK VAT + Indian GST + invoicing' },
  { key: 'subscription', label: 'Billing & Plan', sub: 'Plan and limits' },
];

describe('ecommerce admin top search', () => {
  test('empty search opens useful admin shortcuts', () => {
    const results = buildEcommerceAdminSearchResults({ navItems, query: '' });

    expect(results.slice(0, 4).map((result) => result.key)).toEqual(['products', 'orders', 'inventory', 'customers']);
    expect(results.every((result) => result.type === 'nav')).toBe(true);
  });

  test('order-like query searches orders instead of only opening the nav item', () => {
    const [first] = buildEcommerceAdminSearchResults({ navItems, query: 'order 1001' });

    expect(first).toMatchObject({ type: 'search', key: 'orders' });
    expect(first.label).toContain('order 1001');
  });

  test('coupon queries use the ecommerce coupon tab key', () => {
    const [first] = buildEcommerceAdminSearchResults({ navItems, query: 'coupon fresh30' });

    expect(first).toMatchObject({ type: 'search', key: 'ecom-coupons' });
  });

  test('business/admin nav queries still open matching admin areas first', () => {
    const [first] = buildEcommerceAdminSearchResults({ navItems, query: 'billing' });

    expect(first).toMatchObject({ type: 'nav', key: 'subscription' });
  });

  test('current searchable panel is preferred for generic terms', () => {
    const [first] = buildEcommerceAdminSearchResults({ navItems, query: 'nishant', activeKey: 'customers' });

    expect(first).toMatchObject({ type: 'search', key: 'customers' });
  });

  test('finance opens finance admin panels instead of product search', () => {
    const results = buildEcommerceAdminSearchResults({ navItems, query: 'finance', activeKey: 'payments' });

    expect(results.slice(0, 3).map((result) => result.key)).toEqual(['payments', 'ecom-reports', 'tax']);
    expect(results[0]).toMatchObject({ type: 'nav', eyebrow: 'Finance' });
  });

  test('marketing opens marketing admin panels', () => {
    const results = buildEcommerceAdminSearchResults({ navItems, query: 'marketing' });

    expect(results.slice(0, 5).map((result) => result.key)).toEqual(['ecom-coupons', 'banners', 'cms', 'ecom-notifications', 'reviews']);
    expect(results[0]).toMatchObject({ type: 'nav', eyebrow: 'Marketing' });
  });

  test('gateway keywords open payments', () => {
    expect(buildEcommerceAdminSearchResults({ navItems, query: 'razorpay' })[0]).toMatchObject({ type: 'nav', key: 'payments' });
    expect(buildEcommerceAdminSearchResults({ navItems, query: 'stripe connect' })[0]).toMatchObject({ type: 'nav', key: 'payments' });
  });

  test('platform billing keywords open billing plan', () => {
    const [first] = buildEcommerceAdminSearchResults({ navItems, query: 'paddle mor' });

    expect(first).toMatchObject({ type: 'nav', key: 'subscription' });
  });

  test('tax keywords open tax', () => {
    const [first] = buildEcommerceAdminSearchResults({ navItems, query: 'gst' });

    expect(first).toMatchObject({ type: 'nav', key: 'tax' });
  });
});
