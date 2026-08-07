/** @type {import('next').NextConfig} */
const createNextIntlPlugin = require('next-intl/plugin');
const apiOrigin = String(
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:3001'
).replace(/\/$/, '');

// next-intl plugin: tells Next.js where the request config lives so
// every server component / route handler gets the right locale +
// messages without per-page boilerplate. See platform/i18n/request.js.
const withNextIntl = createNextIntlPlugin('./i18n/request.js');

// Identity of this build — baked into the CLIENT bundle (NEXT_PUBLIC_BUILD_ID) and
// reported by the running SERVER at /app-version. A deploy makes the two differ,
// which is how an already-open tab learns it is running a dead bundle.
const { resolveBuildId } = require('./lib/buildId');

const buildId = resolveBuildId();

const nextConfig = {
  generateBuildId: () => buildId,
  transpilePackages: [
    '@hr/admin-core',
    '@hr/theme-engine',
    '@hr/types',
    '@hr/ui',
  ],
  env: {
    NEXT_PUBLIC_API_URL: apiOrigin,
    NEXT_PUBLIC_BUILD_ID: buildId,
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

module.exports = withNextIntl(nextConfig);
