# Feature 47 — Master Program P1.3: full salary-component authoring (SLAB + all kinds + flags)

Part of the locked program (docs/MASTER-PLAN-CUSTOM-DYNAMIC.md). Closes the
hotlist items "compensation UI exposes 8 of 35 kinds / no SLAB / no wage flags"
and "floor/cap/minWageFloor unreachable via API".

## What shipped

### Custom SLAB components (new capability)
- `SalaryComponent.slabsJson` — ordered bracket-lookup bands over the calcBase
  (GROSS | CTC | a named component): `[{upTo, value, valueType: FLAT|PERCENT}]`.
  The WHOLE base falls in exactly one band (PT-style lookup, NOT progressive);
  only the last band may be open-ended (`upTo: null`).
- `deriveBreakup` evaluates SLAB at derivation time: earnings in the correct
  topo pass (GROSS/CTC base → pass 2, named base → pass 1 — per-method rule
  wins over stored derivationPass), non-earning slab lines (e.g. a canteen
  deduction banded by gross) evaluate AFTER earnings resolve against the
  resolved gross/CTC/named earning. Floor/cap clamps apply.
- Payroll runtime: a materialized SLAB line (amountMonthly set by
  derivation/revision) flows through the engine as FIXED — previously SLAB was
  silently dropped as "statutory" (silent pay-loss bug, now fixed). A slab line
  with no materialized amount is still dropped.
- Structure preview (`POST /compensation/structures/preview`) evaluates slabs
  live (it joins the stored component).

### Authoring API hardening
- `COMPONENT_FIELDS` now accepts `floorValue`, `capValue`,
  `minWageFloorApplies`, `slabsJson` (they existed in the schema but were
  stripped by the picker — unreachable by tenants).
- `derivationPass` is computed SERVER-side from calcMethod + calcBaseScope
  (0 flat/literal, 1 percent/slab-of-named, 2 percent/slab-of-GROSS/CTC,
  3 balancing) — client-supplied values ignored. (DB default 0 + explicit-wins
  inference was a footgun: a controller-created PERCENT_OF component would have
  evaluated as FLAT.)
- Validation (400 with readable messages): FLAT needs calcValue; PERCENT_OF
  needs calcValue 0–1000 + base; SLAB bands 1–20, ascending `upTo`, open band
  last, PERCENT band ≤ 100, base required for named scope; floor ≤ cap, both ≥ 0.
  Update validates the MERGED state (existing + patch).

### Admin UI (apps/hr-admin/app/compensation/page.js)
- Components tab rebuilt: all 29 India-relevant kinds (NZ-only kinds hidden)
  in grouped selects, all 6 calc methods with conditional fields, slab band
  editor (add/remove rows, ₹/% types, live "Base ≤ ₹10,000 → ₹200 · …" hint),
  statutory wage-flag checkboxes (PF/ESI/PT/Gratuity/Taxable + taxSection +
  min-wage floor), proration (incl. 26-day factory basis), floor/cap, GL code,
  sort order. Edit modal has the same full surface (code read-only). Table
  shows a Flags chip column and "SLAB (n bands)".

## Manual test (staging)
1. Compensation → Pay components → Add: pick SLAB, base GROSS, bands
   "≤30000 → ₹500", "above → 1%". Save. Table shows SLAB (2 bands).
2. Salary structures → build with BASIC 50% + that slab + a balancing special;
   preview at ₹50,000 gross — slab line shows ₹500 and the total reconciles.
3. Try bands out of order / floor > cap — clear inline error messages.

## E2E evidence
`scratchpad/e2e-p13.js` on live staging: **17 pass / 0 fail** (SLAB create with
server-computed pass, 4 validation 400s, floor/cap/taxSection persistence,
PATCH recompute, preview slab evaluation ₹500 @ 50k + paise reconciliation,
cleanup). Unit: `compensation/__tests__/slab.unit.test.js` 13/13;
deriveBreakup regression suite ALL PASS.
