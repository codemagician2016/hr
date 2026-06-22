/** @type {import('next').NextConfig} */

// White-label ESS sub-app. The router (apps/router) fronts every tenant host
// and maps /ess-static/* → this app's static assets (ASSET_PREFIX_SUBAPP =
// { 'ess-static': 'ess' }). So we MUST set assetPrefix to '/ess-static' here,
// otherwise /_next/* chunks fall through the router and 404 → unstyled app.
//
// Runs on PORT 3020 (ESS_PORT). All /api/* calls are proxied to the backend
// origin so cookie-auth (credentials:'include') stays same-origin from the
// browser's perspective.

// Default EMPTY → browser uses same-origin relative /api (the edge router proxies
// /api → backend). A baked absolute URL (localhost) breaks prod fetches.
const apiOrigin = String(
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || ''
).replace(/\/$/, '');

const nextConfig = {
  assetPrefix: '/ess-static',
  transpilePackages: [
    '@hr/theme-engine',
    '@hr/types',
    '@hr/ui',
  ],
  env: {
    NEXT_PUBLIC_API_URL: apiOrigin,
  },
  async rewrites() {
    return apiOrigin ? [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }] : [];
  },
};

module.exports = nextConfig;
