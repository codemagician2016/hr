const { findTablesForSlot } = require('../src/booking/controllers/restaurant.controller');

const tables = [
  { id: 'bar-2', label: 'Bar 2', areaId: 'bar', minCovers: 1, maxCovers: 2, isActive: true, onlineBookable: true },
  { id: 'main-2', label: 'Table 2', areaId: 'main', minCovers: 1, maxCovers: 2, isActive: true, onlineBookable: true },
  { id: 'main-4', label: 'Table 4', areaId: 'main', minCovers: 2, maxCovers: 4, isActive: true, onlineBookable: true },
  { id: 'main-6', label: 'Table 6', areaId: 'main', minCovers: 4, maxCovers: 6, isActive: true, onlineBookable: true },
];

function reservation({ partySize = 2, startTime = '18:00', endTime = '19:30', tableId = 'main-2' } = {}) {
  return {
    partySize,
    appointment: { startTime, endTime },
    tableAssignments: [{ tableId }],
  };
}

describe('restaurant table assignment', () => {
  test('prefers the smallest available table that fits the party', () => {
    const result = findTablesForSlot({
      tables,
      reservations: [],
      period: {},
      partySize: 3,
      startMin: 18 * 60,
      endMin: 19 * 60 + 30,
    });

    expect(result.map((table) => table.id)).toEqual(['main-4', 'main-6']);
  });

  test('blocks tables assigned to overlapping reservations', () => {
    const result = findTablesForSlot({
      tables,
      reservations: [reservation({ tableId: 'main-4', startTime: '18:30', endTime: '20:00' })],
      period: {},
      partySize: 3,
      startMin: 19 * 60,
      endMin: 20 * 60 + 30,
    });

    expect(result.map((table) => table.id)).toEqual(['main-6']);
  });

  test('allows the same table after the existing turn has ended', () => {
    const result = findTablesForSlot({
      tables,
      reservations: [reservation({ tableId: 'main-4', startTime: '18:00', endTime: '19:30' })],
      period: {},
      partySize: 3,
      startMin: 19 * 60 + 30,
      endMin: 21 * 60,
    });

    expect(result.map((table) => table.id)).toEqual(['main-4', 'main-6']);
  });

  test('respects service period area and cover flow limits', () => {
    const result = findTablesForSlot({
      tables,
      reservations: [reservation({ partySize: 4, tableId: 'main-4', startTime: '18:00', endTime: '19:30' })],
      period: { areaId: 'main', flowCoverLimit: 5 },
      partySize: 2,
      startMin: 18 * 60 + 30,
      endMin: 20 * 60,
    });

    expect(result).toEqual([]);
  });

  test('keeps offline tables available for host stand use only', () => {
    const offlineTable = { id: 'chef-2', label: 'Chef 2', minCovers: 1, maxCovers: 2, isActive: true, onlineBookable: false };

    expect(findTablesForSlot({
      tables: [offlineTable],
      reservations: [],
      period: {},
      partySize: 2,
      startMin: 18 * 60,
      endMin: 19 * 60 + 30,
    })).toEqual([]);

    expect(findTablesForSlot({
      tables: [offlineTable],
      reservations: [],
      period: {},
      partySize: 2,
      startMin: 18 * 60,
      endMin: 19 * 60 + 30,
      requireOnline: false,
    })).toEqual([offlineTable]);
  });

  test('respects online inventory percentage for public pacing', () => {
    const result = findTablesForSlot({
      tables,
      reservations: [],
      period: { onlineInventoryPercent: 50 },
      partySize: 2,
      startMin: 18 * 60,
      endMin: 19 * 60 + 30,
    });

    expect(result.map((table) => table.id)).toEqual(['bar-2', 'main-2']);
  });

  test('allows service periods to reserve zero inventory for public booking', () => {
    expect(findTablesForSlot({
      tables,
      reservations: [],
      period: { onlineInventoryPercent: 0 },
      partySize: 2,
      startMin: 18 * 60,
      endMin: 19 * 60 + 30,
    })).toEqual([]);
  });
});
