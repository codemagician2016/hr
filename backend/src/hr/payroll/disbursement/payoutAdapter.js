'use strict';

/**
 * payoutAdapter.js — the PLUGGABLE payout-gateway seam for India salary
 * disbursement. Same shape as the attendance faceMatcher.js seam: a default stub
 * + a documented interface a real provider (RazorpayX / Cashfree Payouts) drops
 * into, registered at boot behind an env flag. Nothing else in the disbursement
 * path changes — it only ever calls getAdapter().createPayout()/getStatus().
 *
 * INTERFACE (every adapter implements):
 *
 *   isConfigured() -> Boolean
 *     // True only when the provider's credentials are present in the env. The
 *     // service uses this to decide whether the gateway path is even offered;
 *     // when false the operator uses the bank-file path (the default product).
 *
 *   createPayout(batch, lines, opts) -> Promise<{
 *     status:   'QUEUED'|'PROCESSING'|'NEEDS_MANUAL'|'FAILED',
 *     provider: String,                 // 'stub' | 'razorpayx' | 'cashfree'
 *     gatewayBatchId: String|null,      // provider's batch/transfer id (for reconcile)
 *     lines:    [{ employeeId, status:'PENDING'|'CREDITED'|'FAILED', utr?, failureReason? }],
 *     message:  String,                 // human-readable (operator banner)
 *   }>
 *     // batch = { id, totalMinor, count, valueDate, debitAccount }
 *     // lines = [{ id, employeeId, amountMinor, beneficiaryName, accountNumber, ifsc }]
 *
 *   getStatus(gatewayBatchId, opts) -> Promise<{
 *     provider: String,
 *     batchStatus: 'QUEUED'|'PROCESSING'|'PARTIAL'|'CREDITED'|'FAILED'|'UNKNOWN',
 *     lines: [{ employeeId|account, status:'PENDING'|'CREDITED'|'FAILED'|'RETURNED', utr?, failureReason? }],
 *   }>
 *
 * ── WHICH IMPLEMENTATION SHIPS (v1) ──────────────────────────────────────────
 * The DEFAULT and only registered adapter is **stubAdapter**: it returns
 * NEEDS_MANUAL (the bank-file path is the configured product). No live API keys
 * are hardcoded anywhere; the example RazorpayX/Cashfree adapters READ credentials
 * from env (RAZORPAYX_KEY_ID/.. , CASHFREE_CLIENT_ID/..) and no-op gracefully —
 * isConfigured() returns false and createPayout() returns NEEDS_MANUAL — when the
 * env is absent. Live gateway calls are intentionally NOT implemented in v1
 * (NOTED): the seam exists so a real provider can be wired without touching the
 * service. The reconcile path (UTR/status CSV upload) works independently of any
 * gateway and is the supported reconciliation route today.
 *
 * ── SWAPPING IN A REAL ADAPTER ───────────────────────────────────────────────
 * Drop a module exporting { isConfigured, createPayout, getStatus } and call
 * registerAdapter(impl) at boot (e.g. behind PAYOUT_GATEWAY=razorpayx once the
 * SDK + keys are present). The example adapters below show the credential read +
 * the call shape; their network calls are left as a documented TODO.
 */

// ── stub adapter (the default v1 impl) ───────────────────────────────────────
const stubAdapter = {
  id: 'stub',
  isConfigured() {
    return false; // bank-file path is the product; no gateway wired by default.
  },
  async createPayout(batch, lines /* , opts */) {
    // No gateway configured — defer every line to the manual bank-file route.
    return {
      status: 'NEEDS_MANUAL',
      provider: 'stub',
      gatewayBatchId: null,
      lines: (lines || []).map((l) => ({ employeeId: l.employeeId, status: 'PENDING' })),
      message:
        'No payout gateway is configured. Generate the bank salary-advice file and ' +
        'upload it to your corporate net-banking, then reconcile with the bank UTR file.',
    };
  },
  async getStatus(/* gatewayBatchId, opts */) {
    return { provider: 'stub', batchStatus: 'UNKNOWN', lines: [] };
  },
};

// ── example RazorpayX adapter (NOT registered; reference shape only) ──────────
// Reads keys from env; no-ops gracefully when absent. Network calls are a TODO —
// the seam is what matters for v1 (the bank-file path is the supported product).
const razorpayxAdapter = {
  id: 'razorpayx',
  isConfigured() {
    return Boolean(process.env.RAZORPAYX_KEY_ID && process.env.RAZORPAYX_KEY_SECRET);
  },
  async createPayout(batch, lines, opts = {}) {
    if (!this.isConfigured()) {
      return {
        status: 'NEEDS_MANUAL',
        provider: 'razorpayx',
        gatewayBatchId: null,
        lines: (lines || []).map((l) => ({ employeeId: l.employeeId, status: 'PENDING' })),
        message: 'RazorpayX credentials are not configured (RAZORPAYX_KEY_ID / RAZORPAYX_KEY_SECRET).',
      };
    }
    // TODO(live): POST /v1/payouts (or the bulk payout-link / transfers API) per
    // line using basic-auth (keyId:keySecret), idempotency-key = `${batch.id}:${l.id}`,
    // mode NEFT/IMPS/RTGS by amount, fund_account from {account_number, ifsc}.
    // Map provider statuses → our enum. Left unimplemented in v1 (NOTED).
    throw notImplemented('razorpayx.createPayout');
  },
  async getStatus(/* gatewayBatchId, opts */) {
    if (!this.isConfigured()) return { provider: 'razorpayx', batchStatus: 'UNKNOWN', lines: [] };
    // TODO(live): GET /v1/payouts?... and map utr/status per item.
    throw notImplemented('razorpayx.getStatus');
  },
};

// ── example Cashfree Payouts adapter (NOT registered; reference shape only) ────
const cashfreeAdapter = {
  id: 'cashfree',
  isConfigured() {
    return Boolean(process.env.CASHFREE_CLIENT_ID && process.env.CASHFREE_CLIENT_SECRET);
  },
  async createPayout(batch, lines, opts = {}) {
    if (!this.isConfigured()) {
      return {
        status: 'NEEDS_MANUAL',
        provider: 'cashfree',
        gatewayBatchId: null,
        lines: (lines || []).map((l) => ({ employeeId: l.employeeId, status: 'PENDING' })),
        message: 'Cashfree credentials are not configured (CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET).',
      };
    }
    // TODO(live): authorize() then POST /payout/v1/requestTransfer per line, or
    // the batch transfer API. transferId = `${batch.id}_${l.id}`. Map statuses.
    throw notImplemented('cashfree.createPayout');
  },
  async getStatus(/* gatewayBatchId, opts */) {
    if (!this.isConfigured()) return { provider: 'cashfree', batchStatus: 'UNKNOWN', lines: [] };
    throw notImplemented('cashfree.getStatus');
  },
};

function notImplemented(what) {
  const e = new Error(`${what} is not implemented in v1 (use the bank-file + reconcile path)`);
  e.code = 'GATEWAY_NOT_IMPLEMENTED';
  e.statusCode = 501;
  return e;
}

// Registry of known adapters by id (for env-flag selection at boot).
const KNOWN = { stub: stubAdapter, razorpayx: razorpayxAdapter, cashfree: cashfreeAdapter };

let active = stubAdapter;

// Optional boot-time selection: PAYOUT_GATEWAY=razorpayx|cashfree (only takes
// effect if that adapter reports isConfigured()). Defaults to the stub.
(function selectFromEnv() {
  const want = String(process.env.PAYOUT_GATEWAY || '').toLowerCase();
  const impl = KNOWN[want];
  if (impl && typeof impl.isConfigured === 'function' && impl.isConfigured()) {
    active = impl;
  }
})();

function registerAdapter(impl) {
  if (
    !impl ||
    typeof impl.createPayout !== 'function' ||
    typeof impl.getStatus !== 'function' ||
    typeof impl.isConfigured !== 'function'
  ) {
    throw new Error('a payout adapter must implement { isConfigured, createPayout, getStatus }');
  }
  active = impl;
  return active;
}

function getAdapter() {
  return active;
}

module.exports = {
  getAdapter,
  registerAdapter,
  stubAdapter,
  razorpayxAdapter,
  cashfreeAdapter,
  KNOWN,
  // re-exported for direct use / tests
  isConfigured: () => active.isConfigured(),
  createPayout: (...args) => active.createPayout(...args),
  getStatus: (...args) => active.getStatus(...args),
};
