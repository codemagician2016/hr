# DriftHR feature sweep — locked plan

One module at a time: walk it as a user, fix what breaks, ship it, prove it on prod.

## Why this shape

On 2026-08-06 the Talent Acquisition module was swept this way and produced seven
real defects, **none of which had been reported by a tester** and none of which
were visible in code review:

| Defect | Why nobody caught it |
|---|---|
| "Create job" invisible | Permissions envelope not unwrapped — page rendered fine, just empty |
| Job created with no pipeline | Job looked created; stage moves + knockouts were silently dead |
| Careers/job link dead | Wrong host, wrong apply path — only fails in a real browser |
| Interview without a panel → 500 | The *ordinary* scheduling order was the broken one |
| Interview unscoreable | Panellist stuck on a 422 blaming them; candidate never ranked |
| First hire → no onboarding | Offer ACCEPTED, employee HIRED, and nothing else happened |
| Screening scoring failure | Swallowed — looked identical to a candidate who passed |

Plus, module-independent: **all 9 partial UNIQUE indexes were missing from the
production database** (1264 indexes, 0 partial), because `prisma db push` cannot
create them and the deploy pipeline uses `db push`.

The pattern in almost every one: **an action reports success without producing the
state it promises.** Unit tests pass, the build is clean, the page renders — and
the user is stuck. Only walking the journey finds these.

## The per-feature loop (do not skip steps)

1. **Enumerate the real journey** from the feature doc + routes — what a user
   actually does, in order, including the boring path (no optional fields set).
2. **Write `qa/smoke/<module>.js`** — a browser journey that performs the actions
   and *reads back what the user would see*. Not an API contract test.
3. **Run against staging. Triage every failure: prove whether the test or the code
   is wrong before changing either.** Both happened today; assuming either way
   wasted time and once nearly buried a real bug.
4. **Fix the code.** Keep assertions strict — a `status < 500` assertion nearly
   let a broken offer path ship. Assert the *outcome*, not the absence of a crash.
5. **Regression** the related jest/node suites.
6. **Ship dev → staging → prod**, verifying each rung. Never straight to prod.
7. **Re-run the smoke on staging AND prod.**
8. **Commit** explaining *why*, and update the status table below.

### Rules learned the hard way

- A guard that "never blocks the user" must still **log**. Three separate silent
  swallows were found; each made a failure look like a success.
- A setting that is optional at creation but mandatory downstream is a **dead
  end**. Resolve it (pipeline → scorecard template → onboarding template), never
  skip silently.
- Do **not** loosen a server-side allowlist to make a flow work. Fix the missing
  input instead — the allowlist is usually the security control.
- A failing suite is **not** presumed stale. `letters9a` was correctly reporting a
  real production gap I nearly wrote off.
- Never commit on `staging`/`main` (guard: `qa/check-branch.sh`).

## Status — feature sweep complete

Two passes over every feature: a BROWSER JOURNEY (does a real user's path work?)
and a CODE AUDIT (silent catches, un-awaited writes, unvalidated enums, ledger
transaction/concurrency safety, statuses guarded but never written).

| # | Module | Journey | Code audit | Real defects |
|---|--------|---------|-----------|--------------|
| 1 | Setup & org | 19/19 | — | 0 |
| 2 | People | 18/18 | — | invite link host (fixed) |
| 3 | Onboarding | 17/17 | 1 HIGH | FnF settled while payroll unpaid |
| 4 | Attendance | 17/17 | 0 of 20 candidates real | 0 |
| 5 | Leave | 16/16 | 3 | no balances (CRITICAL) + 3 silent drops |
| 6 | Compensation | 19/19 | 1 | invalid enum → 500; structure warning |
| 7 | Payroll | 14/14 | 1 | stale approval stays actionable |
| 8 | Statutory | 14/14 | 0 | 0 |
| 9 | Reimbursement | 16/16 | 1 | receipt PII left in storage |
| 10 | Talent Acquisition | 27/27 | — | 7 (incl. inverted knockout) |
| 11 | Performance | 15/15 | — | launch left cycle DRAFT (CRITICAL) |
| 12 | Letters | 14/14 | 0 | merge PROVEN correct |
| 13 | Approvals | 9/9 | notifier (systemic) | undelivered notices left no trace |
| 14 | Separations | 10/10 | see #3 | per-lane SoD verified working |
| 15 | Engagement | 14/15 | covered by notifier fix | 0 |
| 16 | Learning | 9/9 | 0 | 0 |
| 17 | Reports | 18/18 | 0 | 0 |
| 18 | ESS & mobile | 25/25 | — | 0 |
| 19 | Settings | 16 pages via every-screen | — | 0 |
| 20 | Platform | 7/9 public | 0 real | hydration on /login + /signup |

Plus **every-screen**: 72 admin screens and 24 employee screens crawled, all clean.

### Cross-cutting, not owned by one feature
- 9 partial UNIQUE indexes MISSING from the production database (1264 indexes,
  zero partial) — every data-integrity guard absent. Reapplied on every deploy.
- Résumé uploads dead on a live careers page — now private R2 with presigned reads.
- 2 live jobs with no pipeline + 4 applications stranded with no stage.
- 4 candidates auto-rejected by an inverted knockout, restored.

### What the audits CLEARED (do not re-audit)
- `writeAudit` logs its own failures — the ~30 `.catch(() => {})` around it are
  redundant, not silent.
- `prisma.$transaction([...])` arrays are the correct API; the "no-await" hits in
  lifecycle/templates, expenses/policy and attendance/fence are all correct.
- Payroll computes in integer minor units throughout — no float money in 41 files.
- Leave's balance CAS (`updateMany` on `{id, version}` + 409) is sound concurrency.
- Compensation masks on 13/14 read paths; the 14th is a pure quote with nothing
  to mask.
- `catch {}` in subscription is DNS probing across resolvers — ignoring a failed
  resolver is the point.

## Known open (found, not yet fixed)

- ~~**Letters — merge UNPROVEN**~~ **RESOLVED: the merge works.** Proven in
  `backend/src/hr/letters/__tests__/merge-substitutes.test.js` — Asha Rao
  (EMP-001, Engineer) and Bilal Khan (EMP-002, Analyst) render demonstrably
  different bodies with no tokens left over. The identical PDF content streams
  were an artefact of the renderer's SUBSET fonts (glyph runs decode to repeated
  0x21 bytes), not a failure to merge. Lesson: prove a transformation at the layer
  where it happens, not through an encoding that can hide it.

- **Separations**: `compute-fnf` returns 422 `nz-earnings-required` when NZ
  holiday-pay earnings cannot be resolved from payroll history. Deliberate guard;
  the test expects 200 without seeding history. 16 assertions cascade from it.
  India tenants unaffected. Decide: fix the guard or the fixture. (Module 14.)
- **selfOnboarding**: 1 failure, `COUNTRY_MISMATCH`. Undiagnosed. (Module 3.)
