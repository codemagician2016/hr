const { deriveRestaurantPaymentState } = require('../src/booking/controllers/restaurant.controller');

describe('restaurant payment state', () => {
  test('marks a fully paid walk-in bill as paid', () => {
    expect(deriveRestaurantPaymentState({ finalPrice: 80, paidAmount: 80 })).toEqual({
      finalPrice: 80,
      paidAmount: 80,
      paymentStatus: 'PAID',
    });
  });

  test('marks partial restaurant payments as partial', () => {
    expect(deriveRestaurantPaymentState({ finalPrice: 120, paidAmount: 50 })).toEqual({
      finalPrice: 120,
      paidAmount: 50,
      paymentStatus: 'PARTIAL',
    });
  });

  test('falls back to required deposit when no bill total is entered', () => {
    expect(deriveRestaurantPaymentState({ payableNow: 25, paidAmount: 0 })).toEqual({
      finalPrice: 25,
      paidAmount: 0,
      paymentStatus: 'UNPAID',
    });
  });
});
