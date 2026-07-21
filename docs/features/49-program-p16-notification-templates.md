# Feature 49 — Master Program P1.6: tenant notification templates + employee preferences

Part of the locked program (docs/MASTER-PLAN-CUSTOM-DYNAMIC.md). Closes the
hotlist item "MessageTemplate global (no businessId) — notification wording not
tenant-editable".

## What shipped

### Tenant template overrides
- NEW `TenantMessageTemplate` (unique businessId+templateKey): a per-tenant
  BODY override. The in-code registry (core templates + HR_TEMPLATES) remains
  the authority for keys, variables and channels; an active override replaces
  only the rendered body. The notification router resolves override → stock at
  send time (core/lib/notifications/router.js, single choke point — every
  channel: email/WhatsApp/SMS).
- API `/api/hr/notifications/templates` (canManageOrg):
  - GET — all 44 HR-vertical templates ⋈ overrides (displayName, category,
    channels, variables, defaultBody, overrideBody, overridden).
  - PUT /:key {body} — save-time guard: every `{TOKEN}` must be a variable the
    template actually receives (400 lists the allowed tokens), ≤2000 chars.
  - DELETE /:key — reset to stock. POST /:key/preview — renders draft body →
    stored override → stock with sample `[VAR]` values.
- Admin UI: NEW Settings → Notification templates — searchable category-grouped
  list, channel chips, "Customised" chip, editor modal with clickable variable
  chips (insert at cursor), live preview, unknown-token warning before save,
  reset-to-default.

### Employee notification preferences (unified)
- ESS `GET/PATCH /api/hr/me/engagement/notification-prefs` over
  `Employee.notifyPrefs` — `announcementsOptOut` (maps to the `optOut` flag the
  announcements fanout already honours) + `celebrationsOptOut` (the celebrations
  feed/wishes flag). Legacy celebrations endpoints unchanged (same storage).
- ESS UI: unified "Notifications" card on Profile (new section) and replacing
  the old celebrations bar on the Feed page — positive-state toggles,
  optimistic save. Transactional sends (payslips, approvals, letters) are
  deliberately NOT opt-out-able.

## Manual test (staging)
1. Settings → Notification templates → edit "Birthday wishes" → type an
   unknown `{TOKEN}` — inline warning + 400 with allowed tokens; save a valid
   custom body — row shows Customised; preview shows the custom text; Reset
   restores stock.
2. ESS → Profile → Notifications: toggle both prefs off/on — feed celebrations
   bar state matches; announcements email push respects the opt-out.

## E2E evidence
`scratchpad/e2e-p16.js` on live staging: **16 pass / 0 fail** (registry list =
44 HR keys with no core/OTP leakage, P1.4 probation keys present, override
upsert + list reflection, unknown-token 400 with allowed list, unknown-key 404,
preview renders the STORED override (bug found by E2E: preview originally fell
back to stock when no draft body was posted — fixed), reset-to-stock, ESS prefs
read/flip/legacy-endpoint-agreement/non-boolean 400/restore).
