# Feature 67 — Master Program Phase 5a: multi-country unlock (New Zealand)

First Phase-5 (hardening) wave. New Zealand payroll — PAYE, KiwiSaver, ESCT,
ACC, student loan, the Holidays Act leave engine, and IRD payday (EI) filing —
was **fully built and golden-tested** but registration-gated to India. This
flips the gate and guards the India-only assumptions so NZ tenants operate and
IN tenants are untouched.

## What shipped

### The gate flip
`countryContext.js` REGISTRABLE_HR_COUNTRIES: `['IN']` → `['IN','NZ']`. That
single frozen constant is read by exactly one write-path (`setupCountry`), so
`POST /setup/country {country:'NZ'}` now succeeds (was 422 NOT_REGISTRABLE) →
`Business.hrCountry='NZ'`, `hrCurrency='NZD'` → the capability matrix, currency,
statutory dispatch, leave sandwich, and letter locale all resolve NZ (all were
already wired to the tenant country). countryContext.test updated to assert the
new frozen set.

### The one functional gap: disbursement
`disbursement.service.js` refused any non-IN entity ("India-only"). Replaced
with a pure `resolveDisbursementRoute(countryCode)` → IN = the existing bank
formats (byte-for-byte unchanged), NZ = a new direct-credit batch via
`filing/newzealand.generateBankBatch` (DC/CTRL rows, BB-bbbb-AAAAAAA-SSS
accounts, dollar amounts from cents, control hash), any other country = the
COUNTRY_UNSUPPORTED throw. NZ produces the bank pay-file inline.
**Scoped limitation (documented, follow-up):** the NZ batch is not yet
*persisted* as a PayoutBatch — `PayoutBank` is an IN-only enum and
`PayoutLine.ifsc` is required; NZ payout persistence (download/reconcile
lifecycle) needs a small schema follow-up. The NZ pay-file itself is generated.

### IN-only surface guarding (frontend)
- hr-admin: New Zealand added to the country picker; the seven India-only nav
  entries (Form 16, statutory registers, tax declaration/proofs/regime, FBP
  plans/allocations) gated on `country==='IN'` via the existing
  useTenantCountries hook + a CountryGate page wrapper (deep links get a
  friendly panel, not a raw 404); company-profile shows NZBN + IRD for NZ
  (vs PAN/GSTIN/TAN for IN); holiday-import offers the tenant's country.
- Backend: `PROFILE_FIELDS` allowlist gains `nzbn` + `irdEntityNumber` so the
  NZ identifiers persist.
- ESS: `useCountry.normalize()` now returns the real country (IN or NZ) instead
  of collapsing non-IN to null; the base India tax nav item is hidden for a
  resolved non-IN tenant. IN tenants render identically (fail-open while the
  country is unresolved).

### Schema comments
Retired the two stale comments claiming per-entity IN+NZ mixing within one
tenant (behaviour is single-country per tenant — every Entity.countryCode
equals hrCountry). Comment-only.

## Verification
- Units/goldens: NZ golden **63/63**; disbursement golden **25/25** (22 IN
  byte-pins unchanged + 3 NZ/IN/other dispatch); countryContext gate admits
  IN+NZ (still frozen). **IN disbursement + all IN payroll paths confirmed
  byte-for-byte unchanged** (the IN createBatch/formatters are untouched).
- Live (IN-regression) E2E `qa/e2e/e2e-p5-nz-unlock.js`: the demo IN tenant is
  unaffected — country-context still IN/INR with capabilities, country stays
  locked-once, IN payroll + disbursement surfaces respond.
- The full NZ-tenant walkthrough (register → set country NZ → NZ entity → NZ
  payrun compute/EI/pay-file) is staging-QA, backed by the golden + gate proof
  above (the demo tenant is IN and locked, so it can't exercise NZ setup).

## Follow-ups (noted for the closing P5f audit)
1. NZ PayoutBatch persistence (PayoutBank rail + nullable ifsc + migration) for
   the download/reconcile lifecycle — the NZ pay-file is generated but not
   stored.
2. `NZ ? … : IN` binary fallbacks across FnF/provision/validators are fine for
   IN+NZ but would need a dispatch abstraction for a 3rd country.
