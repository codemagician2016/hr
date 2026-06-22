# DriftHR Mobile (Employee Self-Service)

Expo / React Native app for the DriftHR ESS. Consumes the real DriftHR API
(`process.env.EXPO_PUBLIC_API_URL`) using the customer session.

> Effortless HR & payroll, in your pocket.

## Stack

- Expo SDK ~51, React Native 0.74
- `@react-navigation/native` + `native-stack` + `bottom-tabs`
- `expo-secure-store` for session persistence

## Getting started

```bash
cd apps/hr-mobile
cp .env.example .env          # set EXPO_PUBLIC_API_URL
npm install                   # requires the Expo toolchain
npm start                     # expo start (press i / a / w)
```

> A full build requires the Expo toolchain (not present in the scaffold
> environment). Run `npm install` then `npx expo-doctor` / `npm start` at staging.

## Structure

```
App.js                       navigation: auth stack -> bottom tabs
index.js                     Expo root registration
app.json                     name DriftHR, scheme drifthr, brand icon/splash
babel.config.js              babel-preset-expo
tsconfig.json                TS/JS config (allowJs)
assets/                      brand icon, splash, logos
src/
  theme.js                   DriftHR palette (teal #16B6A6 / ink #16243B)
  AuthContext.js             session hydrate + login/logout
  lib/
    api.js                   fetch wrapper -> EXPO_PUBLIC_API_URL (+ cookie/token)
    format.js                money / date helpers
  components/ui.js           branded RN primitives (Card, Button, Pill, ...)
  screens/
    LoginScreen.js           POST /api/customer/login
    DashboardScreen.js       greeting, next payday, leave balance
    PayslipsScreen.js        GET /api/hr/me/payslips
    PayslipDetailScreen.js   GET /api/hr/me/payslips/:id (earnings/deductions/net)
    LeaveScreen.js           POST /api/hr/leave/requests + balance
    ClockInOutScreen.js      POST /api/hr/attendance/punch + today's punches
    ProfileScreen.js         GET /api/customer/me + sign out
```

## Session handling

The web ESS relies on the browser cookie jar; React Native has none. On login we
capture the raw `Set-Cookie` header and replay it as `Cookie` on every request,
persisted in `expo-secure-store`. A JSON `token` in the login body is also
accepted as a `Bearer` fallback.
