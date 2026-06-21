const { calculateRestaurantBoardStats } = require('../src/booking/controllers/restaurant.controller');

describe('restaurant board stats', () => {
  test('summarizes covers, money, and table utilization for active service', () => {
    const stats = calculateRestaurantBoardStats([
      {
        arrivalStatus: 'RESERVED',
        partySize: 4,
        finalPrice: 100,
        paidAmount: 25,
        guestPhone: '555-0100',
        occasion: 'Birthday',
        tables: [{ id: 't1' }],
      },
      {
        arrivalStatus: 'SEATED',
        partySize: 2,
        finalPrice: 80,
        paidAmount: 80,
        guestEmail: 'guest@example.com',
        dietaryNotes: 'Gluten free',
        tables: [{ id: 't2' }],
      },
      {
        arrivalStatus: 'NO_SHOW',
        partySize: 6,
        finalPrice: 0,
        paidAmount: 0,
        tables: [{ id: 't3' }],
      },
    ], { activeTableCount: 4 });

    expect(stats).toMatchObject({
      total: 3,
      active: 2,
      covers: 6,
      reserved: 1,
      seated: 1,
      noShows: 1,
      paymentDue: 1,
      totalRevenue: 180,
      paidRevenue: 105,
      balanceDue: 75,
      seatedTableCount: 1,
      tableUtilization: 25,
      averagePartySize: 3,
      revenuePerCover: 17.5,
      knownGuestContacts: 2,
      guestNotesCaptured: 2,
    });
  });
});
