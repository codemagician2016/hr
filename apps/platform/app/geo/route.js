// Returns the caller's best-guess country/city.
// Cloudflare sets cf-ipcountry on every proxied request; legacy x-vercel-* kept as fallback.
// Locally (no proxy) the headers are absent — caller should fall back to the pricing config's defaultRegion.

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const country = request.headers.get('cf-ipcountry')
    || request.headers.get('x-vercel-ip-country')
    || null;
  const city = request.headers.get('cf-ipcity')
    || request.headers.get('x-vercel-ip-city')
    || null;
  return Response.json(
    { country, city },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
