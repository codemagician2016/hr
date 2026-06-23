'use strict';

/**
 * conditions.js — Feature 10 §5.2. PURE evaluator for WorkflowStep.conditionJson.
 *
 *   matches(conditionJson, ctx) -> boolean
 *     ctx = { amount, currencyCode, categoryCode, departmentId, employeeLevel,
 *             locationId, days }
 *
 * A small, auditable grammar — NO code-eval, NO regex injection. A fixed key
 * whitelist + a fixed operator whitelist. The shape is:
 *
 *   {}                                    → always matches (no condition)
 *   { amount: { ">": 50000 } }            → amount > 50000
 *   { days: { ">=": 5 } }                 → days >= 5
 *   { categoryCode: { in: ["TRAVEL"] } }  → categoryCode ∈ set
 *   { departmentId: { in: [...] } }
 *   { employeeLevel: { in: ["M1","M2"] } }
 *   { amount:{">":1000}, categoryCode:{in:["CLIENT"]} } → implicit AND across keys
 *   { any: [ {...}, {...} ] }             → OR of sub-conditions
 *
 * Fail-closed (§9.6): an unknown key, an unknown operator, a malformed shape, or a
 * non-comparable value makes the whole condition evaluate to FALSE (the step is
 * treated as "does not apply" / skipped). The builder validates conditions at save
 * (validateCondition), so a false here is a defence-in-depth backstop, not a normal
 * path. Never throws on bad input — a corrupt condition can never deadlock a chain.
 */

// The only request-context keys a condition may reference.
const ALLOWED_KEYS = new Set([
  'amount', 'currencyCode', 'categoryCode', 'departmentId',
  'employeeLevel', 'locationId', 'days',
]);

// Numeric comparators (operate on Number(ctx[key])).
const NUMERIC_OPS = new Set(['>', '>=', '<', '<=']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return NaN;
  // Decimal columns surface as strings/Decimal; coerce defensively.
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// Evaluate ONE { key: predicate } leaf. Returns boolean; fail-closed on any
// malformed input.
function matchLeaf(key, predicate, ctx) {
  if (!ALLOWED_KEYS.has(key)) return false;        // unknown key ⇒ fail closed
  if (!isPlainObject(predicate)) return false;     // predicate must be an operator map

  const entries = Object.entries(predicate);
  if (entries.length === 0) return false;          // empty predicate ⇒ fail closed

  // ALL operators on the same key must hold (e.g. {">":1,"<":10} = range).
  for (const [op, operand] of entries) {
    if (op === 'eq') {
      // strict-ish equality; numbers compared numerically, else ===.
      const lhs = ctx[key];
      if (typeof operand === 'number' || typeof lhs === 'number') {
        const a = toNumber(lhs); const b = toNumber(operand);
        if (Number.isNaN(a) || Number.isNaN(b) || a !== b) return false;
      } else if (lhs !== operand) {
        return false;
      }
      continue;
    }
    if (op === 'in') {
      if (!Array.isArray(operand)) return false;
      const lhs = ctx[key];
      if (lhs === null || lhs === undefined) return false;
      if (!operand.includes(lhs)) return false;
      continue;
    }
    if (NUMERIC_OPS.has(op)) {
      const a = toNumber(ctx[key]);
      const b = toNumber(operand);
      if (Number.isNaN(a) || Number.isNaN(b)) return false; // non-comparable ⇒ fail closed
      if (op === '>' && !(a > b)) return false;
      if (op === '>=' && !(a >= b)) return false;
      if (op === '<' && !(a < b)) return false;
      if (op === '<=' && !(a <= b)) return false;
      continue;
    }
    return false; // unknown operator ⇒ fail closed
  }
  return true;
}

/**
 * matches(conditionJson, ctx) -> boolean
 * Null/undefined/empty condition ⇒ true (no gating). Otherwise an implicit AND
 * across keys, with an optional top-level { any: [...] } OR. Never throws.
 */
function matches(conditionJson, ctx) {
  try {
    if (conditionJson === null || conditionJson === undefined) return true;
    if (!isPlainObject(conditionJson)) return false; // malformed ⇒ fail closed
    const keys = Object.keys(conditionJson);
    if (keys.length === 0) return true; // {} = always

    const safeCtx = isPlainObject(ctx) ? ctx : {};

    for (const key of keys) {
      if (key === 'any') {
        const arr = conditionJson.any;
        if (!Array.isArray(arr) || arr.length === 0) return false; // malformed OR ⇒ fail closed
        const anyHit = arr.some((sub) => matches(sub, safeCtx));
        if (!anyHit) return false;
        continue;
      }
      if (!matchLeaf(key, conditionJson[key], safeCtx)) return false;
    }
    return true;
  } catch (_e) {
    return false; // any unexpected error ⇒ fail closed
  }
}

/**
 * validateCondition(conditionJson) -> { ok, error? }
 * Save-time validation for the builder (PUT /steps). Stricter than `matches`:
 * rejects unknown keys/operators up front so a bad condition never silently
 * skips a step at runtime. Null/{} are valid (no condition).
 */
function validateCondition(conditionJson) {
  if (conditionJson === null || conditionJson === undefined) return { ok: true };
  if (!isPlainObject(conditionJson)) return { ok: false, error: 'condition must be an object' };
  for (const [key, val] of Object.entries(conditionJson)) {
    if (key === 'any') {
      if (!Array.isArray(val) || val.length === 0) return { ok: false, error: '"any" must be a non-empty array' };
      for (const sub of val) {
        const r = validateCondition(sub);
        if (!r.ok) return r;
      }
      continue;
    }
    if (!ALLOWED_KEYS.has(key)) return { ok: false, error: `Unknown condition key "${key}"` };
    if (!isPlainObject(val)) return { ok: false, error: `Condition "${key}" must map to an operator object` };
    const ops = Object.keys(val);
    if (ops.length === 0) return { ok: false, error: `Condition "${key}" has no operator` };
    for (const op of ops) {
      const isKnown = op === 'eq' || op === 'in' || NUMERIC_OPS.has(op);
      if (!isKnown) return { ok: false, error: `Unknown operator "${op}" on "${key}"` };
      if (op === 'in' && !Array.isArray(val[op])) return { ok: false, error: `Operator "in" on "${key}" requires an array` };
      if (NUMERIC_OPS.has(op) && !Number.isFinite(Number(val[op]))) {
        return { ok: false, error: `Operator "${op}" on "${key}" requires a number` };
      }
    }
  }
  return { ok: true };
}

module.exports = { matches, validateCondition, ALLOWED_KEYS };
