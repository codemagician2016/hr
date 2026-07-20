# Feature 39 — Face & Geo Attendance Controls (face recognition + polygon geofences + per-employee restriction; India-first)

The "no proxy punching" feature. Builds the FULL attendance-control architecture on top of the
Feature-2 capture scaffolding: an employee registers their face, **HR approves it**, and only then
can they face-punch; punches carry live GPS + trusted IP; HR draws **polygon geofences** on a map
for offices (or for one individual), restricts an employee to specific sites, and pins punching to
office networks (CIDR) — with every control able to run in WARN (flag + HR review) or ENFORCE
(hard-block) mode.

## 1. Summary & goals

1. **Face registration with an HR gate.** ESS/mobile self-enrolment no longer activates instantly:
   the enrolment lands `PENDING`, rides the F10 approval engine (`FACE_ENROLLMENT` module, built-in
   default = single HR step), and only an APPROVED enrolment becomes the matching reference.
2. **Real face matching.** Replace the v1 stub matcher with a production matcher: InsightFace
   **SCRFD-500M** face detection + **ArcFace (MobileFaceNet, w600k)** 512-d embeddings via
   `onnxruntime-node`, entirely **server-side and self-hosted** — no per-call vendor cost, and the
   biometric embedding never leaves our infrastructure (DPDP posture: we store a derived vector +
   the reference selfie, never a vendor-side template).
3. **Polygon geofences.** A new `AttendanceGeoFence` (map-drawn polygon) attachable to a
   **Location** (office zone) or to an **individual employee** — replacing/augmenting the
   radius-only `Location.geofenceM` circle. Point-in-polygon at punch time, distance-to-zone when
   outside.
4. **Per-employee restriction.** Two levers: (a) an `EMPLOYEE` scope on the capture policy
   (highest precedence — e.g. this one person must face-punch even if their department doesn't) and
   (b) employee-scoped fence links (this person may only punch inside these zones, overriding the
   office zones).
5. **IP-only attendance** (already shipped in F2 — office CIDR allow-list per location) stays, now
   presented in the same console as the rest of the control plane.
6. **Web parity.** The ESS web app finally captures what the Flutter app already does: geolocation +
   a live-camera selfie at punch, and a face-enrolment flow with approval status.

Non-goals / explicit v1 limits (documented, on the roadmap): active liveness (blink/turn
challenges), multi-face reference sets, on-device matching. Mitigation today: server-side matching
+ threshold + WARN-mode review queue + live-camera-only capture on web (no file upload for ESS).

## 2. Domain research (cite in code comments)

- **DPDP Act 2023 (India):** biometric data is sensitive personal data. We keep (a) the reference
  selfie (audit, `@pii:sensitive`), (b) a derived 512-d float vector. Both tenant-scoped, deletable
  with the employee. Matching is on our servers only; no third-party biometric processor. The
  employee actively submits the enrolment (consent-by-action) and HR approves it (controller
  accountability). Revocation (`REVOKED`) supported.
- **Matcher choice:** InsightFace `buffalo_sc` pack — SCRFD-500M detector (2.5 MB) +
  `w600k_mbf.onnx` ArcFace recognition (13.6 MB). CPU inference ~50–150 ms/image — fine for punch
  volume. Cosine similarity of ArcFace embeddings: same-person raw cos ≈ 0.5–0.8, different-person
  ≈ < 0.3. We map score = (cos+1)/2 into [0,1], so the existing `faceThreshold` default **0.7**
  (raw cos 0.4) is a sound accept bar; HR can tighten/loosen per policy.
- **Geofence math:** ray-casting point-in-polygon on the outer ring (office-scale polygons — no
  spherical correction needed at < a few km), point-to-segment distance via an equirectangular
  projection centred on the punch (sub-metre accurate at site scale). Reuses the F2 posture:
  WARN default, ENFORCE opt-in.
- **Proxy-punch threat model:** (1) buddy punching → face match; (2) GPS spoofing → IP restriction
  (server-observed `req.ip`, not spoofable via XFF thanks to `trust proxy 1`) + polygon+IP
  combined; (3) photo-of-photo → threshold + review queue (liveness = roadmap); (4) enrolment
  swap attack (someone else enrols their face on a stolen session) → **HR approval gate** + any
  re-enrolment de-activates face punching until re-approved; (5) client tampering → ALL
  enforcement server-side; the client only supplies coords + selfie bytes.

## 3. Reuse-vs-build matrix

| Concern | Reuse (exists) | Build (this feature) |
|---|---|---|
| Punch spine + marks | `AttendancePunch` capture columns, recompute | — |
| Policy resolution | `AttendanceCapturePolicy` + `resolvePolicy` precedence | add `EMPLOYEE` scope (highest) |
| IP restriction | `LocationOfficeIp` + `ip.js` | surfacing only |
| Radius geofence | `Location.geoLat/geoLng/geofenceM` + `geo.js` | polygon zones + per-employee zone links |
| Face plumbing | `FaceEnrollment`, pluggable `faceMatcher.js`, threshold | real ONNX matcher; enrolment **status + approval** |
| Approvals | F10 engine, consumers, built-in default chains | `FACE_ENROLLMENT` module + consumer |
| Review queue | flagged-punch queue + CLEAR/REJECT | enrolment approval queue (photo review) |
| Storage | `s3.uploadDataUrl` scope `attendance-selfie` | — |
| ESS punch API | `POST /me/attendance/punch` geo+selfie contract | web UI capture (camera + geolocation) |
| Admin console | `settings/attendance/capture` page | Geofences map tab, Face approvals tab, EMPLOYEE scope |

## 4. Data model (Prisma sketch — additive)

```prisma
enum FaceEnrollmentStatus { PENDING ACTIVE REJECTED REVOKED }

model FaceEnrollment {            // EXISTING — add:
  status            FaceEnrollmentStatus @default(ACTIVE)  // legacy rows stay valid
  approvalRequestId String?
  decidedBy         String?      // operator userId
  decidedAt         DateTime?
  decisionNote      String? @db.Text
  detScore          Float?       // detector confidence at enrol (quality audit)
}
// single row per (businessId, employeeId) KEPT: a re-enrolment overwrites the row to
// PENDING — face punching is deliberately unavailable until HR re-approves (secure default).

enum WorkflowModule { ... FACE_ENROLLMENT }   // built-in default chain: [ HR, 72h SLA ]

enum FenceScopeKind { LOCATION EMPLOYEE }

model AttendanceGeoFence {       // a named map-drawn polygon
  id String @id @default(uuid())
  businessId String
  name String
  description String?
  polygonJson Json               // closed outer ring: [[lng,lat], ...] (first==last optional)
  centroidLat Decimal? @db.Decimal(9,6)   // stamped at save (map centering / distance hints)
  centroidLng Decimal? @db.Decimal(9,6)
  isActive Boolean @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  createdBy String?
  version Int @default(0)
  @@index([businessId, isActive])
}

model AttendanceFenceLink {      // fence → office (LOCATION) or individual (EMPLOYEE)
  id String @id @default(uuid())
  businessId String
  fenceId String
  scopeKind FenceScopeKind
  scopeId String                 // locationId | employeeId
  isActive Boolean @default(true)
  createdAt DateTime @default(now())
  createdBy String?
  @@unique([businessId, fenceId, scopeKind, scopeId])
  @@index([businessId, scopeKind, scopeId, isActive])
}

enum CapturePolicyScope { TENANT ENTITY LOCATION EMPLOYEE_GROUP EMPLOYEE }  // + EMPLOYEE
```

Relation-less (plain-id + `@@index`) like every other F2 model — zero edits to shared blocks.
All changes land through the repo's additive `prisma db push` deploy path.

## 5. Core algorithms

### 5a. Zone resolution (where may THIS employee punch?)

```
zones(employee):
  1. active EMPLOYEE fence links for employeeId   → exactly those polygons  (individual override)
  2. else active LOCATION fence links for the current EmploymentRecord.locationId
                                                  → those polygons          (office polygons)
  3. else Location radius (geoLat/geoLng/geofenceM)→ the legacy circle      (unchanged behaviour)
  4. no zones at all                              → geo not evaluable (F2 graceful degradation)
```

Verdict per punch: inside ANY zone → in-fence (`distanceM` = 0-ish); outside all → `outOfGeofence`
with `distanceM` = min distance to the nearest zone boundary. Same WARN/ENFORCE levers as today
(`requireGeo` + `geoEnforce` on the resolved policy).

### 5b. Policy precedence (updated)

`EMPLOYEE > EMPLOYEE_GROUP (department) > LOCATION > ENTITY > TENANT > none`.

### 5c. Face pipeline

- **Enrol (ESS or HR-on-behalf):** validate data URL (existing) → decode via `sharp` → SCRFD
  detect (letterboxed 640×640, score ≥ 0.5, largest face, min-size gate) → 5-landmark similarity
  alignment (Umeyama) to the 112×112 ArcFace template (manual bilinear warp — deterministic, no
  native affine semantics) → ArcFace embed (512-d, L2-normalised) → store selfie + embedding on the
  `FaceEnrollment` row. No face / too small / multi-face-ambiguous → 422 with a human message
  (the employee retakes — bad references never enter the system).
- **Punch:** same detect+align+embed on the live selfie → cosine vs the ACTIVE reference →
  score = (cos+1)/2 → MATCHED / NO_MATCH vs `faceThreshold` → existing `enforceCapture` decides
  reject/flag. `NO_REFERENCE` now also covers "enrolment exists but not ACTIVE".
- **Fallback:** if `onnxruntime-node`/`sharp`/models are unavailable at boot, the stub stays
  registered (everything degrades to NEEDS_REVIEW exactly as today). Env: `FACE_MATCHER=stub`
  forces the stub; `FACE_MODELS_DIR` overrides `backend/models/face`.

### 5d. Enrolment approval lifecycle

```
ESS enrol → FaceEnrollment {status: PENDING, embedding computed} 
         → engine.openRequest(FACE_ENROLLMENT)  [supersedes+cancels any open request]
HR approve (capture console or approvals inbox) → consumer: status=ACTIVE (+notify employee)
HR reject (+reason)                              → consumer: status=REJECTED (+notify)
HR revoke an ACTIVE enrolment                    → status=REVOKED (face punch disabled)
HR direct-enrol on behalf                        → status=ACTIVE immediately (HR is the approver)
```

Consumer guards: only acts when `row.approvalRequestId === request.id && status === PENDING`
(a superseded request no-ops). SoD: engine already blocks self-approval.

## 6. API surface + RBAC

### 6a. ESS (`/api/hr/me/attendance`, customer session, SELF_ONLY)
- `POST /punch` — unchanged contract `{ type, punchAt?, geoLat?, geoLng?, selfieDataUrl? }`; now
  evaluated against zones + real matcher. 403 `reason:'CAPTURE_POLICY'` unchanged.
- `GET /policy` — adds `faceStatus: NONE|PENDING|ACTIVE|REJECTED|REVOKED` (+`faceEnrolled` now
  means ACTIVE), adds `hasZones` (any polygon/radius evaluable).
- `POST /face/enroll` — now creates a PENDING enrolment + approval request; 422 on no-face/quality
  fail; response `{ enrolled:false, status:'PENDING' }`.
- `GET /face` — adds `status`, `decisionNote`, `imageUrl` (own reference).

### 6b. HR admin (`/api/hr/attendance/capture`, operator; reads `canViewEmployees`, writes `canManageAttendance`)
- Policies: existing CRUD; `scope` now accepts `EMPLOYEE` (scopeId = employeeId, tenant-validated).
- Fences: `GET/POST /fences`, `PATCH/DELETE /fences/:id` (polygon validated: ≥3 vertices, closed,
  coords in range, area > 0); `GET/POST /fences/:id/links`, `DELETE /fences/:id/links/:linkId`.
- Effective-zone preview: `GET /employees/:employeeId/zones` (what this person resolves to).
- Enrolments: `GET /enrollments?status=`, `POST /enrollments` (HR direct-enrol
  `{employeeId, selfieDataUrl}` → ACTIVE), `POST /enrollments/:id/decide {decision, note}` (drives
  `engine.recordDecision` — the same request is equally decidable from the approvals inbox),
  `POST /enrollments/:id/revoke`.
- Review queue: existing.

Every mutation `writeAudit`-ed. All lookups tenant-scoped; foreign ids → 404.

## 7. UX in plain language

### 7a. hr-admin (`settings/attendance/capture`)
Tabs: **Policies** (adds Employee scope w/ employee picker) · **Office networks (IP)** (existing
CIDR list) · **Geofences** — a Leaflet/OSM map: draw a polygon (click to add vertices, drag to
adjust), name it, attach it to office locations or a specific employee; list shows each fence with
its links · **Face approvals** — pending queue with the submitted selfie large enough to eyeball,
Approve / Reject-with-reason, plus the ACTIVE register with Revoke and an "Enrol on behalf" action
· **Review queue** (existing flagged punches, now showing real match scores + zone distances).

### 7b. ESS (`/attendance`)
- A **capture strip** above the punch buttons: what today's policy needs (location · office
  network · face) and my face status chip (Not enrolled → "Register face"; Pending HR approval;
  Approved ✓; Rejected with HR's reason → "Retake").
- Punching with geo required: browser geolocation fetched at click (clear error if denied and
  policy enforces). Face required + approved: a live camera modal (mirrored preview, capture,
  retake, use) — file upload deliberately not offered. Flagged punch → gentle "recorded, pending
  HR review" notice; enforced rejection → the policy reason, verbatim.
- Enrolment: camera modal → submit → "Sent to HR for approval".

### 7c. Mobile (Flutter) — compatibility note
API stays back-compatible; `/policy.faceEnrolled` now = ACTIVE, so mobile prompts re-enrolment
naturally. Mobile-side status chips + enrol-pending screen = follow-up (playbook notes it).

## 8. Edge cases

- Enrolment while a previous request is open → old request cancelled (superseded), row overwritten
  to the new PENDING capture.
- Re-enrolment after approval → back to PENDING; face punch immediately unavailable (secure
  default, message tells the employee why).
- Policy requires face, enrolment PENDING → punch treats it as NO_REFERENCE (flag or reject per
  `faceEnforce`); ESS pre-empts with the status chip.
- No HR user resolvable → engine's escalate→auto-approve path (audited `SYSTEM` action) — same as
  every other module; mis-provisioned tenants aren't bricked.
- Employee with EMPLOYEE-scoped fence transfers location → their personal zones still win (HR
  removes the links to fall back to office zones).
- Fence deleted/deactivated → links inert; zone resolution falls through to the next tier.
- Polygon spanning the antimeridian: rejected at save (India-first; not a real site shape).
- Punch with no coords under `requireGeo`+enforce → existing MISSING_GEO flag path (unchanged:
  kiosk/no-GPS punches are flagged, not bricked).
- Selfie of a printed photo → may pass (no liveness v1) — WARN-mode + review queue + threshold are
  the stated mitigation; doc + roadmap.
- Matcher unavailable on a box → stub fallback keeps punches flowing (NEEDS_REVIEW), never 500s.
- Two enrol submits racing → single row (unique) + last-write wins; both approval requests can't
  stay open (supersede-cancel).

## 9. Build plan (slices)

1. **Schema + engine defaults** — models/enums above; `FACE_ENROLLMENT` built-in HR chain.
2. **Face engine** — `capture/face/` (sharp decode, SCRFD, align, ArcFace, matcher registration,
   graceful fallback); models vendored at `backend/models/face/`.
3. **Zones** — `geo.js` polygon math + `zones.js` resolution; `policy.js` wiring (EMPLOYEE scope,
   zone-aware geo verdict).
4. **Enrolment approval** — controller changes, consumer, captureAdmin enrolment + fence + zone
   endpoints.
5. **hr-admin console** — Geofences map tab, Face approvals tab, Employee policy scope.
6. **ESS web capture** — camera modal, geolocation punch flow, enrolment card.
7. **Playbook + docs + tests** — unit (polygon/zones/enforce), matcher fallback, playbook sync.

## 10. Testing notes

- Pure-node unit tests (`capture/__tests__`): ray-cast in/out/edge/vertex, tiny+concave polygons,
  distance-to-boundary sanity, zone precedence (employee links beat location links beat radius),
  enforceCapture with zone verdicts, EMPLOYEE policy precedence, matcher registration fallback.
- ONNX smoke (skips if models absent): model load, no-face image → clean NO_FACE, embedding is
  512-d L2≈1, same-image cosine ≈ 1.
- Manual staging QA checklist (the playbook process is retired — this is the live test plan;
  console = HR Admin → Settings → Attendance → Capture; use DevTools → Sensors → Location
  override to simulate positions):
  1. ESS "Register face" → lands **Pending HR approval**; a face-required punch still says no
     approved face.
  2. HR → Face approvals → Approve (selfie shown large) → employee notified, card shows
     Approved ✓.
  3. Reject requires a reason; the employee sees the exact reason + Retake; resubmit supersedes
     the old request.
  4. Face punch (require face, warn): own face → clean punch, match score ≥ 0.7 in the punch row.
  5. Anti-proxy: a DIFFERENT person on camera → enforce: 403 no punch; warn: flagged
     FACE_LOW_SCORE in the review queue.
  6. HR "Enrol on behalf" → immediately ACTIVE; group photo / no-face photo → clear 422.
  7. Geofences tab: draw a polygon (≥3 points; degenerate refused), attach to a location;
     inside → clean, outside → flagged with distance; with geo-enforce ON outside → 403.
  8. Personal restriction: attach a second fence to ONE employee → they can punch ONLY there
     (office polygon no longer applies to them); others unaffected. Verify with the
     Effective-zones inspector.
  9. EMPLOYEE-scope policy: require+enforce face for one person only; others follow tenant
     policy; deleting it restores tenant behaviour.
  10. IP restriction: office CIDR + enforce → off-network 403, on-network ipAllowed=true;
      warn → flagged OFF_NETWORK.
  11. Review queue shows evidence (reasons, distance, IP verdict, selfie + score); Clear/Reject
      records reviewer + note.
