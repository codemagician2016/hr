/** @type {import('next').NextConfig} */
const apiOrigin = String(
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:3001'
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
    return [
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
