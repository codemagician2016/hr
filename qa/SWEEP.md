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

## Order

A new client's actual path through the product, so the client is never blocked by
something further down the list.

| # | Module | Surfaces | Status |
|---|--------|----------|--------|
| 1 | Setup & org | company profile, entity, employee number, branding, domain, roles & access, reporting tree | pending |
| 2 | People | add/invite employee, profile, org tree, documents, profile changes, field policy | pending |
| 3 | Onboarding | journeys, tasks, pre-join self-onboarding, probation | pending |
| 4 | Attendance & roster | punches, regularisation, shifts, open shifts, OT, biometric, face/geo | pending |
| 5 | Leave | policies, apply/approve, comp-off, encashment, reconciliation | pending |
| 6 | Compensation & CTC | CTC builder, revisions, policies, FBP plans + allocations | pending |
| 7 | Payroll run | run, LOP, arrears, variable pay, disbursement, payslips | pending |
| 8 | Statutory | PT/PF/ESI, bonus, Form 16/24Q, registers, compliance calendar, LWF | pending |
| 9 | Reimbursement | claims, travel, loans, via-payroll | pending |
| 10 | Talent Acquisition | jobs, careers, apply, pipeline, interviews, scorecards, offers | **DONE — 26/26 prod** |
| 11 | Performance | reviews, goals/OKR, 9-box, competencies, talent pool | pending |
| 12 | Letters | templates, letterheads, issue, register | pending |
| 13 | Approvals | workflow engine, SoD, delegation | pending |
| 14 | Separations | offboarding, clearance lanes, FnF, relieving letter | pending (known: `nz-earnings-required` blocker) |
| 15 | Engagement | helpdesk, announcements, surveys/eNPS, R&R, feed | pending |
| 16 | Learning | courses, lessons, quizzes | pending |
| 17 | Reports | report platform, exports | pending |
| 18 | ESS & mobile | employee portal + mobile hosts/app | pending |
| 19 | Settings sweep | custom fields, field access, notifications, SSO/SCIM, lifecycle | pending |
| 20 | Platform | signup, provisioning, billing, entitlements, tenant domains | pending |

## Known open (found, not yet fixed)

- **Letters — merge UNPROVEN (module 12).** Two different employees rendered
  byte-identical PDF content streams, which would mean the template is not being
  merged with employee data. But `letters.service.mergeEmployeeFrom()` builds
  name/code/designation/dateOfJoining correctly, and the seeded "Experience /
  Service Certificate" template does reference `{{employee.name}}` and
  `{{employee.code}}` — so code review and the byte comparison DISAGREE. The
  renderer embeds subset fonts whose glyph runs decode to repeated 0x21 bytes, so
  the comparison may be measuring the encoding rather than the text. Deliberately
  NOT asserted either way: a defect claim here would be a false alarm, and a pass
  would be unearned. Settle it with a ToUnicode-aware PDF parser, or by rendering
  through the service directly against a test DB. If it IS real, every experience
  certificate a company issues is the same document regardless of recipient.

- **Separations**: `compute-fnf` returns 422 `nz-earnings-required` when NZ
  holiday-pay earnings cannot be resolved from payroll history. Deliberate guard;
  the test expects 200 without seeding history. 16 assertions cascade from it.
  India tenants unaffected. Decide: fix the guard or the fixture. (Module 14.)
- **selfOnboarding**: 1 failure, `COUNTRY_MISMATCH`. Undiagnosed. (Module 3.)
