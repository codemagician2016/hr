# DriftHR performance audit — 2026-07-24

**Headline: the application is not slow. The network path is.**
Server-side the whole stack answers in 2–50 ms. Users wait ~400 ms per request
because Cloudflare serves the DriftHR zones from **Singapore/Amsterdam instead of
Mumbai**, even though the origin box and the tunnel are both in Mumbai.

---

## 1. Measurements

### Server-side (on the box, tunnel bypassed)
| Layer | Time |
|---|---|
| hr-admin page render | 2.5–5 ms |
| ess / platform | 3–25 ms |
| mobile-web | 1.5–2 ms |
| via edge router (Host routing) | 5 ms |
| backend API (`/auth/me`, `/employees`, `/payroll/runs`, …) | 22–50 ms |
| login (bcrypt) | 148 ms |

Host is idle: load average **0.04**, 3.7 GB RAM free. Postgres is not a factor
(largest table 2 MB; the high `seq_scan` counts are on 3-row tables).

### Through the tunnel (what users experience)
| Request | Time |
|---|---|
| hr-admin page TTFB | **750–1500 ms** |
| API endpoints | **200–1300 ms** |
| a **567-byte static favicon** | **~480 ms** |

A 567-byte static file taking 480 ms is the proof: this is path latency, not
application work.

---

## 2. Root cause — Cloudflare edge selection

Same client, same minute:

| Zone | IPv4 colo | IPv6 colo |
|---|---|---|
| `cloudflare.com` (control) | **BOM** (Mumbai) | **BOM** |
| `app-staging.drifthr.com` | SIN (Singapore) | AMS (Amsterdam) |
| `drifthr.com` (production) | SIN | SIN |

- **Not the client network**: baseline RTT from the same machine — cloudflare.com
  86 ms, google.com 59 ms, EC2 ap-south-1 60 ms.
- **Not IPv6**: both protocols land on distant colos.
- **Not the tunnel origin side**: `cloudflared` is correctly registered to Mumbai
  colos (`bom03/06/08/10/11/12`, QUIC).

So each request travels India → SIN/AMS → Mumbai origin → back. That round trip is
the ~300–400 ms floor, and it is paid by **every** request, including cached static
assets (an edge cache HIT still measured 343 ms).

This pattern is characteristic of Cloudflare **free-plan** zones in India, which are
served from overseas POPs rather than the Indian metros.

### Fix options
| Option | Impact | Cost |
|---|---|---|
| **Upgrade the zone to a paid plan (Pro)** — restores Indian POP serving | Expected ~400 ms → ~100 ms per request; 3–4× faster everywhere | ~$20/mo per zone |
| **Argo Smart Routing** (add-on) | Optimises the middle mile origin-ward | usage-based |
| Serve origin directly (public ALB + DNS, drop the tunnel) | Removes the CF hop | loses tunnel's zero-inbound security posture |
| Do nothing | 400 ms floor remains | — |

**Recommendation:** upgrade the production zone first and re-measure; it is the only
change that moves the floor.

### Verification (re-run after any change)
```bash
# Which Cloudflare colo serves us? Want BOM, not SIN/AMS.
curl -s https://drifthr.com/cdn-cgi/trace | grep -E '^colo='
curl -s https://www.cloudflare.com/cdn-cgi/trace | grep -E '^colo='   # control

# End-to-end page + asset timing (repeatable harness)
bash qa/perf/perfbench.sh AFTER
```

---

## 3. Application fixes shipped in this pass

These reduce the *number* of round trips, which is the only app-side lever while the
400 ms floor exists.

1. **`AdminShell` waterfall removed.** It awaited `/api/auth/me` and then
   `/api/tenant/resolve` sequentially although they are independent — one wasted
   round-trip on *every* admin page load. Now issued in parallel via
   `Promise.allSettled`, preserving the 401→login redirect and the
   optional/failure-tolerant brand load.
2. **Request dedupe + short-TTL cache** in both `hr-admin/lib/api.js` and
   `ess/lib/api.js`:
   - concurrent GETs of the same URL share one in-flight promise;
   - a small allowlist of session-stable reads (`/api/auth/me`,
     `/api/tenant/resolve`, `meta`, `country-context`, org lookups, rbac
     permissions) is reused for 30 s instead of refetched on every navigation.
     `/api/auth/me` alone was fetched by `AdminShell` **and again** by many pages.
   - **any** write (POST/PATCH/PUT/DELETE) clears the cache, so login, logout and
     every mutation read through fresh.
   - **Security:** both maps are hard-gated to the browser. These modules can run in
     server components, where a module-level cache would be shared across all users
     of the Node process and leak one session's data into another.
   - Cached values are returned as clones so a caller mutating a result cannot
     corrupt the cache.

## 3b. Measured outcome of the code changes — read this before claiming a win

**The end-to-end page TTFB did not measurably improve** (baseline median ~0.97 s →
after ~0.78 s, but individual runs ranged 0.6–1.4 s: that spread is noise, not
signal). Two honest reasons:

1. The benchmark times the **anonymous login page**, which never exercises
   `AdminShell` or the API cache. It is a valid *floor* measurement, not a test of
   these changes.
2. The tunnel has a **concurrency step penalty**, measured directly:

| concurrent requests | min | median |
|---|---|---|
| 1 | 231 ms | 259 ms |
| 2 | 398 ms | 425 ms |
| 4 | 401 ms | 708 ms |
| 8 | 438 ms | 458 ms |

Going 1→2 concurrent costs a fixed ~170 ms, after which it **plateaus** (8 concurrent
≈ 2 concurrent). Consequences:

- Parallelising **two** independent calls (the `AdminShell` change) trades one saved
  round-trip against the concurrency step — roughly **break-even today**. It is still
  the structurally correct shape and will pay off once the routing floor is fixed, so
  it stays; but it is not a win to claim now.
- Parallelising **many** calls is a large win: 8 sequential ≈ 8 × 259 ≈ 2070 ms
  versus ≈ 458 ms in parallel (**~4.5×**).
- **A request never sent costs nothing.** The dedupe + cache work is therefore the
  most reliable app-side gain, even though an HTTP-level harness cannot measure it
  (the cache lives in the browser).

**Regression check:** full custom-fields E2E **27/27** after the change — no
behaviour broken.

## 4. Investigated and deliberately NOT changed
- **Bundle size.** First load is 435 KB across 11 assets for modern browsers — the
  112 KB polyfills chunk carries `noModule` and is skipped by modern browsers, and
  `pdfjs-dist` + `leaflet` are *already* dynamically imported (code-split). Assets
  are `immutable` and edge-cached. Not a meaningful lever; changing it would be
  churn.
- **Database / backend queries.** 22–50 ms end-to-end on an idle box. Nothing to win
  here until the network floor is fixed.
- **A "12 sequential API calls" reading on some settings pages** turned out to be
  wrong on inspection — those are parallel `.then()` chains and per-tab lazy loads,
  not a waterfall.

## 5. Secondary observations (not causing the current slowness)
- `drifthr-hms-backend` shows **65 restarts** (platform 44, ess 50, chat 48). Worth
  investigating for stability/cold starts, though uptime is currently 1788 min.
- `cloudflared` is on 2026.5.2 with 2026.7.3 available, and the tunnel log shows
  intermittent QUIC resets (`failed to dial to edge with quic: timeout`). Upgrading
  is low-risk hygiene.
- 44 PM2 processes share this 2-vCPU box across several products; fine at current
  load but no headroom for a traffic spike.
