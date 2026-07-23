# Feature 69 — Master Program Phase 5c: field-level permissions

Third Phase-5 (hardening) wave. Module-level RBAC already decides *whether* a role
can reach employees at all. This adds a finer gate on top: a tenant admin can decide,
**per role**, what a role may see and edit on individual **groups of employee
fields** — so e.g. a Recruiter role can manage employees but never see bank details
or statutory IDs. Covers core fields *and* the P5b custom fields.

Generalises the existing F5 `compVisibility` precedent (a role-scoped visibility
level for the compensation field-group) to an arbitrary map of field-groups → access.

## Model
`BusinessRole.fieldAccess Json? @default("{}")` — a map of governable group → access
level: `{ bank:'HIDDEN', identity:'READ' }`. Three levels:
- **WRITE** — view + edit (the DEFAULT for any group with no rule).
- **READ** — visible, but edits are refused 403.
- **HIDDEN** — the group's fields are OMITTED from the read (server-side field
  omission, exactly like `maskCompensation` — never a CSS blur) and writes refused.

**Fail-open, byte-for-byte:** an absent/empty map (every existing role, since the
column defaults to `"{}"`) resolves to WRITE on every group → the employee read/write
responses are literally unchanged (no `_fieldAccess` key attached, no field touched).
A rule only ever RESTRICTS, never escalates, so it is safe to configure even on a
**system role** — it cannot violate the "system roles are clone-to-edit" permission
invariant (that guards privilege escalation, which field access cannot do).

Five governable groups: `personal` (demographic/family scalars), `contact` (comms +
address), `identity` (statutory IDs — PAN/Aadhaar/PF/ESI), `bank`, `custom` (the P5b
custom fields).

## Backend
- `backend/src/hr/rbac/fieldAccess.js` — pure core: the group catalog (each group maps
  to scalar keys and/or candidate response-object keys so one catalog serves both the
  flat employee GET and the nested rich profile), `applyFieldAccess(payload, viewer,
  {scalarHost})` (redacts HIDDEN groups + attaches a `_fieldAccess` hint), `firstDeniedWrite`
  (the write-gate), `validateFieldAccessMap`, `accessFor`/`customAccess`.
- `req.user.businessRole.fieldAccess` is loaded by adding `fieldAccess:true` to the
  auth-middleware selects (both the login load and the system-role synth), mirroring
  how `compVisibility` rides the request.
- Enforcement (all fail-open):
  - `GET /employees/:id` and `GET /profile/employees/:id/full` → `applyFieldAccess`.
  - `PATCH /employees/:id` → `firstDeniedWrite` on the changed keys → 403
    `FIELD_WRITE_FORBIDDEN`.
  - `GET/PATCH /employees/:id/custom-fields` → gated on the `custom` group (HIDDEN →
    `[]`, non-WRITE PATCH → 403). ESS `/me` custom fields stay governed by their own
    P5b essPolicy, not by operator field access.
- Admin API — a **dedicated, unambiguous** router `/api/hr/field-access/*` (there are
  two `/api/rbac` role routers; this sidesteps both), guarded by `canManageEmployees`:
  - `GET /field-access/roles` → roles + their maps + the acting role id + group catalog
  - `GET /field-access/groups` → the catalog
  - `PUT /field-access/roles/:id` → replace a role's map (system roles allowed)

## Frontend
`Settings → Field access` (`app/settings/field-access/page.js`) — a per-role × per-group
matrix; each cell a WRITE/READ/HIDDEN select, Save per row. Nav item gated on
`canManageEmployees`. HIDDEN groups already vanish from the employee pages because the
backend omits them; a per-field READ/greyed affordance from the `_fieldAccess` hint is
noted as polish.

## Verification
- 21 backend jest units (map validation, fail-open identity for absent AND empty map,
  HIDDEN omission for scalar + object groups, nested `scalarHost` redaction, write-gate
  allow/deny, ungoverned-key pass-through).
- Live E2E `qa/e2e/e2e-p5-field-access.js`: restricts the **acting operator's own role**
  and observes on the same operator, then **always reverts** (finally): group catalog;
  baseline has no `_fieldAccess`; set `{bank:HIDDEN, identity:HIDDEN, personal:READ,
  custom:HIDDEN}` → GET omits bank/statutory/customFields + records `_fieldAccess`,
  personal stays visible; PATCH personal → 403, ungoverned PATCH → 200, custom PATCH →
  403, custom GET → `[]`; revert → `_fieldAccess` gone + personal writable again.

## Follow-ups
1. Per-field READ affordance in the admin employee edit form (grey out READ-group
   inputs from the `_fieldAccess` hint) — cosmetic; HIDDEN already hard-omits.
2. Extend enforcement to the bank/statutory dedicated write endpoints (the employee
   PATCH + custom-field paths are gated now; the standalone bank/statutory editors are
   a small follow-up).
