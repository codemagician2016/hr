# DriftHR — Mobile ESS (Flutter)

The DriftHR **Employee Self-Service** mobile app. _Effortless HR & payroll._

A native iOS/Android app that mirrors the DriftHR web ESS feature set: clock in/out
with geolocation, leave, payslips/CTC/tax, approvals, profile, and letters — all on
the cookie-authed `/api/hr/me/*` self-service surface.

> ⚠️ **Needs the Flutter SDK to build/run.** This repo ships only the Dart source
> (`pubspec.yaml` + `lib/`). The SDK was **not** available on the authoring machine,
> so the code was hand-authored and statically reviewed but **not** compiled here.
> Run `flutter pub get` then `flutter create .` on a machine with Flutter 3.19+ to
> resolve packages and scaffold the native `android/` `ios/` folders before the
> first build.

---

## Quick start

```bash
cd apps/mobile

# 1. Resolve dependencies (writes pubspec.lock)
flutter pub get

# 2. android/ and ios/ are COMMITTED (bundle id com.drifthr.employee, store
#    permissions, release signing, fastlane) — no `flutter create .` needed.

# 3. Run against a backend. The app is MULTI-TENANT (Feature 40): employees sign
#    in with Organization ID + email + password; the org travels as the
#    X-Tenant-Host header on every request. Two defines pick the environment:
flutter run \
  --dart-define=API_URL=https://demo-staging.drifthr.com \
  --dart-define=PLATFORM_DOMAIN=staging.drifthr.com
```

`API_URL` is the FIXED backend origin (any host the DriftHR router serves);
`PLATFORM_DOMAIN` is what tenant hosts hang off (`<orgId>.<PLATFORM_DOMAIN>` —
a logical name the backend parses, never a DNS lookup). Defaults target staging.
Prod: `API_URL=https://drifthr.com PLATFORM_DOMAIN=drifthr.com`.

### Release builds

See `store/RELEASE.md` (concrete runbook: signing, fastlane lanes, store records).

---

## Native config notes (after `flutter create .`)

These permissions must be added to the generated platform manifests — the SDK
won't add them for you:

**Android** — `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>
<!-- Feature 2 — selfie capture for FACE attendance capture + face enrolment -->
<uses-permission android:name="android.permission.CAMERA"/>
```

`geolocator` needs `compileSdk`/`targetSdk` 34+; set `minSdkVersion 23` in
`android/app/build.gradle` (required by `flutter_secure_storage`). `image_picker`
(camera source) needs no extra Android manifest entry beyond `CAMERA`; it returns a
file the app reads + base64-encodes (no gallery read permission required).

**iOS** — `ios/Runner/Info.plist`:

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>DriftHR records your location when you clock in or out.</string>
<!-- Feature 2 — selfie capture for FACE attendance capture + face enrolment -->
<key>NSCameraUsageDescription</key>
<string>DriftHR uses your camera to take a selfie that verifies your attendance punch.</string>
```

For the secure keychain on iOS, ensure the **Keychain Sharing** capability is on
in Xcode (used by `flutter_secure_storage`).

> **Build note:** the Flutter SDK is not installed in this environment, so the Dart
> sources here are authored to compile but were not `flutter build`-verified. Run
> `flutter pub get` (pulls `image_picker`) then `flutter create .` + `flutter run`
> on a machine with the SDK.

---

## Architecture

```
lib/
  main.dart                 # entry — hydrates the session before runApp, then bootstrap()
  app.dart                  # MaterialApp.router (brand theme + go_router)

  core/
    config.dart             # API_URL (--dart-define) + timeouts
    session.dart            # cookie/Bearer store (flutter_secure_storage) + Set-Cookie parser
    api_client.dart         # dio client + cookie/Bearer interceptor + ApiException + login/logout
    file_download.dart      # authenticated PDF fetch → temp file → OS viewer (open_filex)
    format.dart             # money / date / time / period / qty (mirrors ess/lib/format.js)
    endpoints.dart          # the full /api/hr/me/* endpoint map (one source of truth)
    providers.dart          # Riverpod composition root + AuthController (login/logout/bootstrap)

  theme/app_theme.dart      # DriftHR brand (teal #16B6A6 / ink #16243B) Material 3 theme
  widgets/                  # state views, common atoms (InfoTip, StatusPill, SectionCard, KvRow), brand logo
  router/                   # go_router (auth-guarded redirect) + bottom-nav shell

  features/
    auth/        splash + login
    home/        dashboard + country-context gate + tasks/holidays providers
    attendance/  clock (geolocation punch) + corrections + punch math
    leave/       balances + apply (incl. LWP/half-day) + my requests
    pay/         payslips list + detail (+ PDF) + compensation (CTC) (+ PDF)
    approvals/   inbox + approve / decline / ask-for-changes
    profile/     rich governed profile (self-edit / hr-approval / read-only)
    letters/     issued letters (+ download) + requests + request-a-letter
    tax/         India IT-computation projection (+ PDF)
```

- **State:** `flutter_riverpod` (providers per feature; one `AuthController`).
- **Routing:** `go_router` with an auth-guarded `redirect` and a
  `StatefulShellRoute` bottom nav (Home · Attendance · Leave · Pay · More).
- **HTTP:** `dio` with a single interceptor that replays the captured session
  (`Cookie` + `Authorization: Bearer`) and surfaces non-2xx as `ApiException`.

## Auth (the contract this app mirrors)

Flutter has no browser cookie jar, so the session is replayed manually — exactly
like the legacy React Native client:

1. `POST {API_URL}/api/customer/login {email,password}` → the backend sets the
   httpOnly cookies `token` (+ `token_refresh`).
2. We capture the raw `Set-Cookie` from the login response, reduce it to the
   `name=value` pairs the server needs, and **persist them in
   `flutter_secure_storage`**.
3. A dio interceptor replays them as a `Cookie` header on every request. If the
   login body also returns a JSON `token`, we keep it as an
   `Authorization: Bearer` fallback (the backend's `readCustomerToken` accepts
   both).
4. The session is hydrated at boot (`main()`), so it **survives app restart**.
5. Any **401** anywhere clears the session and redirects to Login.

The "me" check is `GET /api/hr/me/profile` (the authoritative employee/profile +
country source). India-only surfaces (Tax projection) are gated on
`GET /api/hr/me/country-context` and **fail closed** when the country can't be
resolved.

## Screens → endpoints

| Screen | Endpoints |
| --- | --- |
| **Login** | `POST /api/customer/login` |
| **Home** | `/api/hr/me/profile`, `/api/hr/me/leave/balances`, `/api/hr/me/payslips`, `/api/hr/me/tasks`, `/api/hr/me/approvals`, `/api/hr/me/attendance/{punches,holidays}` |
| **Attendance** | `POST /api/hr/me/attendance/punch` (+ lat/long), `/punches`, `/regularizations` (GET+POST), `/schedule` |
| **Leave** | `/api/hr/me/leave/{types,balances,requests}`, `POST .../requests`, `POST .../requests/:id/cancel` |
| **Pay** | `/api/hr/me/payslips?page=&pageSize=`, `/payslips/:id`, `/payslips/:id/pdf` |
| **CTC** | `/api/hr/me/compensation`, `/compensation/pdf` |
| **Tax** (IN) | `/api/hr/me/tax-projection`, `/tax-projection/pdf` |
| **Approvals** | `/api/hr/me/approvals`, `POST /approvals/:id/decide` |
| **Profile** | `/api/hr/me/profile/full`, `PATCH /profile/{personal,contact}`, `POST /profile/change-requests` |
| **Letters** | `/api/hr/me/letters`, `/letters/:id/download`, `/letters/requests` (GET+POST) |

Every `/api/hr/me/*` route resolves the employee **server-side** from the session
— the app never sends an `employeeId` (SELF_ONLY).

## Implementation status

**Complete & wired to the real contract:** auth (cookie+Bearer, restart-safe,
401→logout), routing/shell, Home dashboard, Attendance (geolocation punch +
corrections), Leave (balances/apply/withdraw, LWP + half-day), Pay (list +
detail + own-PDF), CTC (monthly/annual + PDF), Tax projection (IN, fail-closed +
PDF), Approvals (decide with note), Profile (governed self-edit / change-request),
Letters (download + request). Pull-to-refresh, loading/empty/error and 404→empty
degradation, and ⓘ tooltips throughout.

**Intentionally scoped (stubbed / simplified vs. web):**
- **Profile** mirrors the governance model for Personal/Contact/Professional;
  the web's full Address / Family / Education / Bank / Nomination / Photo list
  editors are not ported (the endpoints exist in `core/endpoints.dart` and are
  trivial to add).
- **Home "pending tasks"** lists tasks but does not deep-link each task type yet.
- **Attendance** ships the Clock + Corrections experience; the web's monthly
  "Attendance Details" calendar table, Timesheets and Schedule tabs are not ported.
- **Brand logo** is a dependency-free wordmark; drop the real
  `drifthr-logo.svg` into `assets/` and reference it to swap.
- Reimbursements/Claims, Documents, Onboarding, Separation and Delegations
  (present in the web ESS) are out of scope for this first mobile cut.

## Not done here (no SDK on the authoring box)

- `flutter pub get` / `flutter analyze` / `flutter build` were **not** run.
  The code is hand-authored to be idiomatic and compilable; do a
  `flutter pub get && flutter analyze` first thing on a machine with the SDK.
- `pubspec.lock` and the native `android/`/`ios/` folders are not committed —
  generate them with `flutter create .`.
