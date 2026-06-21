# 13 — UX, Information Architecture & Design System

> **Author role:** Senior UI/UX Designer
> **Status:** Production design spec — exhaustive, opinionated, not an MVP outline.
> **Scope:** Information architecture across all four surfaces; the five fixed visual styles (named, tokenized); white-label brand color + logo injection; navigation patterns; four end-to-end key flows (signup→setup, run-payroll, apply-leave, onboard-employee); accessibility (WCAG 2.2 AA); responsive/mobile; and the concrete reuse of Sitepresso `packages/ui` primitives plus the HR component library we add.
> **Markets:** India (IN), New Zealand (NZ). Currencies INR, NZD. Tax year Apr–Mar (both).
> **Cross-refs:** `00-vision-and-principles.md` ("pre-built system, not a builder"), `01-product-requirements.md` (surfaces, plans), `02-system-architecture.md` (router/tenant resolution, white-label domains), `03-data-model.md` (Tenant/Employee/Subscription), `04-payroll-engine-design.md` (pay-run state machine), `05-compliance-india.md`, `06-compliance-newzealand.md`, `07-modules-core-hr.md`, `08-modules-time.md`, `09-modules-pay-adjacent.md` (payslip layout). Naming for later docs: `06-rbac-and-approvals.md`, `12-mobile-ess.md`.

---

## 0. Design Principles (the non-negotiables)

These constrain every decision below. They flow directly from `00-vision-and-principles.md`.

1. **CONFIGURE, do not BUILD.** There is no page builder, form builder, layout builder, or block editor anywhere in any surface. Where Sitepresso shipped a `website-builder` and `layout-presets.cjs` (100 storefront layouts) and 60+ profession themes, we **DELETE** all of it. The tenant's entire visual surface area is four knobs: **logo, one brand color, one of five fixed styles, one bound custom domain**. Everything else is data + settings + plan feature flags.
2. **Payroll is a high-stakes, irreversible-feeling action.** The dominant UX pattern is the **stepped wizard with a frozen review gate and an explicit, typed confirmation** — never a single "Save" that silently posts money. Mirrors the pay-run state machine in `04-payroll-engine-design.md`.
3. **Compliance is shown, not hidden.** Every statutory number on a payslip or pay-run review is **traceable to a rule version** (e.g., "ESI 0.75% · IN rule set v2026.04"). The UI never shows a computed figure without an affordance to see *why*.
4. **Two markets, one product.** Country is a property of the **legal entity**, not the tenant. A tenant can run IN and NZ entities. The UI localizes vocabulary, currency, date format, statutory labels, and validation per the active entity's country — never via a global toggle the user has to remember.
5. **Employee surface is white-labeled and trust-critical.** At `tenant.com` the employee may never see the word "HRMS-platform-name." Branding is the tenant's. Our chrome disappears.
6. **Accessibility is a launch gate, not a backlog item.** WCAG 2.2 AA across all four surfaces. Payslips and tax docs must be screen-reader-navigable and printable.

---

## 1. The Four Surfaces — Information Architecture

| # | Surface | Host | Audience | App (new) | Reuses Sitepresso |
|---|---------|------|----------|-----------|-------------------|
| 1 | **Marketing + Onboarding** | `hr.com`, `www.hr.com` | Prospects, new signups | `apps/marketing` + onboarding wizard | `apps/platform/app/signup`, `.../onboarding`, `.../login`, `.../forgot-password` |
| 2 | **Super Admin** | `admin.hr.com` | Us (SaaS operator) | `apps/platform` (superadmin area) | `apps/platform/app/superadmin`, `(unified-admin)`, `packages/admin-core` |
| 3 | **Tenant Admin (HR console)** | `app.hr.com` | Employer HR / Finance | `apps/hr` (admin area) | `packages/ui` (`admin.js`), `packages/admin-core`, `apps/router` tenant resolution |
| 4 | **Employee Self-Service (ESS)** | `tenant.com` / `tenant.hr.com` | Employees, managers | `apps/hr` (ESS area) + `apps/mobile` | `apps/router`, `packages/theme-engine` (slimmed), Cloudflare-for-SaaS domains |

Tenant resolution (host → tenant) reuses `apps/router` and the row-level `businessId` isolation already in the backend (here renamed conceptually to `tenantId`; see `03-data-model.md`). The custom-domain + SSL pipeline (Cloudflare-for-SaaS, OpenProvider) is reused wholesale for surface 4.

### 1.1 Surface 1 — Marketing + Onboarding (`hr.com`)

**Purpose:** sell → sign up → guided company-setup wizard → hand off to surface 3.

```
hr.com/
├── /                      Home (value prop, IN/NZ market badges)
├── /pricing               Per-seat plans × country currency (INR/NZD)
├── /features/*            Module landing pages (payroll, leave, ESS, compliance-IN, compliance-NZ)
├── /compliance/india      "We keep you compliant" — Labour Codes, EPF/ESI/PT/TDS
├── /compliance/new-zealand Holidays Act 2003, PAYE/payday filing, KiwiSaver
├── /security              SOC-posture, data residency, RBAC
├── /signup                Email + password + country pick  → creates Tenant (Trial)
├── /login                 → routes to app.hr.com or tenant domain by role
├── /onboarding            The guided setup wizard (see §5.1) — gated behind auth
└── /legal/*               Terms, Privacy, DPA, sub-processors
```

**Reuse:** `apps/platform/app/signup/page.js`, `.../login`, `.../forgot-password`, `.../legal` exist and are reused with HR copy. The marketing pages themselves are static/MDX — we do **not** reuse the storefront/website-builder.

### 1.2 Surface 2 — Super Admin (`admin.hr.com`)

We operate the SaaS. IA mirrors `apps/platform/app/superadmin` + `(unified-admin)` and `packages/admin-core`.

```
admin.hr.com/
├── /dashboard             Platform KPIs: MRR, active tenants, payruns/day, failed payouts
├── /tenants               List, search, status (Trial/Active/Past-due/Suspended/Churned)
│   └── /tenants/:id       Profile, entities, seats, plan, billing, impersonate, audit
├── /plans                 Plan catalog + per-seat pricing + feature-flag matrix
├── /promos                Promo codes (reuse billing/promo engine)
├── /billing               Gateway ops: Razorpay (IN) / Stripe (NZ) / Paddle (RoW)
├── /compliance-rules      Versioned per-country rule tables (the crown jewels)
│   ├── /india/:version    Slabs, EPF/ESI/PT, TDS, gratuity — effective-dated
│   └── /new-zealand/:ver   PAYE, ACC, KiwiSaver, ESCT, student loan, min wage
├── /feature-flags         Plan × flag grid
├── /analytics             Cohort, funnel, module adoption, payrun success rate
├── /support               Impersonation sessions, ticket links
└── /audit                 Immutable platform audit log
```

**Compliance-rules editor** is the most consequential SA screen. It is **versioned and effective-dated**: an operator creates rule set `IN v2026.04` with an `effectiveFrom` of `2026-04-01`, fills slabs/rates, runs a **diff vs prior version**, and **publishes**. Pay runs bind to the rule version effective on the pay-period end date — never "latest." See §5.2 and `05-compliance-india.md`/`06-compliance-newzealand.md`. The editor is a structured form per rule type, **not** free-form JSON, with validation (e.g., PT cap ≤ ₹2,500/yr; KiwiSaver default = 3.5% from 2026-04-01).

**Impersonation** reuses the admin-core support pattern: SA enters a tenant in read-or-write mode; a persistent **red top banner** ("Impersonating Acme Pvt Ltd — exit") is shown on every screen; every action is stamped `actorType=SUPER_ADMIN_IMPERSONATING` in audit (see `06-rbac-and-approvals.md`).

### 1.3 Surface 3 — Tenant Admin / HR Console (`app.hr.com`)

The employer's HR & Finance team configures and runs everything. This is the densest surface.

```
app.hr.com/
├── /home                  Role-aware dashboard (tasks, approvals, this month's payrun)
├── /people                Directory, org chart, employee profiles
│   └── /people/:id        Profile · Job · Comp · Statutory IDs · Documents · History
├── /onboarding            Onboarding pipelines (offer→joined→provisioned)
├── /time
│   ├── /attendance        Registers, regularization, shifts
│   └── /leave             Policies, balances, requests, holiday calendars
├── /payroll
│   ├── /runs              Pay-run list + the run-payroll wizard (§5.2)
│   ├── /components        Earnings/deductions library (CONFIGURE, not build)
│   ├── /statutory         EPF/ESI/PT/TDS (IN) · PAYE/KiwiSaver/ESCT (NZ) setup
│   └── /payslips          Generated payslips, bulk dispatch
├── /expenses              Claims, approvals, reimbursement in payroll
├── /loans                 Advances & loan schedules
├── /assets                IT-asset lifecycle + offboarding clearance
├── /filings               IN: Form 24Q, Form 16. NZ: payday filing to IRD
├── /reports               Registers, GL export, cost-to-company, variance
├── /settings
│   ├── /entities          Legal entities (country, currency, statutory regns)
│   ├── /branding          Logo · brand color · style · custom domain (the 4 knobs)
│   ├── /pay-calendars     Cycles, cutoffs, pay dates per entity
│   ├── /roles             RBAC (reuse auth/RBAC)
│   ├── /approvals         Approval chains (leave, expense, payrun)
│   ├── /integrations      Bank file formats, accounting export
│   └── /billing           Their subscription with us (seats, plan, invoices)
└── /audit                 Tenant-scoped audit log
```

**Vocabulary localizes per active entity.** When the active entity is IN: "Provident Fund," "Professional Tax," "CTC," "₹." When NZ: "KiwiSaver," "PAYE," "annual leave (weeks)," "$." The active-entity switcher lives in the top bar (see §3.2).

### 1.4 Surface 4 — Employee Self-Service (`tenant.com`)

White-labeled. The employee sees the tenant's brand, never ours. Mobile-first (most employees are phone-primary; see `apps/mobile` and `12-mobile-ess.md`).

```
tenant.com/
├── /                      Today: next payday, leave balance, pending tasks, announcements
├── /payslips             List + single payslip (print/PDF, screen-reader navigable)
├── /tax                   IN: Form 16, regime declaration, investment proofs (80C etc.)
│                          NZ: PAYE summary, KiwiSaver rate, tax code (IR330)
├── /leave                 Balances by type · apply · history · team calendar
├── /attendance            Clock in/out, regularization requests, timesheets
├── /expenses              Submit claim, track reimbursement
├── /profile               Personal, bank, statutory IDs (PAN/UAN · IRD/KiwiSaver)
├── /documents             Letters, policies, signed offer, payslips archive
├── /approvals             (managers) inbox: leave/expense/timesheet approvals
└── /directory             Org directory (privacy-scoped)
```

ESS theming reuses `packages/theme-engine` slot resolution (`resolveThemeSlots`, `composeTheme`) **slimmed to the five styles** — the contract-version normalization stays; the 60+ profession registries (`profession-registry.mjs`, `profession-styles.mjs`) and the 100 `layout-presets.cjs` are deleted.

---

## 2. The Five Fixed Styles

A **style** is a coherent token set (a "look"). Tenants pick exactly one per entity-brand. The white-label brand color overrides the style's `primary`; the logo fills the brand slot. Nothing else is designable. This is the deliberate replacement for Sitepresso's 100 layout presets and 60+ profession themes.

Implementation: a style is a frozen token object resolved into CSS custom properties at render. We reuse the **CSS-variable injection pattern already in `packages/ui/admin.js`**, where primitives read `style={{ backgroundColor: 'var(--theme-primary)' }}` and `var(--theme-primary, #4f46e5)`. We keep that exact variable name (`--theme-primary`) so reused primitives work unchanged.

### 2.1 The five styles, named

| Key | Name | Personality | Default audience |
|-----|------|-------------|------------------|
| `crisp` | **Crisp** | Clean, neutral, high-legibility SaaS default. Indigo accent, generous whitespace. | Tech / modern SMB (default) |
| `corporate` | **Corporate** | Trust-forward, navy, conservative, denser. | Enterprise, finance, manufacturing |
| `warm` | **Warm** | Friendly, rounded, amber/terracotta, soft surfaces. | Hospitality, retail, services |
| `minimal` | **Minimal** | Monochrome, flat, maximum restraint, hairline borders. | Design-led / agencies |
| `vibrant` | **Vibrant** | Energetic, violet/electric, bold, slightly playful. | Startups, creative |

The five seed palettes draw from Sitepresso's real `COLOR_PRESETS` in `packages/theme-engine/theme-colors.mjs` (e.g., `indigo_sky`, `navy_gold`, `terracotta`, `monochrome`, `violet`), proving the color machinery already exists.

### 2.2 Design tokens per style

All five styles share a single **token contract** (the keys). Only values differ. Three token tiers:

- **Primitive** (raw scales — gray-50…gray-900, the type ramp, the space ramp). Identical across styles.
- **Semantic** (role tokens — `primary`, `surface`, `text`, `border`, `success`, `warn`, `danger`, `info`). Differ per style.
- **Component** (e.g., `button.radius`, `input.height`) derived from semantic + style density.

**Color — semantic tokens (default/`crisp` shown; others differ on `primary`/`surface`/`accent` only):**

| Token | crisp | corporate | warm | minimal | vibrant |
|-------|-------|-----------|------|---------|---------|
| `--color-primary` | `#4F46E5` | `#0E1B33` | `#8A4238` | `#1A1A1A` | `#7C3AED` |
| `--color-accent` | `#38BDF8` | `#C9A95F` | `#D97757` | `#4A4A4A` | `#A855F7` |
| `--color-surface` | `#FFFFFF` | `#FFFFFF` | `#FBF4EE` | `#FFFFFF` | `#FFFFFF` |
| `--color-bg` | `#F7F8FA` | `#F4F6F9` | `#FBF7F2` | `#FAFAFA` | `#F7F5FF` |
| `--color-text` | `#0F172A` | `#0E1B33` | `#2A211C` | `#111111` | `#1E1B2E` |
| `--color-text-muted` | `#64748B` | `#5A6677` | `#7A6E64` | `#6B6B6B` | `#6B6480` |
| `--color-border` | `#E2E8F0` | `#D7DEE7` | `#E8DDD2` | `#EAEAEA` | `#E6E0F5` |
| `--color-success` | `#15803D` | `#15803D` | `#15803D` | `#1F1F1F`* | `#15803D` |
| `--color-warn` | `#B45309` | `#B45309` | `#B45309` | `#444`* | `#B45309` |
| `--color-danger` | `#DC2626` | `#DC2626` | `#DC2626` | `#DC2626` | `#DC2626` |

\* Minimal keeps status meaning via **icon + label + position**, not hue, so it never relies on color alone (WCAG 1.4.1). Danger always stays red — irreversible actions must read as dangerous in every style.

> **Hard rule:** `danger`, `warn`, `success` keep stable *meaning* across styles even when hue shifts; payroll/destructive actions are never re-skinned into looking benign.

**Typography:**

| Token | crisp | corporate | warm | minimal | vibrant |
|-------|-------|-----------|------|---------|---------|
| `--font-sans` | Inter | Inter | Inter | Inter | Inter |
| `--font-display` | Inter | Inter | "Source Serif" | Inter | Inter |
| `--font-numeric` | "Inter Tabular" (tnum) | tnum | tnum | tnum | tnum |
| base size | 16px | 16px | 16px | 16px | 16px |

Type ramp (shared, modular 1.20 minor-third): `xs 12 · sm 14 · base 16 · lg 18 · xl 20 · 2xl 24 · 3xl 30 · 4xl 36`. Line-heights: body 1.5, headings 1.25, dense tables 1.4. **All currency, hours, and statutory figures render with `font-variant-numeric: tabular-nums`** so columns align — critical for payslips and registers.

**Spacing (shared 4px base ramp):** `0 4 8 12 16 20 24 32 40 48 64`. Tokens `--space-1…--space-12`.

**Radius:**

| Token | crisp | corporate | warm | minimal | vibrant |
|-------|-------|-----------|------|---------|---------|
| `--radius-sm` | 6px | 4px | 10px | 2px | 8px |
| `--radius-md` | 8px | 6px | 14px | 3px | 12px |
| `--radius-lg` | 12px | 8px | 18px | 4px | 16px |
| `--radius-pill` | 9999 | 9999 | 9999 | 4px | 9999 |

(Sitepresso primitives already use `rounded-lg`/`rounded-2xl`; we map those Tailwind classes to these tokens.)

**Density / elevation:**

| Token | crisp | corporate | warm | minimal | vibrant |
|-------|-------|-----------|------|---------|---------|
| row height (table) | 44px | 40px | 48px | 44px | 48px |
| control height | 40px | 36px | 44px | 40px | 44px |
| shadow | soft md | soft sm | soft lg | none (border only) | soft lg |
| field border | 1px | 1px | 1px | 1px | 1.5px |

**Two density modes** are available independent of style on data-heavy admin screens (registers, pay-run tables): **Comfortable** (default) and **Compact** (−4px row height, −2px control height). This is a *user* preference (HR power-users want compact), stored per user, not a tenant branding decision.

### 2.3 White-label injection — how brand color + logo slot in

Stored on the entity-brand record (extends Sitepresso's `Subscription.themeColors` JSON shape from `theme-colors.mjs`):

```jsonc
// EntityBrand.branding
{
  "style": "crisp",                 // one of the 5 fixed keys
  "brandColor": "#1B6CA8",          // ONE color → overrides --color-primary
  "logo": { "light": "r2://.../logo-light.svg",
            "dark":  "r2://.../logo-dark.svg",
            "mark":  "r2://.../favicon.png" },
  "domain": "people.acme.co.nz"     // bound custom domain (surface 4)
}
```

**Resolution pipeline (reuses `theme-engine` + `theme-colors.mjs`):**

1. Load the fixed style token set by `style` key.
2. `sanitizeColorOverrides({ primary: brandColor })` — the **existing** validator in `theme-colors.mjs` (hex `#RGB`/`#RRGGBB`, silently drops invalid). We constrain tenants to **only `primary`**; `accent`/`surface`/`bg`/`text` stay style-locked (brand limited to one color, per `00-vision-and-principles.md`).
3. **Auto-derive dependent values** so a brand color never breaks legibility:
   - `--color-primary-hover` = primary darkened 8%.
   - `--color-primary-contrast` = white or near-black chosen by computed contrast ratio (must be ≥ 4.5:1 against primary; if the chosen brand color can't reach AA on white text *and* a label sits on it, we add a subtle outline rather than silently failing).
   - `--color-focus-ring` = primary at 40% alpha.
4. Emit CSS custom properties (`--color-primary`, `--theme-primary` alias for reused primitives) onto `:root`.
5. **Logo slot:** `light` for light surfaces, `dark` for dark headers/footers, `mark` for favicon/app icon/email. Logos are uploaded, validated (SVG/PNG, max 512KB, transparent bg preferred), and stored in R2; **never** a layout the tenant designs.

**Brand-color validation at upload (Settings → Branding):** live preview shows the color applied to a Primary button, a status pill, and a payslip header. If contrast of `primary-contrast` text on the chosen color < 3:1 we **block** and explain ("This color is too light for white button text — pick a darker shade"). This is a configure-time guardrail, not a builder.

---

## 3. Navigation Patterns

### 3.1 Shell archetypes

| Surface | Shell | Pattern |
|---------|-------|---------|
| Super Admin | `packages/admin-core` shell | Left rail (collapsible) + top bar + impersonation banner |
| Tenant Admin | HR admin shell (new, built on `packages/ui` primitives) | Left rail (module nav) + top bar (entity switcher, search, notifications, profile) |
| ESS web | White-label shell | Top bar (tenant logo) + simple horizontal nav; mobile: bottom tab bar |
| Mobile | `apps/mobile` | Bottom tab bar (Home · Payslips · Leave · More) |

### 3.2 Tenant Admin shell — the top bar

Left→right: **tenant logo · global search (⌘K) · ENTITY SWITCHER · pending-approvals bell · help · profile menu**.

- **Entity switcher** is the single most important control: it sets the active legal entity, which drives country vocabulary, currency, statutory labels, validation, and which compliance rule version applies. A persistent **country chip** (`🇮🇳 IN · INR` / `🇳🇿 NZ · NZD`) sits beside it so the user always knows the regime context. Switching entities never loses unsaved work in a wizard (we warn).
- **Global search (⌘K command palette):** people, pay runs, settings, actions ("Run payroll," "Approve leave"). Reuses the command-palette pattern; results are RBAC-scoped.

### 3.3 Left rail

Module groups (People · Time · Payroll · Pay-adjacent · Filings · Reports · Settings). Collapsible to icons. **Plan-gated items** appear with a lock glyph and a tooltip ("Available on Growth plan") rather than disappearing — discoverability drives upsell. Feature flags come from the plan (reuse Sitepresso plan feature-flag system).

### 3.4 Within-page navigation

- **Tabs** for entity sub-views (Profile · Job · Comp · Statutory · Documents · History).
- **Wizard stepper** (numbered, with completed/current/upcoming states) for irreversible multi-step flows (signup-setup, run-payroll, onboarding).
- **Master-detail** (list left, detail right) for approvals inbox, pay-run employee drill-down, leave requests.
- **Breadcrumbs** on deep pages (Payroll → Runs → Jun 2026 → E. Sharma).

### 3.5 Notifications & approvals

A unified **approvals inbox** (leave, expense, timesheet, pay-run sign-off) with a top-bar badge. Reuses Sitepresso notifications infra. Each item shows requester, type, amount/duration, SLA age, and inline approve/reject with a required comment on reject.

---

## 4. Component Inventory — Reuse vs. Build

### 4.1 Reuse from Sitepresso `packages/ui/admin.js` (verified, real exports)

These are imported unchanged (they already read `--theme-primary`):

| Component / util | Path | Use in HRMS |
|---|---|---|
| `Spinner`, `Centered`, `ErrorBanner`, `Empty` | `packages/ui/admin.js` | Loading/empty/error states everywhere |
| `Modal`, `ModalActions` | `packages/ui/admin.js` | Confirmations, edit dialogs (`size: sm \| lg`) |
| `PrimaryButton` | `packages/ui/admin.js` | Primary actions (reads `var(--theme-primary)`) |
| `TextInput`, `TextArea` | `packages/ui/admin.js` | All form text fields |
| `DateInput`, `DateField`, `TimeInput`, `TimeField` | `packages/ui/admin.js` | Leave dates, attendance times, pay dates |
| `formatAdminDate`, `formatAdminDateTime` | `packages/ui/admin.js` | Consistent date rendering |
| `formatMoneyMinor` | `packages/ui/admin.js` | **Money is stored/handled in minor units** — payslips, registers |
| `billingStatusClass`, `billingTransactionStatusClass` | `packages/ui/admin.js` | Status pills (subscription, payout) |
| `capitalizeSlug` | `packages/ui/admin.js` | Labels |

`packages/ui/index.js` re-exports all of `admin.js`, so HR apps `import { Modal, formatMoneyMinor } from '@sitepresso/ui'` (package will be re-scoped, e.g. `@hrms/ui`).

Also reused: `packages/admin-core` (admin shell + impersonation), `packages/theme-engine` (`composeTheme`, `resolveThemeSlots`, `normalizeThemeConfig`, `validateThemeContract` — slimmed to 5 styles), `theme-colors.mjs` (`COLOR_PRESETS`, `sanitizeColorOverrides`, `getColorPreset`).

### 4.2 New HR-specific components to build

| Component | Purpose | Notes / a11y |
|---|---|---|
| `EntitySwitcher` | Active legal-entity selector + country chip | Sets regime context; keyboard-navigable listbox |
| `CountryChip` | `🇮🇳 IN · INR` / `🇳🇿 NZ · NZD` badge | Decorative flag has `aria-hidden`; text is the label |
| `WizardStepper` | Numbered step rail for irreversible flows | `aria-current="step"`, step status announced |
| `MoneyInput` | Minor-unit currency input w/ symbol, tnum | Locale grouping (IN lakh vs NZ thousand) |
| `MoneyDisplay` | Read-only currency w/ tabular-nums | Wraps `formatMoneyMinor` |
| `StatutoryBadge` | "ESI 0.75% · IN v2026.04" traceability chip | Click → rule-version drawer |
| `RuleVersionDrawer` | Shows the rule set, effective date, formula | Read-only, links to SA source |
| `PayslipView` | Canonical payslip (screen + print + PDF) | Semantic table, print stylesheet, see `09-modules-pay-adjacent.md` |
| `PayRunWizard` | The run-payroll flow (§5.2) | Review gate + typed confirm |
| `VarianceTable` | Period-over-period delta (₹/% per employee) | Sortable, flags > threshold |
| `LeaveBalanceCard` | Per-type balance, accrual, encashable | NZ weeks vs IN days handled |
| `LeaveCalendar` / `TeamCalendar` | Holiday + leave overlay | Public-holiday source per region |
| `HolidaysActPanel` (NZ) | Relevant-daily-pay vs avg-daily-pay, lieu days | Flagship; shows both calcs + chosen basis |
| `RegimeSelector` (IN) | New (default) vs Old tax regime declaration | New is pre-selected; old is opt-in |
| `OrgChart` | Reporting hierarchy | Tree, keyboard-traversable |
| `ApprovalInbox` | Unified approvals | Inline approve/reject + reason |
| `DocumentSigner` | Offer/letter acknowledgement | E-sign acknowledge flow |
| `BankFilePreview` | Pre-payout bank file (NEFT/IMPS · NZ batch) | Read-only audit of what posts |
| `DataTable` (HR) | Virtualized, sticky header, density toggle, CSV/GL export | Sort/filter/select; `role="table"`, sortable `aria-sort` |
| `EmptyStateGuide` | "No pay runs yet → start one" | Action-oriented onboarding nudge |

### 4.3 Deleted Sitepresso UI we do NOT carry

`website-builder` (the page builder), `layout-presets.cjs` (100 storefront layouts), `profession-registry.mjs` / `profession-styles.mjs` (60+ profession themes), `ecom-ui`, `blog-ui`, storefront section variants, and the chat-widget packages. These violate "configure, not build."

---

## 5. Key End-to-End Flows

Each flow names every screen/step, the state, validation, edge cases, and the API surface. Money is in **minor units** throughout (paise/cents) per `formatMoneyMinor`.

### 5.1 Flow A — Signup → Company Setup (`hr.com` → `app.hr.com`)

**Goal:** prospect to a tenant that can run its first payroll. Reuses `apps/platform/app/signup` and `.../onboarding` skeleton.

```
State machine (Tenant.onboardingStatus):
  SIGNED_UP → COMPANY_SET → ENTITY_SET → PAY_CALENDAR_SET
            → COMPONENTS_SET → EMPLOYEES_IMPORTED → STATUTORY_SET → READY
```

**Wizard steps (`/onboarding`, `WizardStepper`):**

| Step | Screen | Captures | Validation | Edge cases |
|---|---|---|---|---|
| 0 | **Signup** | Email, password, **country (IN/NZ)** | Email format; password ≥ 12 chars; country required (sets first entity + currency + rule set) | Existing email → route to login; disposable-email block |
| 1 | **Company** | Legal name, trading name, industry, size band | Name required | Size ≥ 20 (IN) primes EPF; ≥10 primes ESI — we *flag* but don't force |
| 2 | **Legal entity** | Country, currency, registered address, statutory regns (IN: PAN, TAN, PF code, ESIC code, PT state; NZ: IRD number, NZBN) | Country-specific format checks (PAN regex, IRD checksum) | Multi-entity tenant: "Add another entity" loops this step; an entity may have regns "applied for" → allowed, flagged |
| 3 | **Pay calendar** | Cycle (monthly default both markets), period boundaries, cutoff day, pay date, first run month | Pay date after cutoff; first run not in the past | NZ may pay fortnightly/weekly → cycle picker; arrears handling noted |
| 4 | **Pay components** | Pick from pre-built earnings/deductions; set Basic %, HRA, allowances | **IN guardrail: Basic+DA ≥ 50% of total remuneration** (Labour Codes, live 21 Nov 2025) — wizard blocks save until satisfied | If user sets Basic 40%, inline error + auto-suggest 50%; cascades to PF/gratuity warning |
| 5 | **Employees** | CSV import or manual add; map columns | Required: name, DOJ, comp, statutory IDs (UAN/PAN · IRD/KiwiSaver) | Partial rows → draft employees; dedupe on PAN/IRD; bad rows downloadable |
| 6 | **Statutory setup** | IN: EPF (12%/12%, EPS 8.33% cap ₹15,000, ESI 0.75%/3.25% ≤ ₹21,000 gross, PT state slabs ≤ ₹2,500/yr, TDS) · NZ: PAYE, KiwiSaver (default 3.5% from 1 Apr 2026), ESCT, student loan, ACC levy (1.75% on first $156,641) | Country thresholds enforced; rule version bound | Employer below EPF/ESI threshold → setup optional, clearly labeled |
| 7 | **Review & finish** | Summary of all above | All prior steps complete | "Run your first payroll" CTA → §5.2 |

**Resumability:** wizard state persists; user can leave and return. Each step is a `PATCH /api/onboarding/:tenantId` updating `onboardingStatus`. Skippable steps (e.g., statutory if below threshold) are explicitly marked, never silently bypassed.

**API surface (illustrative):**
```
POST   /api/auth/signup            { email, password, country }
POST   /api/tenants                { legalName, tradingName, industry, sizeBand }
POST   /api/entities               { tenantId, country, currency, regns{} }
POST   /api/pay-calendars          { entityId, cycle, cutoffDay, payDate }
GET    /api/pay-components/catalog?country=IN
POST   /api/pay-structures         { entityId, components[] }   // validates Basic+DA ≥ 50%
POST   /api/employees/import       multipart CSV → { imported, errors[] }
POST   /api/statutory/setup        { entityId, scheme, config, ruleVersion }
PATCH  /api/onboarding/:tenantId   { status }
```

### 5.2 Flow B — Run Payroll (`app.hr.com` → `/payroll/runs`)

The flagship admin flow. Mirrors the pay-run state machine in `04-payroll-engine-design.md`. **Stepped wizard with a frozen review gate and typed confirmation.**

```
PayRun state machine:
  DRAFT → INPUTS_LOCKED → CALCULATED → IN_REVIEW → APPROVED
        → PAYOUT_PENDING → PAID → FILED
  (any pre-PAID state → DISCARDED;  PAID → REVERSED only via off-cycle correction)
```

**Wizard steps (`PayRunWizard`):**

| Step | Screen | What happens | Validation / guardrails | Edge cases |
|---|---|---|---|---|
| 1 | **Select period & entity** | Pick entity + pay period; system shows headcount, last run | One open run per (entity, period); active period only | Mid-period joiners/leavers flagged for proration |
| 2 | **Lock inputs** | Pull attendance, leave (LWP), variable pay, expenses, loan EMIs, one-time adjustments | Unapproved leave/expense surfaced as blockers or "exclude" | New hire without bank details → blocker; on-hold employees excluded |
| 3 | **Calculate** | Engine runs; binds the **compliance rule version effective on period-end** | Rule version pinned and shown via `StatutoryBadge` | Rule changed mid-period (e.g., min-wage 1 Apr) → engine splits/uses period-end version per `06-compliance-newzealand.md` |
| 4 | **Review** (the gate) | `VarianceTable` (Δ vs last month, % flags), per-employee drill-down, statutory totals (EPF/ESI/PT/TDS or PAYE/KiwiSaver/ESCT), exceptions list | Anomalies > threshold (e.g., net change > 25%) must be acknowledged | Negative net pay → hard block; zero-pay employees listed; NZ Holidays Act: shows **relevant-daily-pay vs average-daily-pay** chosen basis per leave taken (flagship — provable correctness) |
| 5 | **Approve** | Approver(s) sign off per approval chain | RBAC: preparer ≠ approver (segregation of duties) | Multi-approver chain; rejection returns to DRAFT with notes |
| 6 | **Confirm payout** | `BankFilePreview` of exact debits; **typed confirmation** ("type RUN to confirm ₹X to N employees") | Final irreversible gate; totals re-verified server-side | Insufficient-funds / gateway down → PAYOUT_PENDING retry queue |
| 7 | **Paid & file** | Generate payslips (`PayslipView`), dispatch (ESS + email), queue filings | — | IN: TDS deposit by 7th, PF/ESIC by 15th, Form 24Q quarterly; NZ: **payday filing within 2 working days** auto-scheduled to IRD |

**Why typed confirmation:** payroll feels irreversible (money leaves). The typed gate (principle #2) prevents fat-finger disasters and creates a deliberate, auditable moment. Every transition writes to the tenant audit log with actor + rule version.

**API surface:**
```
POST  /api/payruns                 { entityId, period }        → DRAFT
POST  /api/payruns/:id/lock-inputs                              → INPUTS_LOCKED
POST  /api/payruns/:id/calculate                               → CALCULATED (binds ruleVersion)
GET   /api/payruns/:id/review      → { variance[], statutoryTotals, exceptions[] }
POST  /api/payruns/:id/approve     { approverId, comment }     → APPROVED
POST  /api/payruns/:id/payout      { confirmToken:"RUN" }      → PAYOUT_PENDING→PAID
POST  /api/payruns/:id/file        { regime }                  → FILED
POST  /api/payruns/:id/discard                                 → DISCARDED
```

### 5.3 Flow C — Apply for Leave (`tenant.com` → `/leave`)

Employee-facing, mobile-first, white-labeled. The hardest calculation is NZ (Holidays Act 2003).

```
LeaveRequest state machine:
  DRAFT → SUBMITTED → (APPROVED | REJECTED | WITHDRAWN)
  APPROVED → (CANCELLED | TAKEN)
```

| Step | Screen | Captures | Validation | Edge cases |
|---|---|---|---|---|
| 1 | **Balances** | `LeaveBalanceCard` per type (IN: EL/CL/SL in **days**; NZ: annual leave in **weeks**, sick, bereavement, alternative/lieu days, public holidays) | — | NZ: balance in weeks; UI shows weeks + an estimated-days hint |
| 2 | **Apply** | Type, dates (`DateField`), half-day, reason | Date ≥ today (or policy back-date window); within balance; honors blackout dates | Overlaps existing request → block; sandwich-leave / holiday-in-range rules; NZ public holiday inside range auto-excluded |
| 3 | **Preview** | Working days consumed, balance after, pay impact | LWP if insufficient balance → shown explicitly | NZ: which pay basis (relevant-daily vs average-daily) the day(s) will use, surfaced via `HolidaysActPanel` |
| 4 | **Submit** | Routes to manager via `ApprovalInbox` | Approval chain from settings | Auto-approve policies (e.g., ≤1 day sick) allowed if configured |
| 5 | **Track** | Status + history | — | Manager out-of-office → escalation; withdrawal before approval |

**NZ Holidays Act note:** annual leave is **measured in weeks** and paid at the **greater of ordinary weekly pay or average weekly earnings**; daily leave types use **relevant daily pay vs average daily pay**; lieu/alternative days for working a public holiday. This is the highest-value, error-prone calculation and our flagship NZ feature — the UI always shows both candidate figures and the chosen basis (provable correctness). See `06-compliance-newzealand.md`.

```
GET   /api/leave/balances?employeeId
POST  /api/leave/requests          { type, from, to, halfDay, reason } → SUBMITTED
GET   /api/leave/requests/:id/preview → { workingDays, balanceAfter, payBasis, payImpact }
POST  /api/leave/requests/:id/approve | /reject | /withdraw | /cancel
```

### 5.4 Flow D — Onboard an Employee (`app.hr.com` → `/onboarding`)

HR-driven pipeline from offer to payroll-ready.

```
EmployeeOnboarding state machine:
  OFFER_DRAFT → OFFER_SENT → OFFER_ACCEPTED → DOCS_PENDING
              → DOCS_VERIFIED → PROVISIONED → JOINED
  (OFFER_SENT → OFFER_DECLINED;  any → WITHDRAWN)
```

| Step | Screen | Captures | Validation | Edge cases |
|---|---|---|---|---|
| 1 | **Create offer** | Candidate, role, comp structure (uses pay components), DOJ, entity | Basic+DA ≥ 50% (IN); comp within band | Multi-entity: pick entity → sets country rules |
| 2 | **Send & accept** | E-sign offer (`DocumentSigner`) | — | Decline → close; re-offer allowed |
| 3 | **Collect docs** | Statutory IDs (IN: PAN, UAN/Aadhaar, bank; NZ: IRD number, tax code IR330, KiwiSaver status, bank), personal, emergency | Format + checksum (PAN/IRD); bank account validation | NZ new hire KiwiSaver auto-enrol (incl. **16–17 yr olds now employer-eligible from 1 Apr 2026**); IRD-number-pending allowed with no-notification tax-code handling |
| 4 | **Verify** | HR verifies docs | All mandatory present | Missing → DOCS_PENDING with checklist |
| 5 | **Provision** | Generate employee ID, assign manager, leave policy, pay calendar, ESS invite | Manager exists; policy assigned | Future-dated joiners excluded from current run until DOJ |
| 6 | **Joined** | Employee active; appears in next pay run (prorated) | — | DOJ mid-period → proration in §5.2 |

```
POST  /api/onboarding/offers        { candidate, entityId, comp, doj } → OFFER_DRAFT
POST  /api/onboarding/offers/:id/send | /accept | /decline
POST  /api/employees/:id/documents  { type, file }
POST  /api/employees/:id/verify
POST  /api/employees/:id/provision  { managerId, leavePolicyId, payCalendarId }
```

---

## 6. Accessibility (WCAG 2.2 AA) — launch gate

| Area | Requirement | How |
|---|---|---|
| **Contrast** (1.4.3) | Text ≥ 4.5:1; UI/graphics ≥ 3:1 | Token pairs pre-verified; brand-color guardrail (§2.3) blocks failing combos; `crisp`/`minimal` are the safe baselines |
| **Color not sole signal** (1.4.1) | Status conveyed by icon+label+position too | `minimal` style proves this; status pills always carry text |
| **Keyboard** (2.1.1) | All flows operable without mouse | Wizards, command palette (⌘K), data tables, entity switcher all keyboard-navigable; visible focus ring (`--color-focus-ring`) |
| **Focus visible & order** (2.4.7, 2.4.3) | Logical order, never trapped | Modals trap+restore focus (extend reused `Modal`); skip-to-content link |
| **Target size** (2.5.8 — new in 2.2) | Interactive targets ≥ 24×24 CSS px | Control heights 36–48px; mobile tap targets ≥ 44px |
| **Labels & instructions** (3.3.2) | Every field labeled; errors named | `TextInput`/`DateInput` carry `label`+`hint`; errors via `aria-describedby` |
| **Error prevention** (3.3.4 — legal/financial) | Reversible / checked / confirmed for payroll | The typed-confirm review gate (§5.2) satisfies this for money movement |
| **Status messages** (4.1.3) | Async results announced | Toasts/`ErrorBanner` use `role="status"`/`role="alert"` |
| **Reduced motion** | Respect `prefers-reduced-motion` | Spinner/transitions degrade gracefully |
| **Payslips & tax docs** | Screen-reader navigable + printable | `PayslipView` is a semantic `<table>` with caption + scope, dedicated print stylesheet, tagged PDF |
| **i18n** | en/hi reuse + locale numerals | Reuse Sitepresso i18n (`en`/`hi`); IN lakh grouping vs NZ thousands; RTL not required at launch |
| **Zoom/reflow** (1.4.10) | Usable at 400% zoom / 320px width | Responsive layouts, no horizontal scroll except data tables |

We add automated axe-core checks in CI and a manual screen-reader pass (NVDA + VoiceOver) on the four key flows as a release gate.

---

## 7. Responsive & Mobile

| Surface | Strategy |
|---|---|
| **Marketing** | Fully responsive, mobile-first marketing pages |
| **Super Admin** | Desktop-primary (operator tooling); usable to tablet; no phone optimization required |
| **Tenant Admin** | Desktop-primary for dense work (pay runs, registers) but **responsive-degraded**: approvals, employee lookup, and approve-payrun-on-the-go work on tablet/phone. Data tables become stacked cards below `md`; the pay-run *review* keeps a horizontal-scroll table with sticky first column. |
| **ESS** | **Mobile-first.** Most employees are phone-primary. Bottom-tab navigation on phone; payslip, leave-apply, clock-in optimized for thumb. |
| **Mobile app** (`apps/mobile`) | Native shell, bottom tabs (Home · Payslips · Leave · More), push notifications (payslip ready, leave approved, payday). See `12-mobile-ess.md`. |

**Breakpoints (shared tokens):** `sm 640 · md 768 · lg 1024 · xl 1280 · 2xl 1536`. Admin dense tables target `lg+`; below `md` they reflow to cards (except the pay-run review, which stays tabular with sticky columns because alignment is the point).

**Print:** payslips, Form 16 (IN) / PAYE summaries (NZ), and pay registers each have a dedicated print stylesheet (A4, mono-safe, no chrome, tabular-nums preserved).

---

## 8. Cross-Surface Consistency & Theming Boundaries

- **Our chrome (surfaces 1–3)** uses `crisp` as the product default and is **not** white-labeled — `hr.com`/`admin.hr.com`/`app.hr.com` carry our brand. Only **surface 4 (ESS at `tenant.com`)** is white-labeled with the tenant's logo + brand color + chosen style.
- The **same token contract** powers all four surfaces; only surface 4 swaps the resolved style/brand-color values per tenant via the `theme-engine` pipeline (§2.3). This guarantees a single design system, not four.
- **Email** (payslip-ready, leave-approved, invite) is white-labeled per tenant using the `mark` logo and `primary` color, reusing Sitepresso notifications + theming.

---

## 9. Open Items Escalated to the Founder

See StructuredOutput `openQuestions`. The load-bearing ones: exact mapping of plan tiers → feature-flag visibility in the left rail; whether ESS gets dark mode at launch (the five styles are light-first); and whether `corporate`/`vibrant` brand-color overrides need stricter contrast clamping than `crisp`.

---

*End of doc 13. Sibling cross-refs: `00`, `01`, `02`, `03`, `04`, `05`, `06`, `07`, `08`, `09`, and forward refs `06-rbac-and-approvals.md`, `12-mobile-ess.md`.*
