/** @type {import('next').NextConfig} */
// Default to EMPTY so the browser uses same-origin relative /api (the edge router
// proxies /api → backend). Only set NEXT_PUBLIC_API_URL for local dev where there
// is no router in front. A baked absolute URL (e.g. localhost) breaks prod fetches.
const apiOrigin = String(
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || ''
).replace(/\/$/, '');

// Identity of this build. Baked into the CLIENT bundle (NEXT_PUBLIC_BUILD_ID) and
// reported by the running SERVER at /api/app-version. When a deploy swaps the
// server underneath an open tab, the two stop matching — that difference is what
// tells the browser to offer an update instead of silently breaking on a chunk
// that no longer exists.
const { resolveBuildId } = require('./lib/buildId');

const buildId = resolveBuildId();

const nextConfig = {
  transpilePackages: [
    '@hr/theme-engine',
    '@hr/types',
    '@hr/ui',
  ],
  // Next's own build id — also what names the /_next/static/<buildId>/ directory,
  // so pinning it keeps the served asset paths consistent with what we report.
  generateBuildId: () => buildId,
  env: {
    NEXT_PUBLIC_API_URL: apiOrigin,
    NEXT_PUBLIC_BUILD_ID: buildId,
  },
  // Proxy /api/* to the backend so cookie auth shares the app origin and
  // fetches can use same-origin relative paths (credentials:'include').
  async rewrites() {
    // Only proxy when an explicit origin is set (local dev). In prod the edge
    // router owns /api, so a relative self-rewrite would loop.
    return apiOrigin ? [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }] : [];
  },
  // Letters slice 9C visual position-picker rasterizes PDFs client-side via
  // pdfjs-dist. pdfjs declares `canvas` as an OPTIONAL (Node-only) dependency;
  // in the browser it is unused (the package's own `browser` field maps it to
  // false). Alias it to false so webpack does not try to bundle the native
  // `canvas` addon into the client bundle (the documented Next.js + pdf.js step).
  webpack(config) {
    config.resolve = config.resolve || {};
    config.resolve.alias = { ...(config.resolve.alias || {}), canvas: false };
    return config;
  },
};

module.exports = nextConfig;
