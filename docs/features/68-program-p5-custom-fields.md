# Feature 68 — Master Program Phase 5b: tenant-defined custom fields

Second Phase-5 (hardening) wave. Until now every field on an employee was one
the platform shipped — there was no way for a tenant to capture data the product
didn't anticipate (T-shirt size, seat number, a bespoke tier, a badge date). This
adds a **tenant-defined typed field system** on the Employee entity: admins author
their own fields, set per-field ESS visibility + editability, and the fields
render + edit on both the admin employee profile and the ESS profile.

Greenfield — there was no custom-field store before this (the only `Json` column
on Employee was `notifyPrefs`). Modelled on the closest existing precedent, the
Surveys definition→typed-answer pattern.

## Data model (schema.prisma)
- `enum CustomFieldType { TEXT NUMBER DATE SELECT BOOLEAN }`
- `enum CustomFieldEntity { EMPLOYEE }` (extensible to DEPARTMENT/ENTITY later)
- `enum CustomFieldEssPolicy { HIDDEN READ_ONLY SELF_EDIT }`
- `CustomFieldDefinition` — businessId-scoped, `@@unique([businessId, entityType,
  key])`. Carries fieldType, key (slug, immutable), label, description, `options`
  (`[{value,label}]` JSON, SELECT only), required, essVisible, essPolicy, section,
  orderIndex, isActive, version, soft-delete.
- `CustomFieldValue` — one row per `(definitionId, employeeId)`, typed columns
  `textValue`/`numberValue`/`dateValue`/`boolValue` (TEXT+SELECT use textValue).
  Clearing a value deletes the row (sparse table; reads left-join to null).

## Backend (backend/src/hr/customfields/)
- `customFields.service.js` — pure validators mirroring `survey.service.js`:
  `slugifyKey`, `validateDefinitionInput` (SELECT options must be a non-empty
  array of unique `{value,label}`; non-SELECT forces options=null), `validateValue`
  (per-type parse/normalize; SELECT membership; required-clear rejection), plus
  `list/create/update/archiveDefinition` and `get/setEmployeeCustomFields`. fieldType
  + key are immutable after create; un-archive clears deletedAt.
- `customFields.controller.js` + `customFields.routes.js` — admin routes guarded by
  `canManageEmployees` (deliberately an **existing** permission the demo HR-Admin
  role already holds — avoids the stale-BusinessRole grant dance); ESS routes under
  `requireCustomer` with the separated-employee lockout + `PROFILE_SELF_EDIT` audit.
- Read attach: the admin employee `GET` and `getEmployeeFull` responses now carry a
  `customFields` block (try/catch-guarded so a custom-field failure never breaks the
  core employee read).

### API (all under /api/hr)
- `GET|POST /custom-fields/definitions`, `PATCH|DELETE /custom-fields/definitions/:id` (admin)
- `GET|PATCH /employees/:id/custom-fields` (admin, row-scoped) — `{ values:{key:val} }`
- `GET|PATCH /me/custom-fields` (ESS) — returns only non-HIDDEN defs; PATCH accepts
  only SELF_EDIT keys (others → 403 FIELD_NOT_SELF_EDITABLE)

## Frontend
- hr-admin **Settings → Custom fields** (`app/settings/custom-fields/page.js`,
  mirrors the notifications console): DataTable + create/edit modal (fieldType
  disabled on edit; SELECT options editor; required/essVisible/essPolicy/section/
  order), plus show-archived + Restore. Nav item gated on `canManageEmployees`.
- hr-admin **employee detail** (`app/people/[id]/page.js`): a "Custom fields"
  Section (renders only when ≥1 definition) + an edit modal PATCHing the per-employee
  values, typed inputs per field kind.
- ESS **profile** (`app/profile/page.js`): a "Custom fields" card — READ_ONLY rows
  show a badge, SELF_EDIT rows get an inline typed editor that saves only the changed
  key; renders only when ≥1 visible field.

## ESS policy scope (deliberate)
Per-definition ESS policy is `HIDDEN` / `READ_ONLY` / `SELF_EDIT` only. `HR_APPROVAL`
(route a self-edit through the F10 approval engine) is intentionally **deferred** —
it belongs with P5c (field-level permissions), and keeping custom fields off the
frozen `profileFieldPolicy` map means the existing governed core fields stay
regression-free.

## Verification
- Backend units: 22 pure-function jest tests (slugify, definition validation incl.
  SELECT option rules + bad type/policy, all 5 value types incl. SELECT membership +
  required-clear + number/date parse failures). `prisma validate` clean; service +
  controller + route tree load.
- Live E2E `qa/e2e/e2e-p5-custom-fields.js`: define all 5 types × 3 ESS policies →
  definition validation (empty SELECT options / bad fieldType → 422) → admin typed
  value round-trip (TEXT/SELECT/NUMBER/DATE/BOOLEAN) → value validation (bad SELECT
  option / non-numeric → 422) → ESS visibility (HIDDEN not returned) + self-edit +
  READ_ONLY refusal (403) → archive cleanup verified gone from the active list.

## Follow-ups
1. `HR_APPROVAL` ESS policy (custom-field self-edit → change request) — with P5c.
2. Extend `CustomFieldEntity` to DEPARTMENT/ENTITY when a tenant needs org-level
   custom attributes (the enum + scoping already anticipate it).
