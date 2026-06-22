/** @type {import('next').NextConfig} */
// Default to EMPTY so the browser uses same-origin relative /api (the edge router
// proxies /api → backend). Only set NEXT_PUBLIC_API_URL for local dev where there
// is no router in front. A baked absolute URL (e.g. localhost) breaks prod fetches.
const apiOrigin = String(
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || ''
).replace(/\/$/, '');

const nextConfig = {
  transpilePackages: [
    '@hr/theme-engine',
    '@hr/types',
    '@hr/ui',
  ],
  env: {
    NEXT_PUBLIC_API_URL: apiOrigin,
  },
  // Proxy /api/* to the backend so cookie auth shares the app origin and
  // fetches can use same-origin relative paths (credentials:'include').
  async rewrites() {
    // Only proxy when an explicit origin is set (local dev). In prod the edge
    // router owns /api, so a relative self-rewrite would loop.
    return apiOrigin ? [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }] : [];
  },
};

module.exports = nextConfig;
