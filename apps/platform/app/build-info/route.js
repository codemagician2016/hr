// Diagnostic endpoint — returns the commit + build time captured at the
// last successful platform build by scripts/deploy.sh (`build_nextapp`
// writes `.build-info.json` next to the app on disk). Use this to
// confirm that a freshly-pushed commit actually reached EC2:
//
//   curl https://app.aapkatech.com/build-info
//
// Path notes:
// - Avoid `/api/*` — nginx on app.aapkatech.com proxies that to the
//   backend, so an /api/ route here never reaches platform Next.js.
// - Avoid `_`-prefixed folders — Next.js App Router treats them as
//   private (non-routed).

import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const file = path.join(process.cwd(), '.build-info.json');
  let body;
  try {
    body = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    body = {
      commit: process.env.BUILD_COMMIT || 'unknown',
      branch: process.env.BUILD_BRANCH || 'unknown',
      buildTime: process.env.BUILD_TIME || null,
      note: '.build-info.json not found — likely running in dev or not yet built by deploy.sh',
    };
  }
  return Response.json({ app: 'platform', ...body, servedAt: new Date().toISOString() }, {
    headers: { 'cache-control': 'no-store' },
  });
}
