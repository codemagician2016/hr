'use strict';

/**
 * consumers.js — Feature 10. The engine never knows leave-balance or expense
 * semantics. Each consuming module registers a callback bundle keyed by its
 * WorkflowModule; the engine fires the matching callback at the right transition.
 *
 *   register(module, { onApprove, onReject, onCancel })
 *   get(module) -> bundle | null
 *
 * Callback contract — each is `(approvalRequest, tx) => Promise<void>`, called
 * INSIDE the engine's transaction so the domain effect (release a leave soft-hold,
 * flip ExpenseClaim.status, …) commits atomically with the approval transition:
 *
 *   onApprove(req, tx)  fired when the whole chain completes APPROVED.
 *   onReject(req, tx)   fired when any level REJECTS (terminal).
 *   onCancel(req, tx)   fired on requester cancel/withdraw (release holds).
 *
 * Leave + expense are wired here in slice 10c (NOT 10a/10b). Registering is
 * idempotent + side-effect-free at module load. A module with no registered
 * consumer still routes through the engine; its callbacks are simply no-ops, so
 * the engine is fully operable via API/Postman before any consumer is wired.
 */

const registry = new Map();

function register(module, bundle) {
  if (!module) throw new Error('consumers.register requires a module');
  registry.set(module, {
    onApprove: (bundle && bundle.onApprove) || null,
    onReject: (bundle && bundle.onReject) || null,
    onCancel: (bundle && bundle.onCancel) || null,
  });
  return registry.get(module);
}

function get(module) {
  return registry.get(module) || null;
}

// Fire one callback if registered. Swallows "not registered" (no-op) but lets a
// real consumer error propagate so the engine transaction rolls back together.
async function fire(module, hook, approvalRequest, tx) {
  const bundle = registry.get(module);
  if (!bundle || typeof bundle[hook] !== 'function') return;
  await bundle[hook](approvalRequest, tx);
}

function clear() { registry.clear(); } // test helper

module.exports = { register, get, fire, clear, _registry: registry };
