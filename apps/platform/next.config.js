/** @type {import('next').NextConfig} */
const createNextIntlPlugin = require('next-intl/plugin');
const apiOrigin = String(
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:3001'
).replace(/\/$/, '');

// next-intl plugin: tells Next.js where the request config lives so
// every server component / route handler gets the right locale +
// messages without per-page boilerplate. See platform/i18n/request.js.
const withNextIntl = createNextIntlPlugin('./i18n/request.js');

const nextConfig = {
  transpilePackages: [
    '@hr/admin-core',
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

module.exports = withNextIntl(nextConfig);
