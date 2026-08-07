/**
 * GET /app-version — the build id of the server answering RIGHT NOW.
 *
 * NOT under /api on purpose: the edge router owns /api and proxies it to the
 * backend (`pathname.startsWith('/api/')` in apps/router/index.js), so an
 * /api/app-version route would never reach this app in production.
 *
 * The client compares this against the id compiled into its own bundle
 * (NEXT_PUBLIC_BUILD_ID). They are identical until a deploy restarts the server,
 * at which point the browser is knowingly running a stale bundle and can offer a
 * reload instead of failing on a chunk that no longer exists.
 *
 * MUST be uncached and dynamic. A cached answer here would report the OLD build
 * forever and the prompt would never appear — the exact bug this fixes.
 *
 * Deliberately public: it leaks only a build id, and an unauthenticated login
 * page needs to self-heal after a deploy just as much as a signed-in session.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  return new Response(
    JSON.stringify({ buildId: process.env.NEXT_PUBLIC_BUILD_ID || 'unknown' }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        // Belt and braces across every layer that might otherwise cache this:
        // the browser, a CDN, and Cloudflare specifically.
        'cache-control': 'no-store, max-age=0, must-revalidate',
        'cdn-cache-control': 'no-store',
        'cloudflare-cdn-cache-control': 'no-store',
      },
    },
  );
}
