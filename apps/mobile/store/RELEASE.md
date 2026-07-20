# DriftHR Employee — store release runbook (concrete instance)

App: **DriftHR Employee** · bundle id / applicationId **`com.drifthr.employee`** (identical on
both stores, permanent). Generic playbook: repo-root `MOBILE_APP_RELEASE_PLAYBOOK.md` — read
its §6 gotchas first. This file holds THIS app's concrete values.

## Backend targeting (dart-defines — replaces the generic playbook's FLAVOR)

The app is **multi-tenant**: one binary for every tenant; employees sign in with
Organization ID (Business.slug) + email + password. Two defines pick the environment:

| Build | defines |
|---|---|
| Staging (internal testing) | `--dart-define=API_URL=https://demo-staging.drifthr.com --dart-define=PLATFORM_DOMAIN=staging.drifthr.com` |
| Production | `--dart-define=API_URL=https://drifthr.com --dart-define=PLATFORM_DOMAIN=drifthr.com` |

The staging **router must carry the Feature-40 X-Tenant-Host patch** (apps/router) or
cross-tenant logins resolve to the origin host's tenant.

## Secrets (all chmod 600, all OUTSIDE git)

| Secret | Path |
|---|---|
| Apple ASC API key (.p8, shared) | `/Users/kp/AuthKey_23KYY4N7T4.p8` (key id `23KYY4N7T4`, issuer `78c68175-bf2f-4640-9d52-33ad40ce14ca`, team `N879SJBRLJ`) |
| iOS match passphrase | `/Users/kp/drifthr-employee-MATCH_PASSWORD.txt` |
| iOS certs repo (private) | `github.com/codemagician2016/drifthr-employee-certificates` |
| Android keystore + passwords | `apps/mobile/android/upload-keystore.p12` + `/Users/kp/drifthr-employee-ANDROID-keystore.txt` |
| Play service-account JSON (shared) | `/Users/kp/sitepresso-admin-PLAY-service-account.json` |

## One-time store records (HUMAN — Apple/Google 2FA login; API cannot do these)

1. **Apple**: developer.apple.com → Identifiers → `+` App ID `com.drifthr.employee`; then
   appstoreconnect.apple.com → My Apps → `+` New App (iOS, that bundle id, name
   "DriftHR Employee", any SKU).
2. **Google**: play.google.com/console → Create app (name "DriftHR Employee", package
   `com.drifthr.employee`, Free) → Users and permissions → invite
   `sitepresso-admin-publisher@morningbag-278916.iam.gserviceaccount.com` as **Admin**.

## Ship (after the records exist)

Env preamble first (playbook §2), plus:

```bash
export DEVELOPER_TEAM_ID=N879SJBRLJ
export ASC_KEY_ID=23KYY4N7T4
export ASC_ISSUER_ID=78c68175-bf2f-4640-9d52-33ad40ce14ca
export ASC_KEY_CONTENT=$(base64 -i /Users/kp/AuthKey_23KYY4N7T4.p8)
export MATCH_PASSWORD=$(cat /Users/kp/drifthr-employee-MATCH_PASSWORD.txt)
# match clones the certs repo over https — capture the gh token BEFORE fastlane
# (gotcha #4: setup_ci can leave the keychain in a state where `gh auth token`
# returns empty afterwards):
export MATCH_GIT_BASIC_AUTHORIZATION=$(printf 'codemagician2016:%s' "$(/Users/kp/.local/bin/gh auth token)" | base64)
```

**iOS → TestFlight**
```bash
cd /Users/kp/hr/apps/mobile/ios && fastlane bootstrap_signing   # every time (gotcha #3)
cd /Users/kp/hr/apps/mobile && /Users/kp/flutter/bin/flutter build ios --release --no-codesign \
  --dart-define=API_URL=https://demo-staging.drifthr.com --dart-define=PLATFORM_DOMAIN=staging.drifthr.com \
  --build-number="$(date -u +%Y%m%d%H%M)"
cd ios && fastlane beta
security default-keychain -s "$HOME/Library/Keychains/login.keychain-db"   # cleanup (gotcha #4)
```

**Android → Play internal testing**
```bash
cd /Users/kp/hr/apps/mobile && /Users/kp/flutter/bin/flutter build appbundle --release \
  --dart-define=API_URL=https://demo-staging.drifthr.com --dart-define=PLATFORM_DOMAIN=staging.drifthr.com \
  --build-number="$(date -u +%s)"          # epoch, NOT YYYYMMDDHHMM (gotcha #2)
cd android && fastlane play_internal
```

Then add testers: ASC → TestFlight → Internal Testing; Play Console → Internal testing →
Testers → opt-in link.
