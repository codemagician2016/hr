'use strict';

/**
 * money.js — minor-unit money helpers for the payroll engine.
 *
 * MONEY RULE (non-negotiable):
 *   All money is INTEGER MINOR UNITS — paise for INR, cents for NZD — held as
 *   plain JS integers (safe to 2^53 - 1). NEVER floats for money. Rounding is
 *   applied ONLY at documented points, via the named modes below.
 *
 * This module is PURE: no DB, no I/O, no Date. It is unit-testable with plain
 * `node`. Every function asserts integer-ness so a stray float surfaces loudly
 * rather than corrupting a paise/cent.
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1

/** True if v is a finite, safe integer suitable as a minor-unit amount. */
function isMinor(v) {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/** Assert v is a safe integer minor-unit amount; throw with context otherwise. */
function assertMinor(v, label = 'amount') {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`Money ${label} must be a finite number, got ${typeof v}: ${String(v)}`);
  }
  if (!Number.isInteger(v)) {
    throw new TypeError(`Money ${label} must be an INTEGER minor unit (no floats), got ${v}`);
  }
  if (!Number.isSafeInteger(v)) {
    throw new RangeError(`Money ${label} exceeds safe integer range (2^53-1): ${v}`);
  }
  return v;
}

/**
 * Convert a major-unit value (e.g. rupees "1234.56") to integer minor units.
 * Accepts a number or a string. Uses string math to avoid float drift on the
 * fractional part. Throws if more than `scale` fractional digits are supplied
 * (we never silently drop sub-paise precision).
 *
 *   toMinor('1234.56') -> 123456
 *   toMinor(1500)      -> 150000
 */
function toMinor(major, scale = 2) {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) {
    throw new RangeError(`scale must be an integer 0..6, got ${scale}`);
  }
  let s;
  if (typeof major === 'number') {
    if (!Number.isFinite(major)) throw new TypeError(`toMinor: non-finite number ${major}`);
    // Render without exponent; numbers with >scale decimals are a precision error.
    s = stripExponent(major);
  } else if (typeof major === 'string') {
    s = major.trim();
  } else {
    throw new TypeError(`toMinor: expected number|string, got ${typeof major}`);
  }

  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new TypeError(`toMinor: cannot parse major value "${s}"`);
  const neg = m[1] === '-';
  const intPart = m[2];
  const fracPart = m[3] || '';
  if (fracPart.length > scale) {
    throw new RangeError(
      `toMinor: "${s}" has ${fracPart.length} fractional digits but scale is ${scale} (would lose precision)`
    );
  }
  const fracPadded = (fracPart + '0'.repeat(scale)).slice(0, scale);
  const combined = intPart + fracPadded;
  const value = Number(combined);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`toMinor: "${s}" overflows safe integer range`);
  }
  return neg ? -value : value;
}

/**
 * Render integer minor units as a major-unit decimal string (display/export).
 * Never used for further math.  fromMinor(123456) -> "1234.56"
 */
function fromMinor(minor, scale = 2) {
  assertMinor(minor, 'minor');
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) {
    throw new RangeError(`scale must be an integer 0..6, got ${scale}`);
  }
  const neg = minor < 0;
  const abs = Math.abs(minor).toString().padStart(scale + 1, '0');
  if (scale === 0) return (neg ? '-' : '') + abs;
  const intPart = abs.slice(0, abs.length - scale);
  const fracPart = abs.slice(abs.length - scale);
  return (neg ? '-' : '') + intPart + '.' + fracPart;
}

function stripExponent(n) {
  // Avoid "1e-7" style strings; for money we expect human-scale magnitudes.
  if (Number.isInteger(n)) return n.toString();
  // toFixed up to 6 then trim trailing zeros — used only to detect over-precision.
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** Sum a list of minor amounts. Pure; asserts each operand. */
function sumMinor(amounts) {
  if (!Array.isArray(amounts)) throw new TypeError('sumMinor: expected an array');
  let total = 0;
  for (const a of amounts) {
    assertMinor(a, 'addend');
    total += a;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('sumMinor: running total exceeds safe integer range');
    }
  }
  return total;
}

/** a - b in minor units, asserted. */
function subMinor(a, b) {
  assertMinor(a, 'minuend');
  assertMinor(b, 'subtrahend');
  const r = a - b;
  assertMinor(r, 'difference');
  return r;
}

/** Clamp a minor amount to [floor, cap] (either may be null/undefined to skip). */
function clampMinor(amount, { floorMinor = null, capMinor = null } = {}) {
  assertMinor(amount, 'amount');
  let v = amount;
  if (floorMinor != null) {
    assertMinor(floorMinor, 'floorMinor');
    if (v < floorMinor) v = floorMinor;
  }
  if (capMinor != null) {
    assertMinor(capMinor, 'capMinor');
    if (v > capMinor) v = capMinor;
  }
  return v;
}

/**
 * Rounding modes. Each takes an EXACT rational result expressed as a
 * numerator/denominator pair of integers and returns the rounded integer.
 * Working from a rational (not a float) is what guarantees exact paise.
 */
const RoundingMode = Object.freeze({
  HALF_UP: 'HALF_UP', // ties away from zero (standard commercial / IN default)
  HALF_EVEN: 'HALF_EVEN', // banker's rounding
  CEIL: 'CEIL', // toward +inf (e.g. IN ESI rounds up to next rupee)
  FLOOR: 'FLOOR', // toward -inf
  TRUNC: 'TRUNC', // toward zero
});

/**
 * Round an exact rational num/den to an integer per `mode`.
 * num and den must be integers; den must be a positive safe integer.
 */
function roundRational(num, den, mode = RoundingMode.HALF_UP) {
  if (!Number.isInteger(num) || !Number.isInteger(den)) {
    throw new TypeError('roundRational: num and den must be integers');
  }
  if (den <= 0) throw new RangeError('roundRational: den must be > 0');

  const neg = num < 0;
  const a = Math.abs(num);
  const q = Math.trunc(a / den); // magnitude quotient
  const r = a - q * den; // remainder in [0, den)
  if (r === 0) return applySign(q, neg);

  let up;
  switch (mode) {
    case RoundingMode.TRUNC:
      up = false;
      break;
    case RoundingMode.FLOOR:
      up = neg; // floor pushes negatives away from zero
      break;
    case RoundingMode.CEIL:
      up = !neg; // ceil pushes positives away from zero
      break;
    case RoundingMode.HALF_UP:
      up = r * 2 >= den;
      break;
    case RoundingMode.HALF_EVEN: {
      const twice = r * 2;
      if (twice > den) up = true;
      else if (twice < den) up = false;
      else up = q % 2 === 1; // exactly half -> round to even
      break;
    }
    default:
      throw new RangeError(`Unknown rounding mode: ${mode}`);
  }
  const mag = up ? q + 1 : q;
  return applySign(mag, neg);
}

function applySign(mag, neg) {
  return neg ? -mag : mag;
}

/**
 * Round an already-minor amount to a coarser unit step (e.g. nearest rupee =
 * 100 paise, nearest ₹10 = 1000 paise). Returns minor units.
 *
 *   roundToStep(184950, 100, 'HALF_UP') -> 185000  (nearest rupee)
 *   roundToStep(184950, 1000, 'CEIL')   -> 185000  (ceil to ₹10)
 */
function roundToStep(amountMinor, stepMinor, mode = RoundingMode.HALF_UP) {
  assertMinor(amountMinor, 'amount');
  assertMinor(stepMinor, 'step');
  if (stepMinor <= 0) throw new RangeError('roundToStep: step must be > 0');
  const steps = roundRational(amountMinor, stepMinor, mode);
  const r = steps * stepMinor;
  assertMinor(r, 'rounded');
  return r;
}

/** Round to nearest whole major unit (scale=2 -> step 100). Convenience. */
function roundToMajor(amountMinor, mode = RoundingMode.HALF_UP, scale = 2) {
  return roundToStep(amountMinor, Math.pow(10, scale), mode);
}

/**
 * percentOf — exact percentage of a minor base, rounded per mode.
 * `percent` is a number like 12 or 8.33; we convert it to an exact rational
 * (percent expressed with up to `pScale` decimals) so there is NO float in the
 * core multiplication. e.g. 12% of 5000000 paise -> 600000 paise exactly.
 *
 *   percentOf(5000000, 12)        -> 600000
 *   percentOf(1500000, 8.33)      -> 124950   (8.33% of ₹15,000 = ₹1,249.50)
 */
function percentOf(baseMinor, percent, mode = RoundingMode.HALF_UP, pScale = 6) {
  assertMinor(baseMinor, 'base');
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    throw new TypeError(`percentOf: percent must be a finite number, got ${percent}`);
  }
  // Express percent as integer numerator over 100 * 10^pScale.
  const scaleFactor = Math.pow(10, pScale);
  const percentNum = Math.round(percent * scaleFactor); // e.g. 8.33 -> 8330000
  const den = 100 * scaleFactor;
  // result = base * percentNum / den  (all integers; base*percentNum may be large)
  const numerator = baseMinor * percentNum;
  if (!Number.isSafeInteger(numerator)) {
    // Fall back to BigInt for the exact product, then round, then back to Number.
    return percentOfBig(baseMinor, percentNum, den, mode);
  }
  return roundRational(numerator, den, mode);
}

/** BigInt path for very large base × percent products; result still safe int. */
function percentOfBig(baseMinor, percentNum, den, mode) {
  const num = BigInt(baseMinor) * BigInt(percentNum);
  const d = BigInt(den);
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = a / d;
  const r = a - q * d;
  let up;
  const twiceR = r * 2n;
  switch (mode) {
    case RoundingMode.TRUNC: up = false; break;
    case RoundingMode.FLOOR: up = neg; break;
    case RoundingMode.CEIL: up = !neg; break;
    case RoundingMode.HALF_UP: up = twiceR >= d; break;
    case RoundingMode.HALF_EVEN:
      up = twiceR > d || (twiceR === d && q % 2n === 1n);
      break;
    default: throw new RangeError(`Unknown rounding mode: ${mode}`);
  }
  const mag = up ? q + 1n : q;
  const signed = neg ? -mag : mag;
  if (signed > BigInt(MAX_SAFE) || signed < BigInt(-MAX_SAFE)) {
    throw new RangeError('percentOf: result exceeds safe integer range');
  }
  return Number(signed);
}

/**
 * Apportion a total across weights so the parts sum EXACTLY to the total
 * (largest-remainder method). Used for distributing a rounded total or a
 * rounding residual without losing a paise.
 */
function apportion(totalMinor, weights, mode = RoundingMode.FLOOR) {
  assertMinor(totalMinor, 'total');
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new TypeError('apportion: weights must be a non-empty array');
  }
  const w = weights.map((x) => {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) {
      throw new TypeError('apportion: weights must be non-negative finite numbers');
    }
    return x;
  });
  const wSum = w.reduce((s, x) => s + x, 0);
  if (wSum === 0) {
    // No weights -> put everything in the first bucket.
    const out = w.map(() => 0);
    out[0] = totalMinor;
    return out;
  }
  // Base allocation by floor of exact share; track remainders.
  const raw = w.map((x) => (totalMinor * x) / wSum);
  const base = raw.map((x) => Math.trunc(x));
  let allocated = base.reduce((s, x) => s + x, 0);
  let residual = totalMinor - allocated;
  // Distribute the remaining units to the largest fractional remainders.
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.trunc(x) }))
    .sort((a, b) => b.frac - a.frac);
  const out = base.slice();
  let k = 0;
  const step = residual >= 0 ? 1 : -1;
  while (residual !== 0) {
    out[order[k % order.length].i] += step;
    residual -= step;
    k++;
  }
  return out;
}

module.exports = {
  MAX_SAFE,
  RoundingMode,
  isMinor,
  assertMinor,
  toMinor,
  fromMinor,
  sumMinor,
  subMinor,
  clampMinor,
  roundRational,
  roundToStep,
  roundToMajor,
  percentOf,
  apportion,
};
