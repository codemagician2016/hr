// Unit tests for the budget engine's pure helpers (no DB).
//
// Verifies the math matches the spec the user agreed to:
//   - $4 budget @ $0.04 SMS / $0.02 WA → 100 SMS or 200 WA
//   - if 200 WA spent → SMS count = 0
//   - if 50 SMS spent → WA remaining = 100
//   - geo-IP scaling: IN at $1.44 budget @ MSG91 $0.0024 → 600 SMS
//   - shared budget — SMS and WA counters drain inversely

const {
  getCurrentCycle,
  FX_TO_USD,
  ZERO_DEC_CURRENCIES,
  convertToUsd,
  deriveSlotCounts,
} = require('../../src/core/lib/notifications/budgetEngine');

describe('getCurrentCycle', () => {
  test('returns YYYY-MM string for given date', () => {
    expect(getCurrentCycle(new Date('2026-04-29T12:00:00Z'))).toBe('2026-04');
    expect(getCurrentCycle(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    expect(getCurrentCycle(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });

  test('uses UTC, not local time', () => {
    // Jan 1 2026 00:30 UTC is still 2026-01 regardless of timezone
    expect(getCurrentCycle(new Date('2026-01-01T00:30:00Z'))).toBe('2026-01');
  });
});

describe('FX_TO_USD', () => {
  test('USD is 1', () => {
    expect(FX_TO_USD.USD).toBe(1);
  });

  test('major currencies all defined', () => {
    const required = ['EUR', 'GBP', 'INR', 'BRL', 'AUD', 'CAD', 'JPY', 'KRW', 'CNY', 'MXN', 'ZAR'];
    // Every value must be a finite positive number
    for (const code of ['USD', 'EUR', 'GBP', 'INR', 'BRL', 'AUD', 'CAD', 'JPY', 'KRW', 'MXN', 'ZAR']) {
      expect(FX_TO_USD[code]).toBeGreaterThan(0);
      expect(Number.isFinite(FX_TO_USD[code])).toBe(true);
    }
  });

  test('zero-decimal currencies set is plausible', () => {
    expect(ZERO_DEC_CURRENCIES.has('JPY')).toBe(true);
    expect(ZERO_DEC_CURRENCIES.has('KRW')).toBe(true);
    expect(ZERO_DEC_CURRENCIES.has('USD')).toBe(false);
  });
});

describe('convertToUsd', () => {
  test('USD → USD passthrough (×1)', () => {
    // $19 in minor units (1900 cents) → $19
    expect(convertToUsd(1900, 'USD')).toBeCloseTo(19, 4);
  });

  test('EUR conversion (×1.07 by default)', () => {
    // €17 (1700 minor) → ~$18.19
    expect(convertToUsd(1700, 'EUR')).toBeCloseTo(17 * FX_TO_USD.EUR, 4);
  });

  test('INR with 2 decimal handling — ₹599 = 59900 minor', () => {
    // ₹599 → $7.19 (at 0.012)
    expect(convertToUsd(59900, 'INR')).toBeCloseTo(599 * FX_TO_USD.INR, 4);
  });

  test('JPY zero-decimal — ¥1900 stored as 1900 (whole units)', () => {
    expect(convertToUsd(1900, 'JPY')).toBeCloseTo(1900 * FX_TO_USD.JPY, 4);
  });

  test('KRW zero-decimal', () => {
    expect(convertToUsd(19000, 'KRW')).toBeCloseTo(19000 * FX_TO_USD.KRW, 4);
  });

  test('unknown currency returns 0 (safe default)', () => {
    expect(convertToUsd(1000, 'XYZ')).toBe(0);
  });

  test('case-insensitive currency code', () => {
    expect(convertToUsd(1900, 'usd')).toBe(19);
    expect(convertToUsd(1700, 'eur')).toBeCloseTo(17 * FX_TO_USD.EUR, 4);
  });

  test('zero / negative input returns 0', () => {
    expect(convertToUsd(0, 'USD')).toBe(0);
    expect(convertToUsd(-100, 'USD')).toBe(0);
  });

  test('NaN / null safe', () => {
    expect(convertToUsd(NaN, 'USD')).toBe(0);
    expect(convertToUsd(null, 'USD')).toBe(0);
    expect(convertToUsd(undefined, 'USD')).toBe(0);
  });
});

describe("deriveSlotCounts — user's spec from 2026-04-29", () => {
  test('$4 budget @ $0.04 SMS / $0.02 WA = 100 SMS / 200 WA', () => {
    const r = deriveSlotCounts({
      budget: 4,
      smsCost: 0.04,
      waCost: 0.02,
      spent: 0,
    });
    expect(r.sms).toBe(100);
    expect(r.smsTotal).toBe(100);
    expect(r.whatsappUtility).toBe(200);
    expect(r.whatsappUtilityTotal).toBe(200);
  });

  test('if 200 WA spent ($4 worth) → SMS = 0, WA = 0', () => {
    const r = deriveSlotCounts({
      budget: 4,
      smsCost: 0.04,
      waCost: 0.02,
      spent: 4, // burned the whole budget on WA (200 × $0.02)
    });
    expect(r.sms).toBe(0);
    expect(r.whatsappUtility).toBe(0);
    expect(r.remainingUsd).toBe(0);
  });

  test('if 50 SMS spent ($2 worth) → SMS remaining = 50, WA remaining = 100', () => {
    const r = deriveSlotCounts({
      budget: 4,
      smsCost: 0.04,
      waCost: 0.02,
      spent: 2, // 50 SMS × $0.04 = $2
    });
    expect(r.sms).toBe(50);
    expect(r.whatsappUtility).toBe(100);
    expect(r.smsTotal).toBe(100); // start cap is preserved
    expect(r.whatsappUtilityTotal).toBe(200);
  });

  test('IN budget: $1.44 @ MSG91 $0.0024 SMS = 600 SMS', () => {
    const r = deriveSlotCounts({
      budget: 1.44,
      smsCost: 0.0024,
      waCost: 0.0079,
      spent: 0,
    });
    expect(r.sms).toBe(600);
    expect(r.whatsappUtility).toBe(182);
  });

  test('US budget: $3.80 @ Twilio US $0.0079 SMS = 481 SMS', () => {
    const r = deriveSlotCounts({
      budget: 3.80,
      smsCost: 0.0079,
      waCost: 0.0079,
      spent: 0,
    });
    expect(r.sms).toBe(481);
    expect(r.whatsappUtility).toBe(481);
  });

  test('Korea budget: $2.80 @ Twilio KR $0.20 SMS — small SMS quota → hidden by minSlotsFloor', () => {
    const r = deriveSlotCounts({
      budget: 2.80,
      smsCost: 0.2057,
      waCost: 0.0118,
      spent: 0,
    });
    expect(r.sms).toBe(13); // floor(2.80 / 0.2057) = 13
    expect(r.smsAvailable).toBe(true); // 13 ≥ 10 floor
    expect(r.whatsappUtility).toBe(237);
  });

  test('country with no SMS provider (smsCost = null) → SMS unavailable', () => {
    const r = deriveSlotCounts({
      budget: 5,
      smsCost: null,
      waCost: 0.05,
      spent: 0,
    });
    expect(r.sms).toBe(0);
    expect(r.smsAvailable).toBe(false);
    expect(r.whatsappUtility).toBe(100);
    expect(r.whatsappAvailable).toBe(true);
  });

  test('zero budget (Solo tier) → both channels unavailable', () => {
    const r = deriveSlotCounts({
      budget: 0,
      smsCost: 0.04,
      waCost: 0.02,
      spent: 0,
    });
    expect(r.sms).toBe(0);
    expect(r.whatsappUtility).toBe(0);
    expect(r.smsAvailable).toBe(false);
    expect(r.whatsappAvailable).toBe(false);
  });

  test('overage scenarios — spent > budget → 0 (never negative)', () => {
    const r = deriveSlotCounts({
      budget: 4,
      smsCost: 0.04,
      waCost: 0.02,
      spent: 10, // overage purchase happened mid-cycle, spent more than baseline
    });
    expect(r.sms).toBe(0);
    expect(r.whatsappUtility).toBe(0);
    expect(r.remainingUsd).toBe(0);
  });

  test('minSlotsFloor parameter — channel hidden if start count too low', () => {
    // Korea + Starter tier with low budget — only 5 SMS would work, hide
    const r = deriveSlotCounts({
      budget: 1,
      smsCost: 0.2057,
      waCost: 0.0118,
      spent: 0,
      minSlotsFloor: 10,
    });
    expect(r.sms).toBe(4); // floor(1 / 0.2057) = 4
    expect(r.smsAvailable).toBe(false); // 4 < 10 floor
    expect(r.whatsappUtility).toBe(84);
    expect(r.whatsappAvailable).toBe(true);
  });
});

describe('deriveSlotCounts — shared budget invariant', () => {
  test('total spent never exceeds budget regardless of channel mix', () => {
    // Send 30 SMS, then 50 WA — verify counters
    const budget = 4;
    let spent = 0;

    // 30 SMS = $1.20 spent
    spent += 30 * 0.04;
    let r = deriveSlotCounts({ budget, smsCost: 0.04, waCost: 0.02, spent });
    expect(r.sms).toBe(70);            // 100 - 30
    expect(r.whatsappUtility).toBe(140); // (4 - 1.20) / 0.02

    // Then 50 WA = $1 more
    spent += 50 * 0.02;
    r = deriveSlotCounts({ budget, smsCost: 0.04, waCost: 0.02, spent });
    expect(r.sms).toBe(45);            // (4 - 2.20) / 0.04
    expect(r.whatsappUtility).toBe(90);  // (4 - 2.20) / 0.02
    expect(r.spentUsd).toBe(2.20);
    expect(r.remainingUsd).toBe(1.80);
  });
});
