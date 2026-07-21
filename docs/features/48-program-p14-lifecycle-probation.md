# Feature 48 — Master Program P1.4: lifecycle template authoring + probation automation

Part of the locked program (docs/MASTER-PLAN-CUSTOM-DYNAMIC.md). Closes the
hotlist items "lifecycle checklists hardcoded in templates/seed.js" and
"provision.js probation default 90 hardcoded".

## What shipped

### Lifecycle template authoring (was seeder-only)
- `/api/hr/lifecycle/templates` CRUD (canManageOnboarding): list, detail with
  ordered taskDefs, create (server-minted `ONBT-C<n>`/`OFBT-C<n>` codes,
  optional tasks[]), PATCH details, `PUT :id/tasks` replace-all task snapshot
  (seeder reconcile idiom), DELETE (soft; the default template is protected —
  409 "make another template the default first", same for unsetting the only
  default), `POST /seed-defaults` restores the stock IN/NZ starter sets.
- `GET /templates/meta` serves every editor vocabulary (stages per direction,
  system task keys, owners, due anchors, document/e-sign/asset categories) so
  the UI hardcodes nothing.
- Editing a template NEVER touches in-flight journeys — their tasks are
  materialized snapshots; changes apply to future journeys only.
- Validation with human messages: per-direction stage keys, owner/anchor
  enums, ±365 due offsets, ≤100 tasks, non-empty replace.

### Probation policy + automation (was: hardcoded 90 days, manual confirm only)
- `ProbationPolicy` rows (unique per scope cell): entityId? + employmentType?
  scope, probationDays (0–730), autoConfirm, letterTemplateId (confirmation
  letter), remindDaysBefore (0–60), isActive. Resolution most-specific-wins:
  (entity+type) > entity > type > tenant-wide.
- `provision.js` now resolves the probation window **self > offer > policy >
  90-day fallback** (policy resolution inside the provisioning tx, fail-soft).
- **Nightly probation sweep** (02:15, overlap-guarded, per-employee fail-soft):
  1. reminder `probation.ending` → manager email (HR fallback) exactly
     remindDaysBefore days before the end date (exact-day match = naturally
     deduped);
  2. where the resolved policy has autoConfirm: `confirmProbation()`
     (idempotent PROBATION→ACTIVE + EmploymentRecord PROBATION_CONFIRM +
     journey advance) at/after the end date, then best-effort confirmation
     letter via `letters.issueLetter` (actor = tenant BUSINESS_ADMIN) and
     `probation.confirmed` notification to the employee.
- New notification templates: `HR_PROBATION_ENDING` (email),
  `HR_PROBATION_CONFIRMED` (email/WhatsApp).

### Admin UI — NEW Settings → Lifecycle & probation (canManageOnboarding)
- Checklist section: Onboarding/Exit toggle, template table (scope, task
  count, Default badge), details modal, stage-grouped **task editor** (add/
  reorder/remove per stage, human due sentences, system-action task keys with
  conditional document/e-sign/asset selects), "Restore starter templates".
- Probation section: scoped policy table + modal (scope immutable after
  create, auto-confirm hint, letter select, precedence hints).

## Schema
- NEW `ProbationPolicy` (@@unique(businessId, entityId, employmentType)).

## Manual test (staging)
1. Settings → Lifecycle & probation → New template (Onboarding) → add tasks
   across stages → save; edit tasks, reorder, save; try deleting the default
   template — blocked with a clear message.
2. Probation policy: create tenant-wide 120d auto-confirm; create INTERN 30d;
   try duplicating a scope — 409. Provision a new hire → probationEndDate
   follows the policy (offer/self overrides still win).
3. Sweep: set an employee's probationEndDate to today + policy autoConfirm →
   after 02:15 the employee flips ACTIVE and the letter/notification go out.

## E2E evidence
`scratchpad/e2e-p14.js` on live staging: **20 pass / 0 fail** (meta, template
create with server code, stage/title validation 400s, replace-all tasks incl.
asset extras, empty-replace 400, rename, seeded default present, only-default
unset 409, delete, policy CRUD + duplicate-scope 409 + range/foreign-ref 400s,
cleanup). Unit: `probationPolicy.unit.test.js` 6/6 (most-specific-wins).
