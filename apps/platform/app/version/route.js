import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const serverStarted = new Date().toISOString();

function readPackedRef(gitDir, ref) {
  try {
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [hash, name] = line.trim().split(/\s+/);
      if (name === ref) return hash;
    }
  } catch {}
  return null;
}

function readGitInfo() {
  try {
    const repoRoot = path.resolve(process.cwd(), '..');
    const gitPath = path.join(repoRoot, '.git');
    const gitStat = fs.statSync(gitPath);
    let gitDir = gitPath;
    if (gitStat.isFile()) {
      const pointer = fs.readFileSync(gitPath, 'utf8').trim();
      gitDir = path.resolve(repoRoot, pointer.replace(/^gitdir:\s*/, ''));
    }

    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) {
      return { commit: head.slice(0, 7), branch: 'detached' };
    }

    const ref = head.slice(5);
    const branch = ref.replace('refs/heads/', '');
    let hash = null;
    try {
      hash = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    } catch {
      hash = readPackedRef(gitDir, ref);
    }
    return { commit: hash ? hash.slice(0, 7) : null, branch };
  } catch {
    return { commit: null, branch: null };
  }
}

export async function GET() {
  const git = readGitInfo();
  const body = {
    app: 'platform',
    commit: process.env.BUILD_COMMIT
      || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7)
      || git.commit
      || 'unknown',
    branch: process.env.BUILD_BRANCH
      || process.env.VERCEL_GIT_COMMIT_REF
      || git.branch
      || 'unknown',
    buildTime: process.env.BUILD_TIME || 'unknown',
    vercelEnv: process.env.VERCEL_ENV || null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID || null,
    serverStarted,
    uptimeSec: Math.floor(process.uptime()),
  };

  return NextResponse.json(body, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
