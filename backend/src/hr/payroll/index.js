'use strict';

/**
 * payroll-core public API.
 *
 * Country-agnostic payroll engine per docs/04-payroll-engine-design.md.
 * Composed of pure-compute modules (money, engine) + a registry seam + a
 * lifecycle state machine with thin prisma persistence (payrun).
 *
 * Country compliance modules (IN/NZ) are self-contained, pure, and registered
 * via registerComplianceModule — the core never imports them by name.
 */

const money = require('./money');
const engine = require('./engine');
const payrun = require('./payrun');
const registry = require('./complianceRegistry');

module.exports = {
  // ── money (pure minor-unit helpers) ──
  money,
  toMinor: money.toMinor,
  fromMinor: money.fromMinor,
  sumMinor: money.sumMinor,
  percentOf: money.percentOf,
  roundToStep: money.roundToStep,
  RoundingMode: money.RoundingMode,

  // ── engine (pure computePayslip) ──
  computePayslip: engine.computePayslip,
  CATEGORY: engine.CATEGORY,
  PRORATION: engine.PRORATION,
  LOP_BEHAVIOR: engine.LOP_BEHAVIOR,
  CALC: engine.CALC,

  // ── compliance registry (the plug-in seam) ──
  registerComplianceModule: registry.registerComplianceModule,
  resolveComplianceModule: registry.resolveComplianceModule,
  hasComplianceModule: registry.hasComplianceModule,
  listRegistered: registry.listRegistered,

  // ── pay-run state machine + persistence ──
  STATE: payrun.STATE,
  PayRunError: payrun.PayRunError,
  transition: payrun.transition,
  canTransition: payrun.canTransition,
  nextStates: payrun.nextStates,
  isTerminal: payrun.isTerminal,
  computeInputHash: payrun.computeInputHash,
  canonicalJSON: payrun.canonicalJSON,
  assertIdempotentCompute: payrun.assertIdempotentCompute,
  persistTransition: payrun.persistTransition,
  persistComputeResult: payrun.persistComputeResult,

  // sub-namespaces for advanced use
  engine,
  payrun,
  registry,
};
