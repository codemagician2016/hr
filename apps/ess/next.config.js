/** @type {import('next').NextConfig} */

// White-label ESS sub-app. The router (apps/router) fronts every tenant host
// and maps /ess-static/* → this app's static assets (ASSET_PREFIX_SUBAPP =
// { 'ess-static': 'ess' }). So we MUST set assetPrefix to '/ess-static' here,
// otherwise /_next/* chunks fall through the router and 404 → unstyled app.
//
// Runs on PORT 3020 (ESS_PORT). All /api/* calls are proxied to the backend
// origin so cookie-auth (credentials:'include') stays same-origin from the
// browser's perspective.

const apiOrigin = String(
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:3001'
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
    return [
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
