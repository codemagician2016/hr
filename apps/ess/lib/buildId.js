/**
 * buildId.js — the identity of THIS build, resolved once at build time.
 *
 * WHY THIS EXISTS
 * ---------------
 * These apps are compiled locally and the prebuilt .next is shipped to the box,
 * where pm2 restarts the server. A browser that was open across that deploy keeps
 * running the OLD bundle: its JS chunks are already in memory, and any chunk it
 * has not fetched yet now 404s because the filenames are content-hashed and the
 * old ones are gone. The user sees a half-broken screen and is told to "clear
 * your cache" — which nobody should ever have to be told.
 *
 * The fix needs one thing: a value the RUNNING SERVER reports that differs from
 * the value BAKED INTO the loaded bundle. Comparing the two is how the client
 * knows a deploy happened underneath it.
 *
 * Must be resolved at build time (not request time) so the value compiled into
 * the client bundle is frozen at the moment of the build.
 */

'use strict';

const { execSync } = require('child_process');

function resolveBuildId() {
  // An explicit id always wins — the deploy can pin one so every app in a single
  // ship reports the same value.
  if (process.env.BUILD_ID) return String(process.env.BUILD_ID).trim();

  // Git HEAD is the natural build identity: it is exactly what was shipped, and
  // it matches the commit the deploy ledger records.
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (sha) return sha;
  } catch { /* not a git checkout (e.g. building from a tarball) — fall through */ }

  // Last resort: the build's wall-clock. Guarantees a NEW id for a new build,
  // which is all the comparison actually requires.
  return `t${Date.now().toString(36)}`;
}

module.exports = { resolveBuildId };
