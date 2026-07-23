# Feature 70 — Master Program Phase 5d: N+1 pass + pagination

Fourth Phase-5 (hardening) wave. A performance pass on the payroll hot-path — a pure
refactor, so the governing rule is **byte-for-byte output preservation**.

## 1. Payroll compute: batch the per-employee compensation lookup (the `:885` N+1)
The compute loop (`assembleBundles`) resolved each employee's covering compensation
revision with its own `findFirst` — **N queries for an N-employee run**. Added
`prefetchCurrentCompensations(businessId, employeeIds, asOf, db)`: the batched twin of
`resolveCurrentCompensation`'s covering query — **identical** predicate, `orderBy
(effectiveFrom desc)`, and `include`. A global effectiveFrom-desc sort means the first
row seen per employee is that employee's max-effectiveFrom covering revision — exactly
what the per-employee `findFirst` returns. The loop now reads from the prefetched Map;
**`resolveCurrentCompensation` stays the source of truth** — a Map miss (no covering
revision) falls back to it, preserving the closed-window / `isCurrent` path. Result:
N compensation queries → 1, with a correctness safety-net.

**Why this is safe (not just fast):**
- Safe-by-construction: same query, same asOf (one run-wide period end), same ordering.
- Fallback net: any employee absent from the batch (no covering row) is resolved by
  the original per-employee function → the `isCurrent` fallback is unchanged.
- The engine is untouched — all **9 payroll golden suites pass** (india 288, arrears
  48, nz 63, ptStates 55, variance 39, calendar 31, + bonus/lwp/variablePay).
- **Exact parity proven on real data:** a read-only SSM probe compares, for every
  employee across every tenant, the loop's effective compensation (map-with-fallback)
  against the original `resolveCurrentCompensation` — **0 mismatch**.

## 2. Pagination: `GET /runs/:id/payslips` (optional, backward-compatible)
`getRunPayslips` returned every payslip unbounded with `total: items.length`. Now it
accepts optional `page`/`pageSize`: with no params the query is unbounded **exactly as
before**, but `total` is a real `count()` (equal to `items.length` when unpaginated);
with params it returns a bounded `take`/`skip` page plus the true total and echoes
`page`/`pageSize`. Zero regression (no params → same rows, same total), and a large
run can now be paged (cap 200/page).

## Scope & deferrals (deliberate)
The other named hotspot — `attendanceSweep → service.recompute` (~8 queries/employee)
— is the **canonical daily-rollup path, also invoked on every punch event** and
heavily tested. Batching its shared per-tenant-day inputs is a real win but too
correctness-sensitive to refactor without an adversarial verifier; **deferred** with a
concrete plan (prefetch shifts/roster/policies/holidays once per tenant-day). The
payroll loop's FBP-overlay and §192 tax-override per-employee resolvers are likewise
left as measured follow-ups (they carry heavier compute + cross-module coupling; the
compensation N+1 was the clean, provably-safe win).

## Verification
- 9 payroll golden suites green (engine unchanged).
- SSM parity probe (read-only, all tenants × all employees): batched-with-fallback ===
  per-employee resolver, 0 mismatch.
- Live E2E `qa/e2e/e2e-p5-payroll-perf.js`: `GET /runs/:id/payslips` — unpaginated
  returns all rows with true total and no page/pageSize keys (shape unchanged);
  `?pageSize=1` returns ≤1 row with the real total + echoed page/pageSize; page 2 is a
  distinct ordered slice.

## Follow-ups (for the P5f closing audit)
1. Batch `attendanceSweep`'s per-tenant-day shared inputs (shifts/roster/policy/holiday).
2. Batch the payroll loop's FBP-overlay + §192 tax-override resolvers.
3. Extend optional pagination to other unbounded operator list endpoints.
