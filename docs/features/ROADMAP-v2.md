# DriftHR Build Roadmap v2

Build-ready specs, sequenced for parallel-worktree delivery, in two waves:

- **Wave A — Features 10–13** (approval engine + its consumers). Shipped/in-flight. Foundation: **Feature 10 (approval workflows + RBAC)** — the reusable approval engine that 11, 12, 13 all route through.
- **Wave B — Features 14–19** (India-deepening). Foundation: **Feature 14 (single-country mode)** — a small foundation that locks every tenant to its registered country and gates the rest of the wave to India.

Specs:
- [10 — Approval Workflows + RBAC](./10-approval-workflows-rbac.md)
- [11 — Reimbursement + Travel](./11-reimbursement-travel.md)
- [12 — Recruitment ATS](./12-recruitment-ats.md)
- [13 — Profile + Manager Self-Service + Org Tree](./13-profile-mss-orgtree.md)
- [14 — Single-Country Mode](./14-single-country-mode.md)
- [15 — India IT Projection](./15-india-it-projection.md)
- [16 — Attendance → Payroll LWP](./16-attendance-payroll-lwp.md)
- [17 — CTC Builder + Onboard-by-CTC](./17-ctc-builder-onboard.md)
- [18 — Data Migration / Import](./18-data-migration-import.md)
- [19 — Scalable Org Chart](./19-scalable-org-chart.md)

---

# WAVE A — Features 10–13 (approval engine + consumers)

## A.1 Dependency order

```
        ┌──────────────────────────────────────────────┐
        │  F10  Approval Engine + RBAC  (FOUNDATION)    │
        │  engine.js · approverResolver · conditions    │
        │  workflowResolver · escalationRunner · inbox  │
        └───────┬───────────────┬───────────────┬───────┘
                │ EXPENSE +      │ approve/      │ PROFILE_CHANGE
                │ TRAVEL modules │ offer-approve │ + MSS team-scope
                ▼                ▼               ▼
            ┌───────┐        ┌───────┐       ┌───────┐
            │  F11  │        │  F12  │       │  F13  │
            │ Reimb │        │  ATS  │       │ MSS / │
            │+Travel│        │       │       │ Org   │
            └───────┘        └───────┘       └───────┘
```

- **F10 has no upstream dependency** — its data model already exists in `schema.prisma:9813-9939`; the work is the engine + resolvers + UIs. Built-in defaults mean zero-config tenants keep today's exact behaviour, so F10 is non-breaking on day one.
- **F11, F12, F13 each consume F10**: F11 routes every expense/travel approve/reject/reimburse through the engine (`WorkflowModule.EXPENSE`); F12 routes offer approval + enforces scorer ≠ offer-approver SoD via the same `APPROVAL_ACTIONS`; F13 wires `ProfileChangeRequest` → `ApprovalRequest(WorkflowModule.PROFILE_CHANGE)` and the manager inbox merges leave + reimbursement approvals.
- **F11/F12/F13 are mutually independent** once F10 lands — they can run as three parallel worktree streams.
- **F13 ↔ F11/Leave coupling**: the F13 Manager Self-Service inbox *renders* F11 reimbursement approvals + leave approvals. It can ship its inbox shell against leave-only and light up reimbursement automatically once F11's engine wiring (11b) is merged. No hard blocker, but sequence F11b before F13d for a fully-populated MSS inbox.

## A.2 Recommended build sequence (cycles)

> Sizes: S ≈ 1 worktree-pass, M ≈ 2–3, L ≈ 4+. Each cycle's slices fan out to parallel worktree agents.

1. **Cycle 1 — F10 engine core + config/inbox/escalation** — `L` — Build the reusable approval engine *before anything consumes it*. Ships the state machine, resolvers, escalation cron, and the inbox/config API. **Unblocks: F11, F12, F13.** Slices 10a + 10b.
2. **Cycle 2 — F10 proof + surfaces** — `M` — Migrate Leave + Expense onto the engine (the proof), then ship the Workflow Builder + RBAC/Hierarchy/ESS UIs. Slices 10c + 10d + 10e.
3. **Cycle 3 — Parallel fan-out: F11 + F12 + F13** — `L` (three streams) — Start F11a/11b first so F13's MSS inbox lights up reimbursement; F12 and F13 start immediately.
4. **Cycle 4 — Polish + optional slices** — `M` — F10f, F11f, F12f, F13e.

## A.3 Slice lists (fan-out targets per feature)

### Feature 10 — Approval Workflows + RBAC
- **10a** — Engine core (pure + state machine, no consumers yet)
- **10b** — Config + inbox API + escalation runner
- **10c** — Migrate Leave + Expense onto the engine (the proof)
- **10d** — Workflow Builder UI (hr-admin)
- **10e** — RBAC + Hierarchy UIs + ESS (inbox & delegation)
- **10f** *(optional)* — Wire remaining consumers (Travel/Loan/Comp/Profile-change/Regularization/Separation) + basic analytics

### Feature 11 — Reimbursement + Travel
- **11a** — Module split + scope/SoD hardening + atomic codes
- **11b** — Approval-engine wiring
- **11c** — Policy data model + `policyEngine.js`
- **11d** — Travel requests (trip + bills against travel ID)
- **11e** — ESS surface + live verdict
- **11f** — hr-admin UX + settlement

### Feature 12 — Recruitment ATS
- **12a** — Screening engine + public apply (the auto-score foundation)
- **12b** — Interview scorecards + interviewer ESS
- **12c** — Scheduling + invitations
- **12d** — Merit list + scoring orchestrator
- **12e** — Offer letters + e-sign + Hired hand-off polish
- **12f** *(optional)* — hr-admin polish: Kanban board, careers theming, RECRUITER role preset, exports

### Feature 13 — Profile + MSS + Org Tree
- **13a** — Field-policy + sectioned read
- **13b** — Self-edit writes
- **13c** — Gated change-request → HR approval
- **13d** — Manager Self-Service `/me/team/*`
- **13e** — Org tree everywhere + polish

---

# WAVE B — Features 14–19 (India-deepening)

All six specs deepen the India payroll/tax/onboarding/scale story. **Feature 14 (single-country mode) is the foundation and must land first** — it locks every tenant to its registered country and is the master switch that keeps the rest of the wave India-only. Everything below is built *for India* behind that lock; NZ is registered, tested, and tenant-unreachable until a future cycle (see [NZ FUTURE cycle](#nz-future-cycle)).

## B.1 Dependency order

```
        ┌──────────────────────────────────────────────────────┐
        │  F14  Single-Country Mode  (FOUNDATION — lands first) │
        │  Business.hrCountry/hrCurrency (locked-once)          │
        │  tenant/countryContext.js resolver + capabilities     │
        │  REGISTRABLE_HR_COUNTRIES=['IN']  ·  fail-closed guards│
        │  → gates the entire wave to India                     │
        └───┬───────────────┬───────────────┬───────────────┬───┘
            │ feeds the     │ feeds the     │               │
            │ comp engine   │ payroll engine│               │ (independent)
            ▼               ▼               │               ▼
        ┌───────┐       ┌───────┐           │           ┌───────┐
        │  F17  │       │  F16  │           │           │  F19  │
        │ CTC   │       │ Attn→ │           │           │ Org   │
        │builder│       │payroll│           │           │ chart │
        │       │       │ LWP   │           │           │ scale │
        └───┬───┘       └───┬───┘           │           └───────┘
            │   payslip     │               │
            │   generation  │               │
            │   needs BOTH  │               │
            └───────┬───────┘               │
                    ▼                       │
              ┌───────────┐                 │
              │ payslips   │  YTD TDS feeds  │
              │ are now    ├────────────────►│
              │ engine-true│                 ▼
              └────────────┘            ┌───────┐
                    │                   │  F15  │
                    │  staged facts →   │ IT    │
                    │  live engines     │ proj  │
                    ▼                   └───────┘
              ┌───────────┐
              │  F18  data │
              │  migration │  (reuses comp + payroll + leave + attn engines)
              └────────────┘
```

- **F14 is the gate.** It introduces the locked-once `Business.hrCountry`/`hrCurrency`, the pure `tenant/countryContext.js` resolver + capabilities matrix, the `REGISTRABLE_HR_COUNTRIES=['IN']` allow-list (the master switch for NZ), and fail-closed write-guards (off-country create → 422, missing/ambiguous → 409). It de-leaks the scattered `|| 'IN'` / `NZ ? … : IN` fallbacks so no downstream feature re-introduces country-mixing. **Everything in Wave B reads the F14 resolver instead of hard-coding IN.**
- **F17 (CTC builder) feeds the comp engine; F16 (attendance→payroll LWP) feeds the payroll engine.** Both are sequenced *before* IT-projection because **payslip generation depends on both** — a correct, prorated, LWP-aware payslip with engine-true CTC breakup is the substrate F15 and F18 reconcile against. Order them as a pair after F14.
- **F15 (IT projection)** reads published-payslip YTD TDS + the statutory declaration; it needs F16's engine-true TDS line and F17's correct breakup to project the remaining monthly TDS and pass its §192 golden parity test.
- **F18 (data migration)** is the heaviest reuse consumer: it stages facts and **regenerates through the live engines** (comp `deriveBreakup`, payroll `computeRun`, leave/attendance materialisation, expenses `createClaim`). Sequencing it after F16+F17 means the back-dated `type:MIGRATED` PayRun auto-prepare path runs against the already-hardened proration/LWP/CTC machinery.
- **F19 (org chart) is independent** — it touches no payroll/tax/comp surface (no compensation in the org tree), only the `Employee.managerEmployeeId` hierarchy + F1 scope chokepoint. It can run as a standalone parallel stream any time after F14, including concurrently with F16/F17.

## B.2 Recommended build sequence (cycles)

> Sizes: S ≈ 1 worktree-pass, M ≈ 2–3, L ≈ 4+. Each cycle's slices fan out to parallel worktree agents.

1. **Cycle B1 — F14 single-country foundation** — `M` — Land the lock first; it gates the whole wave to India. Ship schema + resolver (14a), backfill + super-admin repair (14b), HR-setup endpoint + fail-closed write-guards (14c), the de-leak replacing scattered fallbacks (14d), and country-context endpoints + UI gating (14e). **Unblocks: F15, F16, F17, F18, F19** — they all read the resolver. Single highest-leverage cycle of the wave.

2. **Cycle B2 — Payslip substrate: F17 + F16 in parallel** — `L` (two streams) — Both feed engines the payslip is built from, so they pair. **F17 (CTC builder)** layers policy/preview/onboard-by-CTC on the comp engine and extracts the shared `hireComp.js` so direct-onboard and ATS-hire produce byte-identical pay. **F16 (attendance→payroll LWP)** wires the existing proration+LWP machinery end-to-end (statutory leave seed, frozen standardDays denominator, leave→attendance eager materialisation, LOP payslip visibility). They have no inter-dependency; the only join is downstream — a payslip that is both engine-true-prorated (F16) and engine-true-breakup (F17). **Unblocks: F15, F18.**

3. **Cycle B3 — F15 IT projection + F19 org chart in parallel** — `L` (two streams) — **F15** extends the pure `india.js` engine (OLD regime + HRA + Chapter VI-A + perquisites) and adds the read-only assembler that reuses YTD TDS from the now-correct payslips to project remaining monthly TDS. **F19** is fully independent and can have started in B2; listed here so the org-chart lazy-tree refactor lands alongside. Both read F14's resolver; neither blocks the other.

4. **Cycle B4 — F18 data migration** — `L` — The heaviest reuse consumer, sequenced last so it regenerates history through the fully-hardened comp (F17), payroll/proration/LWP (F16), and tax (F15) engines. Ships the import scaffold + EMPLOYEE kind (18a), COMPENSATION+ATTENDANCE (18b), the PAYROLL_HISTORY autogen core (18c), RECONCILE + REIMBURSEMENT (18d), and the wizard/ESS/hardening (18e).

5. **Cycle B5 — Optional fast-follows + polish** — `S/M` — Land the deferred optional slices once cores are green: F14f (drift telemetry / invariant alerting), F15f (`TaxProjectionSnapshot` persisted at run-approval for history/diff), F16f (NZ Holidays-Act flag-off / roadmap gating), F19f (pg_trgm search index + cache headers). Defer freely if a core slips.

**Short ordered list:**
1. **F14** — single-country foundation (14a → 14e, +14f optional). *Gates the wave to India.*
2. **F17 + F16** — CTC builder + attendance→payroll LWP, in parallel (payslip substrate; payslip generation depends on both).
3. **F15 + F19** — IT projection + org chart, in parallel (F15 reads engine-true payslip YTD; F19 independent).
4. **F18** — data migration (regenerates history through the now-hardened engines).
5. **F14f + F15f + F16f + F19f** — optional fast-follows / polish.

## B.3 Slice lists (fan-out targets per feature, with size)

### Feature 14 — Single-Country Mode — `M` (foundation, lands first)
- **14a** — Schema + resolver core (no behaviour change yet) — `S`
- **14b** — Backfill + super-admin repair — `S`
- **14c** — HR setup endpoint + write-guards (the lock + fail-closed) — `S`
- **14d** — Replace the scattered fallbacks (the de-leak) — `M`
- **14e** — country-context endpoints + UI gating — `S`
- **14f** *(optional)* — drift telemetry / invariant alerting — `S`

### Feature 15 — India IT Projection — `L`
- **15a** — Pure engine: OLD regime + HRA + Chapter VI-A + perquisites (+ §192 parity goldens) — `M`
- **15b** — Declaration model + `meTax` extension (new OLD-regime/prev-employer inputs, country hoist) — `S`
- **15c** — Assembler + ESS API (`/me/tax-projection`, `/regimes`) — `M`
- **15d** — PDF + operator read-only mirror (F1-scoped) — `S`
- **15e** — ESS "Tax projection" page + hr-admin read-only tab — `M`
- **15f** *(optional fast-follow)* — persist `TaxProjectionSnapshot` at run-approval for history/diff — `S`

### Feature 16 — Attendance → Payroll LWP — `M` (wiring-and-hardening, not green-field)
- **16a** — India statutory leave framework + LWP/CL seed (config foundation) — `S`
- **16b** — Proration basis as entity policy + frozen standardDays — `S`
- **16c** — Leave→attendance eager materialisation + no-balance LWP apply (the one real new server logic) — `M`
- **16d** — LOP roll-up split + payslip/run-review visibility — `S`
- **16e** — End-to-end golden + edge cases + ESS estimate — `M`
- **16f** *(optional)* — NZ Holidays-Act flag-off / roadmap gating — `S`

### Feature 17 — CTC Builder + Onboard-by-CTC — `L`
- **17a** — Policy model + pure lib (`CtcPolicy`/`CtcPolicyLine` + `ctcPolicy.js`: compile/validate/policyDefaults('IN')) — `M`
- **17b** — Extract `hireComp.js` + re-point provision STEP 8 (byte-identical golden test) — `S`
- **17c** — Policy CRUD + preview + statement.pdf API (country-stamped, fail-closed, audited) — `M`
- **17d** — Onboard-by-CTC API (`POST /onboard/by-ctc`, reuses `buildHireRevisionLines`, idempotent) — `M`
- **17e** — hr-admin policy builder + 3-step onboard wizard + ESS My-CTC statement tab — `L`

### Feature 18 — Data Migration / Import — `L`
- **18a** — Import scaffold + EMPLOYEE kind (upload→parse→map→validate→dry-run→commit) — `M`
- **18b** — COMPENSATION + ATTENDANCE kinds — `M`
- **18c** — PAYROLL_HISTORY autogen (the core) — `L`
- **18d** — RECONCILE mode + REIMBURSEMENT kind — `M`
- **18e** — Migration wizard, ESS surfacing, hardening & report — `M`

### Feature 19 — Scalable Org Chart — `M` (independent — can run any time after F14)
- **19a** — Shared lazy-tree lib + indexes (backend foundation: `lib/orgTree.js` `getRoots/getChildren/getAncestors/searchNodes`) — `M`
- **19b** — HR-admin lazy endpoints (operator session) — `S`
- **19c** — ESS lazy endpoints (customer session) — `S`
- **19d** — Component redesign (virtualized lazy `OrgTree.js`) — `M`
- **19e** — Wire both pages + search/breadcrumb UX — `M`
- **19f** *(optional, deferred)* — perf hardening: pg_trgm search index + cache headers — `S`

---

<a id="nz-future-cycle"></a>
## B.4 NZ FUTURE cycle — DEFERRED, DO NOT BUILD NOW

NZ is the **explicitly deferred** target. The entire Wave B is India-only by construction: Feature 14's `REGISTRABLE_HR_COUNTRIES=['IN']` allow-list is the single master switch. NZ modules stay **registered and tested but tenant-unreachable** — no NZ tenant can be created, and no India-facing surface renders NZ. **Build none of the following in the current wave.** They are captured here so the lock is intentional, not accidental, and so the future cycle is a known quantity behind one constant flip.

When NZ go-live is scheduled (a separate future cycle, behind flipping `REGISTRABLE_HR_COUNTRIES` to include `'NZ'`):

- **PAYE income tax** — NZ pay-as-you-earn computation + tax codes, parallel to the India `compute`/`computeTds` path in the country-keyed engine. (F15 stays India IT-projection-only; NZ projection is a separate future build.)
- **Hourly pay + Holidays Act** — hourly/timesheet-based earnings and Holidays-Act leave entitlements (annual holidays, sick, bereavement, public-holiday rules), distinct from the India monthly-salary proration model. F16's LOP/LWP machinery is India-only; **NZ Holidays-Act unpaid-leave is roadmap, never surfaces for India tenants** (gated by the optional F16f flag-off).
- **Casual / part-time** — casual and part-time employment models (e.g. pay-as-you-go holiday pay, variable-hours entitlement), which the India monthly-CTC + statutory-leave-floor model does not cover.
- **KiwiSaver + ACC** — NZ retirement (KiwiSaver) and accident levy (ACC) statutory deductions, parallel to India PF/ESI/PT.
- **NZD currency + NZ letters/UI** — `hrCurrency` NZD, NZ-localised statutory letters, and country-context-driven UI strings (the front-ends already render from F14's `country-context` endpoints, so no IN/NZ is hard-coded — flipping the allow-list lights up the NZ capability set).

**Until that cycle: do not build PAYE, hourly/Holidays-Act, casual/part-time, KiwiSaver/ACC, or NZD surfacing.** Keep the NZ modules registered + green in tests; keep them unreachable.

---

## B.5 Cross-cutting notes (apply to every Wave B cycle)

- **Single-country, India-only, always.** Every feature reads Feature 14's `tenant/countryContext.js` resolver — **never** hard-codes `IN`, and **never** re-introduces a `|| 'IN'` or `NZ ? … : IN` fallback (F14d exists precisely to delete those). Policy/structure/declaration country + currency are **server-stamped from the tenant**, never client-supplied. NZ never surfaces (see the [NZ FUTURE cycle](#nz-future-cycle)). New country-bearing rows must pass F14's fail-closed write-guards (off-country create → 422, missing/ambiguous → 409).
- **Feed the engines, don't bypass them.** Every feature routes through the existing pure engines rather than re-implementing pay/tax/leave/comp math:
  - **Comp** — F17 and F18 emit the exact line shape `compensation/deriveBreakup.js` consumes (`compilePolicyToStructureLines` / reverse-derive); F17 extracts and both reuse `compensation/hireComp.js#buildHireRevisionLines` so every hire path is byte-identical.
  - **Payroll** — F16 feeds `payroll/engine.js#applyProration` via the existing `AttendancePayInput` seam (no new pay math); F18's back-dated `type:MIGRATED` PayRun calls `payroll/service.js#computeRun({ freezeAttendance:true })` so PF cap / PT slab / TDS / net are engine-true and rule-versioned as-of the historical period.
  - **Tax** — F15 *extends* the pure `compliance/india.js` engine (adds OLD slabs / HRA / Chapter-VI-A / perquisites) and reconciles to the live run's TDS line via a §192 golden; it computes, never writes.
  - **Leave/attendance** — F16 uses the existing `attendance/derive.js#classify` → `freeze.js#rollupEmployee` → `AttendancePayInput` chain and the existing `affectsLOP` seam (seeded `UNPAID` `LeaveType`); the only new server logic is eager `ON_LEAVE` materialisation at approval.
  - **Expenses** — F18 reimbursements create real `ExpenseClaim`s via `expenses.service.createClaim`.
- **Tenant isolation, always.** Every query tenant-scoped. All new models are additive — F14 (`Business.hrCountry`/`hrCurrency` columns), F15 (`TaxProjectionSnapshot`, optional), F16 (seeded `LeaveType`s + entity proration policy), F17 (`CtcPolicy`/`CtcPolicyLine`), F18 (`ImportJob`/`ImportRow` + nullable `importJobId` provenance columns), F19 (two additive covering indexes only). No drops/destructive backfill; F14's backfill is idempotent and quarantines genuinely-mixed legacy tenants for super-admin repair.
- **Maker-checker SoD, always.** Preserve separation of duties end to end: F17/F18 onboarding and migration honour maker ≠ checker; F18 enforces SoD across the import dry-run → commit → autogen path; immutability + append-only audit on every generated artifact. Fail-closed.
- **Reuse the F1 scope chokepoint.** F19's two perspectives both funnel through the single F1 fence — operator → `resolveAccessibleEmployeeIds`/`scopeAllows`, ESS → `resolveCustomerScope` (the same recursive-CTE chokepoint Wave A's MSS/org-tree uses). F15's operator read-only mirror is F1-scoped behind `canViewPayrollReports`. Do not re-derive scope per feature.
- **Reuse existing I/O scaffolds.** PDFs via the existing `payslipPdf` / `ctcPdf` rendering scaffolds (F15 tax-projection PDF, F17 CTC statement); receipts/docs via `validateDocDataUrl` + `s3.uploadDataUrl`; country fail-closed resolver hoisted out of `meTax.controller.js` and shared. Don't re-implement.
- **Compute, don't write (read-only features).** F15 is computed-never-written (the optional `TaxProjectionSnapshot` is the only persistence, and only at run-approval for history/diff). F19 surfaces no compensation. Dry-runs (F18) run the *real* commit+autogen path inside a rolled-back transaction so previews are engine-true.
