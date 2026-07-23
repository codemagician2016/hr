# Feature 71 — Master Program Phase 5e: payout adapters (config-ready) + NZ payout persistence

Fifth Phase-5 (hardening) wave. Two disbursement items: confirm the live-payout
**adapter seam is config-ready**, and close the P5a follow-up by **persisting NZ
payout batches** like India.

## 1. Payout-gateway adapter seam — already config-ready (confirmed, no change)
`disbursement/payoutAdapter.js` is a pluggable seam (same shape as the attendance
`faceMatcher`): a default **stub** adapter (returns `NEEDS_MANUAL` → the bank-file +
UTR-reconcile path, the supported product) plus reference **RazorpayX** and
**Cashfree** adapters that read credentials from env (`RAZORPAYX_KEY_ID/..`,
`CASHFREE_CLIENT_ID/..`), `isConfigured()` false when absent, selected at boot via
`PAYOUT_GATEWAY=`. `registerAdapter(impl)` drops in a real provider without touching
the service. **Live gateway network calls are intentionally not implemented** (they
move real money and need owner-provisioned secrets — out of scope without owner sign-
off). The disbursement `gateway` status already surfaces `{ configured, provider }`.
This wave changes nothing here — it is config-ready as designed and documented.

## 2. NZ PayoutBatch persistence (closes the P5a follow-up)
NZ generated the direct-credit file inline but did **not** persist a
PayoutBatch/PayoutLine — the schema was India-shaped (`PayoutBank` had no NZ member,
`PayoutLine.ifsc` was a required `Char(11)`). Now:
- Schema: `PayoutBank += NZ_DIRECT_CREDIT`; `PayoutLine.ifsc` is **nullable** (null on
  the NZ rail; `accountNumber` snapshots the NZ account `BB-bbbb-AAAAAAA-SSS`).
  Backward-compatible — existing IN lines keep their IFSC.
- `createNzDirectCreditBatch` now persists a PayoutBatch (`bank=NZ_DIRECT_CREDIT`,
  `currencyCode=NZD`, `status=PROCESSING`, `fileGeneratedAt` stamped) + per-employee
  PayoutLines (ifsc null), returning the serialized batch with `persisted:true`, a real
  `id`, and the inline direct-credit file. The **same double-pay guard** as IN (refuse
  a new batch while a non-terminal one is in-flight; audited `force` re-issues) and the
  existing UTR-reconcile lifecycle now apply to NZ unchanged.

The **IN rail is byte-for-byte unchanged** (all changes are additive: a new enum value,
a column made nullable, and a new NZ-only persistence block).

## Verification
- `prisma validate` clean; service loads.
- Disbursement golden **25/25** (IN byte-pins + NZ dispatch + bankFormats all unchanged).
- NEW `nzPersistence.test.js` **2/2** (injected fake `db` + mocked pure NZ generator):
  persists on the `NZ_DIRECT_CREDIT` rail with null ifsc + the NZ account snapshot, line
  amounts sum to the generator control total, response `persisted:true` + real id + file;
  double-pay guard rejects a second in-flight batch and `force` re-issues.
- No live NZ E2E: the staging demo tenant is IN + country-locked, so an NZ run can't be
  created there (same constraint as P5a). IN disbursement regression is guarded by the
  golden + the post-ship IN-regression E2E (`e2e-p5-nz-unlock.js`).

## Follow-ups
1. Live gateway calls (RazorpayX/Cashfree) — owner-provisioned secrets + a real-money
   test plan; the seam is ready.
2. An NZ-tenant end-to-end walkthrough when an NZ staging tenant exists (register → NZ
   run → NZ payout batch persisted → reconcile).
