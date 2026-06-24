# Feature 14 — Strict Single-Country Tenant Mode (India-first) + NZ roadmap

> **Status:** spec / dev contract · **Module:** `backend/src/hr/tenant/` (new, small) + cross-cutting guards · **Apps:** `apps/hr-admin`, `apps/ess`
> **Markets (v1):** **India only is live.** One tenant = ONE country. NZ engines exist in-tree but are roadmap (see §12).
> **Builds on:** F1 RBAC/scope, F4 lifecycle (`provisionEmployee`, validators), payroll `complianceRegistry`, leave, compensation, letters.
> **Author note:** every schema field / path / function below was verified against the live tree on 2026-06-24. Where the existing code defaults or leaks, it is flagged as a **bug to fix**, not reused.

---

## 1. Summary & goals

Today a DriftHR tenant's "country" is **inferred per `Entity`** (`Entity.countryCode` / `Entity.payCurrency`, schema L6376-6377) and resolved ad-hoc at every call site, each with its own fallback. The fallbacks **leak both markets**:

- `provision.js:308` — `countryCode = (entity.countryCode || job.countryCode || 'IN')` then `currencyCode = … (countryCode === 'NZ' ? 'NZD' : 'INR')`.
- `onboarding.service.js:51` — `countryCode = job?.countryCode || 'IN'`.
- `meOnboarding.controller.js:134-160` `resolveCountryCode()` — when a tenant has **multiple distinct entity countries** (or none yet), silently returns `'IN'`.
- `validators.js:validateStatutory(countryCode, …)` — picks IN vs NZ rule set off whatever `countryCode` it is handed; if the resolver is wrong, a tenant gets the wrong statutory fields.
- `calendar.js:48`, `letters.service.js:474`, `meTax.controller.js`, `holidays.controller.js`, `payroll/service.js` — each independently re-derives the market from `employee.countryCode` / `entity.countryCode` / `StatutoryProfile.countryCode`, with `NZ ⇒ … : IN` ternaries.

There is **no single tenant-level source of truth**, and the schema comment on `Entity.countryCode` (L6386) explicitly imagines "a tenant may hold IN + NZ entities." That cross-country mixing is the bug class this feature closes.

**This feature makes the tenant's registered country the ONE authoritative selector** for the entire payroll / tax / leave / statutory / letters / currency / onboarding-fields / UI behaviour. An India tenant must NEVER see an NZ option (or be able to create an NZ entity, NZ currency, NZ tax code) and — once NZ ships — vice-versa. v1 enforces this at three layers: **(1)** a locked `Business.hrCountry`, set once at HR setup; **(2)** a server-side resolver + write-guards that read `hrCountry` and refuse off-country writes (fail-closed); **(3)** a `/me/country-context` capability endpoint the front-ends consume so neither app hard-codes IN/NZ.

**Goals (v1):**
1. **One country per tenant, set once, locked.** `Business.hrCountry` is the single source of truth; `'IN'` for all v1 tenants.
2. **Server-side selector.** A pure `tenantCountry(businessId)` resolver replaces every scattered `|| 'IN'` / `NZ ? … : IN` fallback. All compliance/leave/letters/currency selection flows from it.
3. **Write-guards (fail-closed).** Creating an `Entity`, `Location`, compensation revision, holiday, or statutory profile in a country ≠ the tenant's country is **rejected 422**, not silently coerced.
4. **Backfill migration** that stamps `hrCountry` on every existing tenant from its entities (single distinct country) and **quarantines** any genuinely-mixed tenant for manual super-admin resolution (none expected in prod — staging demo is IN).
5. **UI gating.** `apps/hr-admin` + `apps/ess` render only the tenant-country surfaces (IN tax regime, PAN/Aadhaar/UAN/IFSC, PF/ESI/PT, INR) — no NZ tab, field, or currency ever appears for an IN tenant.
6. **NZ stays in-tree, OFF.** The NZ compliance/holidays modules, validators, and currency mapping remain registered and unit-tested but are **unreachable** for any tenant whose `hrCountry='IN'`. NZ tenant onboarding is a future cycle (§12).

**Non-goals (v1):** building/launching NZ tenants; per-entity country mixing within one tenant; runtime country switching (a tenant cannot change country after setup — it is a fresh tenant); multi-country consolidated payroll; FX/multi-currency comp within one tenant.

---

## 2. Scope

### In scope (v1 — reuse-first)
- **Reuse as-is:** `complianceRegistry.js` (already country-keyed & registers modules by `country`, never name-checks — this is the *correct* pattern we extend to the rest of the app); `validators.validateStatutory(countryCode, …)` (already gates the rule set by country — we just guarantee it's always handed the *tenant* country); `core/lib/currency.js` `currencyForCountry` / `COUNTRY_CURRENCY`; F1 scope middleware (every guard runs inside an already-`businessId`-scoped request).
- **Fix-before-reuse (verified leaks):**
  - `provision.js:308-309` — replace `|| 'IN'` and `NZ ? 'NZD' : 'INR'` ternary with `tenantCountry()` + `payCurrencyFor(country)`. The provisioned `Entity`/`StatutoryProfile`/comp basis must follow the tenant country, not the job/offer.
  - `onboarding.service.js:51` — drop `|| 'IN'`; resolve via `tenantCountry()`.
  - `meOnboarding.controller.js:134-160` `resolveCountryCode()` — collapse to `tenantCountry()`; **delete** the "multi-country → default IN" branch (impossible under one-country tenants; if it ever fires, it's a quarantined tenant → 409).
  - `meTax.controller.js:resolveCountry()`, `calendar.js:resolveSandwich()`, `letters.service.js:474`, `holidays.controller.js`, `payroll/service.js:307/368/385` — keep their *per-entity* reads (correct for the row), but assert each resolved country **equals** `tenantCountry()`; mismatch ⇒ log + fail-closed (never silently serve the wrong market). In single-country tenants this assert is always satisfied; it is a tripwire that catches a bad backfill.
- **Build net-new (small):**
  - `Business.hrCountry` + `Business.hrCurrency` columns (locked).
  - `backend/src/hr/tenant/countryContext.js` — pure-ish resolver + cache: `tenantCountry(businessId)`, `tenantCurrency(businessId)`, `assertCountry(businessId, code)`, `payCurrencyFor(code)`, `countryCapabilities(code)`.
  - `assertTenantCountry` Express guard (mounts on Entity/Location/Holiday/comp/statutory write routes).
  - `GET /api/hr/me/country-context` + `GET /api/hr/country-context` capability endpoints.
  - HR setup step that sets `hrCountry` once (the only place it is writable).
  - Backfill migration + a super-admin "tenant country" read/repair surface.

### Out of scope (deferred, explicit)
- **NZ tenant go-live** — entire NZ onboarding/payroll/holiday/casual-rate path (§12). Modules stay registered & tested but tenant-unreachable.
- **Per-entity country within a tenant** — the `Entity.countryCode` "IN + NZ entities" comment (schema L6386) is **retired**; for v1 every Entity under a tenant carries the tenant country.
- **Country migration / re-domicile** of an existing tenant — not supported; a country change = new tenant.
- **RoW (US/GB/AU/…) statutory** — `COUNTRY_CURRENCY` already lists currencies, but no compliance module exists, so registration is gated to `{IN}` (NZ added when §12 ships).

---

## 3. Data model changes (Prisma — minimal, additive)

> House conventions verified in-schema: denormalized `businessId`, ISO-3166 alpha-2 `@db.Char(2)`, locked-once columns get a timestamp + `…ChangedAt` guard (mirrors `Business.currencyChangedAt`, L245). **No new tables.** Two columns on `Business`, plus a quarantine flag.

### 3.1 What already exists (do NOT recreate)
| Concern | Existing field | Schema |
|---|---|---|
| Tenant root | `Business` (`country` ISO-2 storefront, `region` "IN"\|"NZ" HR-market hint, `defaultCurrency`, `currencyChangedAt`) | L114, L129, L136, L244-245 |
| Per-entity country | `Entity.countryCode` `@db.Char(2)`, `Entity.payCurrency` `@db.Char(3)` | L6376-6377 |
| Work-site country | `Location.countryCode` | L6435 |
| Person country | `Employee.countryCode` `@db.Char(2)?` | L6576 |
| Statutory country | `StatutoryProfile.countryCode` | L7208 |
| Currency map | `core/lib/currency.js` `COUNTRY_CURRENCY`, `currencyForCountry()` | — |
| Compliance routing | `complianceRegistry.js` (`registerComplianceModule`/`resolveComplianceModule` by `country`) | — |

### 3.2 New columns on `Business`

```prisma
model Business {
  // … existing fields …

  // ── F14 — HR single-country mode (the AUTHORITATIVE selector) ──
  // The ONE country a tenant operates HR/payroll in. Set ONCE at HR setup
  // (§4) and then immutable. Distinct from `country` (storefront/billing,
  // ISO-2) and the soft `region` hint (L136). Every payroll/tax/leave/
  // statutory/letter/currency/UI decision routes off THIS field via
  // tenant/countryContext.js. NULL = HR not yet set up (pre-setup tenant).
  hrCountry          String?   @db.Char(2)   // 'IN' (v1). 'NZ' added in §12.
  // Locked pay/display currency derived from hrCountry at setup. Denormalized
  // so reads never re-derive. INR for IN.
  hrCurrency         String?   @db.Char(3)   // 'INR' (v1)
  // Audit + lock guard. Once set, hrCountrySetAt is non-null and the setup
  // endpoint refuses to change hrCountry (returns 409). Mirrors currencyChangedAt.
  hrCountrySetAt     DateTime?
  // Backfill quarantine: TRUE when the migration found >1 distinct entity
  // country (a legacy mixed tenant) and could not auto-stamp. Such tenants are
  // BLOCKED from HR writes until a super-admin resolves them (§7). Expected: 0
  // in prod; the staging demo tenant is single-country IN.
  hrCountryAmbiguous Boolean   @default(false)
}
```

No other model changes. `Entity.countryCode` / `payCurrency`, `Location.countryCode`, `Employee.countryCode`, `StatutoryProfile.countryCode` remain — they are now **mirrors** of the tenant country (enforced by the write-guards in §5), kept for per-row reads and to avoid a wide refactor of payroll/leave/letters which legitimately read the row.

### 3.3 Invariant (the contract)

> For any tenant `B` with `hrCountry = C` and `hrCountryAmbiguous = false`:
> every `Entity`, `Location`, `Employee` (with a country), and `StatutoryProfile`
> under `B` has `countryCode === C`, and every `payCurrency` / comp currency
> equals `payCurrencyFor(C)`. The write-guards (§5) maintain this on every insert;
> the backfill (§6) establishes it; the tripwire asserts (§2) detect any drift.

---

## 4. Where country is SET (signup → HR setup)

Country is captured **once**, at the boundary, and then locked.

1. **Sitepresso storefront signup** (`business.controller.js`) already collects `country` (ISO-2) and derives `defaultCurrency`. This is the storefront/billing country — unchanged. It is a **default hint** for HR, not the HR country.
2. **HR setup (first HR admin login / "Set up HR" wizard step):** a single, one-time screen — **"Which country does your business run payroll in?"** — defaulting to `business.country` if it is a supported HR country, else forcing a pick. v1 the **only** selectable option is **India**; NZ is shown disabled with a "Coming soon" tag (so the UI is ready for §12 without offering it). Submitting calls:

```
POST /api/hr/setup/country   { country: 'IN' }
  guard: F1 permission hr.settings.manage (admin only) + SoD (not the maker of nothing — it's an init)
  → if business.hrCountrySetAt != null → 409 { code: 'HR_COUNTRY_LOCKED' }
  → if country not in REGISTRABLE_HR_COUNTRIES (= ['IN'] in v1) → 422
  → business.update({ hrCountry: country, hrCurrency: payCurrencyFor(country),
                      hrCountrySetAt: now, region: country })
  → 200 { country, currency, capabilities: countryCapabilities(country) }
```

`hrCountry` is **writable here and nowhere else.** There is no PATCH to change it. `REGISTRABLE_HR_COUNTRIES` lives in `tenant/countryContext.js` and is the registration allow-list (today `['IN']`; flip to `['IN','NZ']` when §12 ships). This single constant is the master switch that surfaces NZ.

---

## 5. Server-side enforcement (the selector + write-guards)

### 5.1 The resolver — `backend/src/hr/tenant/countryContext.js`

Pure logic + a tiny memoized DB read (per-request cache keyed by `businessId`; invalidated never within a request since `hrCountry` is immutable). The single chokepoint every other module calls instead of re-deriving.

```js
'use strict';
const prisma = require('../../core/lib/prisma');
const { currencyForCountry } = require('../../core/lib/currency');

// The ONLY countries a tenant may register HR for. v1 = IN. Add 'NZ' for §12.
const REGISTRABLE_HR_COUNTRIES = Object.freeze(['IN']);

// Capability matrix the front-ends consume so neither app hard-codes IN/NZ.
const CAPABILITIES = Object.freeze({
  IN: {
    country: 'IN', currency: 'INR', taxYearStartMonth: 4,
    tax: { regimes: ['NEW', 'OLD'], default: 'NEW', sections: ['80C','80D','HRA','LTA'] },
    statutoryIds: ['PAN', 'AADHAAR', 'UAN', 'IFSC'],
    payrollStatutory: ['EPF', 'ESI', 'PT', 'TDS', 'LWF'],
    compBasis: 'CTC', basicFloorPct: 50,        // Labour-code Basic ≥ 50% of CTC
    leaveSandwich: 'INCLUSIVE',
    letterLocale: 'en-IN',
    holidays: { mondayisation: false },
  },
  // NZ present for §12; UNREACHABLE while NZ ∉ REGISTRABLE_HR_COUNTRIES.
  NZ: {
    country: 'NZ', currency: 'NZD', taxYearStartMonth: 4,
    tax: { codes: ['M','ME','S','SH','ST'], default: 'M' },
    statutoryIds: ['IRD', 'NZ_BANK_ACCOUNT'],
    payrollStatutory: ['PAYE', 'KIWISAVER', 'ACC', 'ESCT'],
    compBasis: 'GROSS', hourlyRates: true,
    leaveSandwich: 'EXCLUSIVE',
    letterLocale: 'en-NZ',
    holidays: { mondayisation: true },          // Holidays Act 2003
  },
});

function payCurrencyFor(code) { return currencyForCountry(code); } // IN→INR

async function loadHrCountry(businessId) {
  const b = await prisma.business.findUnique({
    where: { id: businessId },
    select: { hrCountry: true, hrCurrency: true, hrCountryAmbiguous: true },
  });
  if (!b) throw new CountryError('TENANT_NOT_FOUND', 404);
  if (b.hrCountryAmbiguous) throw new CountryError('HR_COUNTRY_AMBIGUOUS', 409); // quarantined
  if (!b.hrCountry)        throw new CountryError('HR_NOT_SET_UP', 409);          // pre-setup
  return { country: b.hrCountry, currency: b.hrCurrency || payCurrencyFor(b.hrCountry) };
}

async function tenantCountry(businessId)  { return (await loadHrCountry(businessId)).country; }
async function tenantCurrency(businessId) { return (await loadHrCountry(businessId)).currency; }
function countryCapabilities(code)        { return CAPABILITIES[code] || null; }

// Fail-closed equality assert used by write-guards AND the per-row tripwires.
async function assertCountry(businessId, code) {
  const c = await tenantCountry(businessId);
  if (String(code).toUpperCase() !== c) {
    throw new CountryError('COUNTRY_MISMATCH', 422, { expected: c, got: code });
  }
  return c;
}

class CountryError extends Error { constructor(code, status, detail) { super(code); this.code = code; this.status = status; this.detail = detail; } }

module.exports = {
  REGISTRABLE_HR_COUNTRIES, tenantCountry, tenantCurrency, countryCapabilities,
  payCurrencyFor, assertCountry, CountryError, _CAPABILITIES: CAPABILITIES,
};
```

### 5.2 Call-site replacements (delete the scattered fallbacks)

| File:line | Today (leak) | Replace with |
|---|---|---|
| `provision.js:308` | `entity.countryCode \|\| job.countryCode \|\| 'IN'` | `await tenantCountry(businessId)` (then assert `entity.countryCode` matches) |
| `provision.js:309` | `… countryCode === 'NZ' ? 'NZD' : 'INR'` | `await tenantCurrency(businessId)` |
| `onboarding.service.js:51` | `job?.countryCode \|\| 'IN'` | `await tenantCountry(businessId)` |
| `meOnboarding.controller.js:134-160` | multi-country → `'IN'` default | `await tenantCountry(businessId)`; delete the distinct-entities branch |
| `meTax.controller.js:resolveCountry` | SP→Emp→Entity chain | keep chain, then `assertCountry(businessId, cc)` tripwire |
| `payroll/service.js:resolveModule` | `entity.countryCode` | keep (per-run), assert equals `tenantCountry` before run |
| `calendar.js:resolveSandwich` | `cc === 'NZ' ? EXCL : INCL` | drive from `countryCapabilities(country).leaveSandwich` |
| `letters.service.js:474` | `entity.countryCode==='NZ'?en-NZ:en-IN` | `countryCapabilities(country).letterLocale` |

Net effect: **one** definition of "what country is this tenant," **one** currency, **one** capability matrix. No business-logic file name-checks `'IN'`/`'NZ'` anymore — they ask the resolver.

### 5.3 Write-guards (fail-closed) — `assertTenantCountry` middleware

Mounted on every route that **creates a country-bearing row**: Entity create, Location create, Holiday create (`holidays.controller.js:59`), compensation revision (currency must equal `tenantCurrency`), StatutoryProfile create/update, Employee create (when `countryCode` is supplied).

```js
// backend/src/hr/tenant/assertTenantCountry.middleware.js
function assertTenantCountryWrite(fieldPath = 'body.countryCode') {
  return async (req, res, next) => {
    try {
      const businessId = req.businessId;          // set by F1 scope middleware
      const got = pick(req, fieldPath);
      if (got == null) {                          // not supplied → stamp the tenant country
        setPath(req, fieldPath, await tenantCountry(businessId));
        return next();
      }
      await assertCountry(businessId, got);       // supplied → must match, else 422
      return next();
    } catch (e) {
      if (e.code === 'COUNTRY_MISMATCH')
        return res.status(422).json({ message: 'This field does not match your business country', detail: e.detail });
      if (e.code === 'HR_NOT_SET_UP')
        return res.status(409).json({ message: 'Finish HR setup (set your business country) first' });
      if (e.code === 'HR_COUNTRY_AMBIGUOUS')
        return res.status(409).json({ message: 'Your tenant country needs admin review' });
      return next(e);
    }
  };
}
```

Currency guard variant (`assertTenantCurrencyWrite('body.currencyCode')`) for comp revisions / offers: rejects any currency ≠ `tenantCurrency`. This kills the `currencyCode` leak path the country-gating test (`countryGating.test.js` A2) already guards at the read side — now we guard the **write** side too.

### 5.4 Registration allow-list

`POST /api/hr/setup/country` and any "create entity in country X" path consult `REGISTRABLE_HR_COUNTRIES`. With it `= ['IN']`, NZ literally cannot be selected or written, server-side, regardless of what a crafted request sends. This is the hard backstop behind the UI gating.

---

## 6. Backfill migration

Two parts: a **schema migration** (additive columns, safe) and a **data backfill** (idempotent script, run once).

### 6.1 Schema migration
`prisma migrate` adding `hrCountry`, `hrCurrency`, `hrCountrySetAt`, `hrCountryAmbiguous` (all nullable / defaulted). Zero downtime; no existing column touched.

### 6.2 Data backfill — `backend/scripts/backfill-hr-country.js`

For each `Business` with `hrCountry IS NULL`:
1. Collect `distinct(Entity.countryCode)` for `businessId` where `deletedAt IS NULL`.
2. **0 entities** → fall back to `business.region` then `business.country` (mapped via `COUNTRY_CURRENCY`); if that resolves to a `REGISTRABLE_HR_COUNTRIES` member, stamp it; else leave `hrCountry=NULL` (pre-setup tenant — they'll set it in §4).
3. **exactly 1 distinct country** → stamp `hrCountry = that`, `hrCurrency = payCurrencyFor(that)`, `hrCountrySetAt = now`.
4. **>1 distinct country** (genuinely mixed legacy tenant) → set `hrCountryAmbiguous = true`, leave `hrCountry=NULL`, **log loudly** with the businessId + the country split. These are blocked from HR writes (§5.1 `loadHrCountry` throws 409) until a super-admin resolves them (§7).

The script is **idempotent** (re-running skips tenants whose `hrCountrySetAt` is set) and prints a summary: `{ stamped, ambiguous, preSetup }`. Expected prod/staging result: all tenants → IN (the demo tenant and any real tenant are single-country), `ambiguous: 0`.

### 6.3 Verification gate
After backfill, a check query asserts **no** `Entity`/`Location`/`StatutoryProfile` row has `countryCode != business.hrCountry` for any non-ambiguous tenant. Any hit is printed for manual review (would indicate a pre-existing data bug, not a v1 regression). This is the same invariant the §2 tripwires defend at runtime.

---

## 7. Super-admin: tenant-country read/repair

A small surface in the existing super-admin console (`backend/src/superadmin/controllers/admin.controller.js` already imports `countryCode`):
- **Read:** `GET /api/superadmin/tenants/:id/country` → `{ hrCountry, hrCurrency, hrCountrySetAt, hrCountryAmbiguous, entityCountries: [...] }`.
- **Repair (ambiguous only):** `POST /api/superadmin/tenants/:id/country/resolve { country }` — allowed **only** when `hrCountryAmbiguous=true`; sets the country, clears the flag, and **must** be accompanied by a (manual) data remediation of the off-country entities (the endpoint refuses if off-country entities still exist, returning the offending entity ids). This is a break-glass path; expected unused in prod.

No tenant-facing "change country" exists. SoD: the resolve action is super-admin-gated and audit-logged.

---

## 8. API surface (RBAC)

> All under the F1 scope middleware (request is already `businessId`-bound). Permission keys reuse F1 `hr.settings.*` / employee-self bands.

| Method & path | Purpose | RBAC |
|---|---|---|
| `POST /api/hr/setup/country` | Set the tenant HR country **once** (locked after) | `hr.settings.manage` (admin) |
| `GET /api/hr/country-context` | Tenant capability matrix for hr-admin (`{ country, currency, capabilities }`) | any HR operator |
| `GET /api/hr/me/country-context` | Capability matrix for the signed-in employee's tenant (ESS) | authenticated employee (self scope) |
| `GET /api/superadmin/tenants/:id/country` | Inspect a tenant's country state | super-admin |
| `POST /api/superadmin/tenants/:id/country/resolve` | Break-glass repair of an ambiguous tenant | super-admin |

`country-context` responses are the front-end contract: the apps **render from capabilities**, never from a hard-coded country literal. Example IN payload:

```json
{ "country": "IN", "currency": "INR",
  "capabilities": { "tax": { "regimes": ["NEW","OLD"], "default": "NEW" },
    "statutoryIds": ["PAN","AADHAAR","UAN","IFSC"],
    "payrollStatutory": ["EPF","ESI","PT","TDS","LWF"],
    "compBasis": "CTC", "basicFloorPct": 50, "letterLocale": "en-IN",
    "holidays": { "mondayisation": false } } }
```

---

## 9. hr-admin & ESS UX (plain language)

**Principle:** the apps ask `country-context` once on load, stash it, and **gate every country-specific surface on `capabilities`** — never on a literal. An IN tenant sees zero NZ affordances; the NZ code paths are dead-rendered (gated off).

### hr-admin
- **HR setup wizard** gains a first step: "Which country do you run payroll in?" — India is selected and the only enabled choice; NZ is visible but disabled with "Coming soon." Once saved, the step shows as locked ("Business country: India — locked").
- **Settings → Business:** shows "Payroll country: India 🇮🇳 · Currency: INR" as **read-only** (no edit control; a tooltip explains a country change means a new workspace).
- **Payroll / Compensation:** currency symbol, CTC basis, Basic-≥-50% floor, statutory components (EPF/ESI/PT/TDS) all sourced from `capabilities`. No NZD, no PAYE/KiwiSaver columns ever appear.
- **Employee create / onboarding:** statutory-field block renders **only** `capabilities.statutoryIds` (PAN, Aadhaar, UAN, IFSC for IN). No IRD/tax-code/NZ-bank fields.
- **Holidays / Leave:** the holiday calendar shows India public holidays; no "Mondayisation" toggle (it's `false` in caps). Leave templates seed India types (EL/SL/CL/maternity) only.
- **Letters:** locale `en-IN`, INR amounts, India statutory phrasing — no NZ template variants surface.

### ESS (apps/ess)
- **Self-onboarding wizard** (F4 slice 4b) renders the IN statutory step (PAN/Aadhaar/UAN/IFSC + IN bank IFSC), validated by `validateStatutory('IN', …)` (already gated by country in `validators.js`). The NZ branch (IRD/tax-code) is never reached because the resolver always returns the tenant country.
- **Tax declaration** (`meTax.controller.js`) shows the India regime chooser (New/Old) + 80C/HRA — the NZ tax-code panel is gated off.
- **Payslip / comp card:** INR formatting from `me/country-context.currency` (no INR-fallback leak — fixes the same class `countryGating.test.js` A2 guards).
- A new ESS user in an IN tenant has **no path** to ever see an NZ string.

---

## 10. Build plan (5 slices)

### Slice 14a — Schema + resolver core (no behaviour change yet)
- Add `Business.hrCountry/hrCurrency/hrCountrySetAt/hrCountryAmbiguous` (migration).
- Write `tenant/countryContext.js` (`tenantCountry`/`tenantCurrency`/`countryCapabilities`/`payCurrencyFor`/`assertCountry`/`REGISTRABLE_HR_COUNTRIES`/`CAPABILITIES`).
- Unit tests (plain-node, mirrors `countryGating.test.js`): caps matrix shape, currency mapping, `assertCountry` mismatch → throws, ambiguous/pre-setup → 409.

### Slice 14b — Backfill + super-admin repair
- `scripts/backfill-hr-country.js` (idempotent, summary, ambiguity quarantine).
- Super-admin read + break-glass resolve endpoints.
- Verification gate query. Run on staging demo tenant → assert it stamps `IN`, `ambiguous:0`.

### Slice 14c — HR setup endpoint + write-guards (the lock + fail-closed)
- `POST /api/hr/setup/country` (locked-once, allow-list `['IN']`).
- `assertTenantCountry`/`assertTenantCurrency` middleware on Entity/Location/Holiday/comp/statutory/employee write routes.
- Tests: second setup call → 409; off-country entity create → 422; off-currency comp → 422; create without country → auto-stamped to tenant country.

### Slice 14d — Replace the scattered fallbacks (the de-leak)
- Swap every `|| 'IN'` / `NZ ? … : IN` site (table §5.2) for the resolver/caps.
- Add the per-row **tripwire asserts** in meTax/payroll/calendar/letters.
- Re-run `countryGating.test.js` + payroll IN/NZ golden tests (NZ goldens still pass as **unit** tests against the module directly — they don't go through a tenant).

### Slice 14e — country-context endpoints + UI gating
- `GET /api/hr/country-context` + `GET /api/hr/me/country-context`.
- hr-admin: setup-wizard country step (IN-only, NZ disabled), read-only Settings badge, caps-driven payroll/onboarding/letters/holidays/leave surfaces.
- ess: caps-driven onboarding statutory step + tax declaration + currency formatting.
- E2E smoke: an IN tenant's hr-admin + ESS render no NZ field/tab/currency anywhere.

*(Optional 14f — telemetry: a daily job re-runs the §6.3 invariant query and alerts if any tenant drifts. Cheap insurance; can fold into 14b.)*

---

## 11. Security, edge cases & invariants

- **Fail-closed everywhere.** Unknown/missing tenant country → 409, never a default market. A mismatched write → 422, never a silent coerce. (Contrast the current `|| 'IN'` which silently picks India.)
- **Immutability.** `hrCountry` is writable exactly once (`hrCountrySetAt` gate). No PATCH, no admin toggle, no super-admin change except the ambiguous break-glass. Prevents a tenant flipping country and orphaning INR payroll history.
- **Tenant isolation (F1).** Every resolver/guard runs inside the `businessId`-scoped request; `loadHrCountry` reads only `business.findUnique` by the scoped id. No cross-tenant read. The IDOR test (`tenant-isolation.idor.test.js`) coverage extends to the new endpoints.
- **SoD (maker-checker).** Setup-country is an init action (admin-only); the ambiguous-resolve is super-admin + audit-logged. No self-approval path introduced.
- **Crafted-request backstop.** Even if a malicious client posts `countryCode:'NZ'`, the allow-list + `assertCountry` reject it server-side. UI gating is convenience; the server is the authority.
- **Edge — pre-setup tenant.** A tenant that finished Sitepresso signup but not HR setup has `hrCountry=NULL`; all HR write routes 409 with "finish HR setup," ESS shows a "HR not configured" state. No partial/leaky behaviour.
- **Edge — ambiguous legacy tenant.** Quarantined (`hrCountryAmbiguous=true`) → blocked from HR writes until repaired. Reads of historical data still work read-only via the super-admin surface. (Expected count: 0.)
- **Edge — Employee.countryCode null.** Allowed (it's nullable); reads fall through to `tenantCountry`. The write-guard only asserts when a country is *supplied*.
- **Edge — NZ module still loaded.** `complianceRegistry` keeps the NZ module registered; it's just never `resolveModule`'d because no tenant is NZ. NZ golden/unit tests run against the module directly (no tenant), so they keep passing and protect the §12 roadmap work.
- **No double source of truth.** `Entity.countryCode` etc. become *mirrors* maintained by the guards; the tripwires detect any drift. The single authority is `Business.hrCountry`.
- **Performance.** `loadHrCountry` is a single indexed PK read, memoized per request — negligible. `CAPABILITIES`/`REGISTRABLE_HR_COUNTRIES` are frozen in-memory constants.

---

## 12. NZ roadmap (future cycle — DO NOT build now)

NZ is a **separate go-live**, gated entirely behind flipping `REGISTRABLE_HR_COUNTRIES` to `['IN','NZ']` **after** the items below land. The compute modules already exist (`compliance/newzealand.js`, `compliance/holidaysAct.js`, NZ branches in `validators.js`, `engine.js` flags `isNzGrossEarnings`/`isPayeable`/`isKiwiSaverable`, NZ goldens) — what's missing is the **tenant-facing onboarding + the hourly/Holidays-Act surfaces**.

**NZ payroll model (vs India):**
- **PAYE** (Pay-As-You-Earn) income tax with **tax codes** (M/ME/S/SH/ST…), not the IN regime/80C model.
- **Hourly / hours-worked pay** as a first-class basis (`compBasis:'GROSS'`, `hourlyRates:true`) — casual, part-time, and waged employees paid on actual hours, not a monthly CTC. Needs an **hourly rate × hours-worked** earning path feeding the engine (the attendance `derive.js → AttendancePayInput` seam is the hook).
- **Holidays Act 2003** — annual holidays (4 weeks), public holidays with **Mondayisation** (already in `holidaysAct.js`), alternative holidays ("days in lieu"), sick/bereavement/family-violence leave, and the **8% pay-as-you-go** holiday pay for casuals. Leave/encashment math is OWP/AWE-based (ordinary-weekly-pay / average-weekly-earnings — partly present in FnF).
- **KiwiSaver** (employee + employer, rate 3%→3.5% from 1 Apr 2026), **ESCT** on employer contributions, **ACC** levy (1.67%→1.75%, cap from 2026).
- **NZD** currency, `en-NZ` letter locale, IRD-number + NZ-bank-account statutory ids.

**What the NZ cycle must build (not now):**
1. **NZ tenant registration** — add `'NZ'` to `REGISTRABLE_HR_COUNTRIES`; enable the NZ choice in the §4 setup wizard; `payCurrencyFor('NZ')→NZD`.
2. **Hourly/casual compensation** — a GROSS-basis, hourly-rate comp shape (no Basic-≥-50% CTC floor); wire `AttendancePayInput` hours → engine `ATTENDANCE_DRIVEN` earnings for waged staff.
3. **Holidays-Act leave engine** — annual/public/alternative/sick/bereavement leave types, Mondayisation surfaced (caps `holidays.mondayisation:true`), 8% PAYG holiday accrual for casuals, OWP/AWE encashment.
4. **PAYE tax surfaces** — tax-code selection in ESS onboarding + tax declaration (replacing the IN regime/80C panels via `capabilities`), KiwiSaver-rate election, ESCT/ACC in payroll.
5. **NZ statutory onboarding fields** — IRD number + NZ bank account validators (already in `validators.js`) surfaced via `capabilities.statutoryIds` (no IN PAN/Aadhaar/UAN).
6. **NZ letters/holiday calendar/currency** — `en-NZ` templates, NZ public-holiday seed, NZD formatting — all already keyed off `capabilities`, so they light up automatically once a tenant is NZ.
7. **NZ filing** — `payroll/filing/newzealand.js` (exists) wired to IR (payday filing) as a later sub-cycle.

The whole NZ surface is therefore **one constant flip + the onboarding/hourly/Holidays-Act build** — the F14 architecture (capabilities-driven UI, country-keyed compliance registry, fail-closed guards) is deliberately shaped so adding NZ touches **no IN code path** and can't leak into IN tenants.
