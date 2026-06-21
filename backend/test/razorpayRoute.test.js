const razorpay = require('../src/core/lib/razorpayRoute');

describe('razorpayRoute helper', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
    global.fetch = jest.fn(async (_url, init) => ({
      ok: true,
      json: async () => ({
        id: 'acc_prd_123',
        product_name: 'route',
        activation_status: 'needs_clarification',
        requirements: [],
        body: init?.body ? JSON.parse(init.body) : null,
      }),
    }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('requests Route product using Razorpay tnc_accepted flag', async () => {
    const result = await razorpay.requestRouteProduct('acc_123');

    expect(result).toMatchObject({ ok: true, productId: 'acc_prd_123' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.razorpay.com/v2/accounts/acc_123/products',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ product_name: 'route', tnc_accepted: true }),
      })
    );
  });

  test('updates Route product with settlement account configuration only', async () => {
    await razorpay.updateRouteProduct('acc_123', 'acc_prd_123', {
      settlements: {
        account_number: '1234567890',
        ifsc_code: 'HDFC0000317',
        beneficiary_name: 'Example Store',
      },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.razorpay.com/v2/accounts/acc_123/products/acc_prd_123',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          settlements: {
            account_number: '1234567890',
            ifsc_code: 'HDFC0000317',
            beneficiary_name: 'Example Store',
          },
          tnc_accepted: true,
        }),
      })
    );
  });

  test('normalizes Route product list responses', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        items: [
          { id: 'acc_prd_route', product_name: 'route', activation_status: 'activated' },
          { id: 'acc_prd_other', product_name: 'payment_gateway' },
        ],
      }),
    }));

    const products = await razorpay.listRouteProducts('acc_123');

    expect(products.products).toHaveLength(1);
    expect(products.products[0]).toMatchObject({
      productId: 'acc_prd_route',
      activationStatus: 'activated',
    });
  });
});
