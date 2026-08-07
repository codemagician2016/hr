#!/usr/bin/env node
/**
 * recompute-application-scores.js — rescore existing applications after a change
 * to the scoring engine.
 *
 * WHY
 * ───────────────────────────────────────────────────────────────────────────
 * Scores are PERSISTED on the Application row (screeningScore, screeningMaxScore,
 * knockedOut, meritScore, scoreSnapshot). Fixing the engine changes what WOULD be
 * computed; it does not touch a row that was scored under the old rules. So after
 * a scoring fix, every existing candidate keeps their wrong number until something
 * rescores them — the per-candidate "Recompute" button, or this.
 *
 * The fix that prompted this: a Yes/No answer never matched its option, because
 * the candidate form submits a real boolean (true) while the option's value is
 * authored as its label ("Yes"). 'true' !== 'yes', so the answer scored 0 and
 * showed no label. Everyone who answered a Yes/No question was under-scored.
 *
 * The same mismatch could also mis-evaluate a KNOCKOUT whose pass value was typed
 * as "Yes" rather than the boolean true — which auto-rejects people who answered
 * correctly. This reports those separately and loudly, because a wrong score is
 * an unfair ranking, but a wrong rejection is a person turned away.
 *
 * USAGE
 * ───────────────────────────────────────────────────────────────────────────
 *   node scripts/recompute-application-scores.js                    # DRY RUN, all tenants
 *   node scripts/recompute-application-scores.js --business <id>    # one tenant
 *   node scripts/recompute-application-scores.js --job <id>         # one job
 *   node scripts/recompute-application-scores.js --apply            # write the changes
 *
 * Dry run by default and always: nothing is written unless --apply is passed.
 * It NEVER changes an application's status — reinstating a wrongly rejected
 * candidate is a hiring decision, so it is reported for a human to action.
 */

'use strict';

const path = require('path');
const prisma = require(path.resolve(__dirname, '..', 'src', 'core', 'lib', 'prisma'));
const { _internals } = require(path.resolve(
  __dirname, '..', 'src', 'hr', 'talent', 'recruitment', 'recruitment.scoring.controller',
));

const { recomputeAndPersist } = _internals;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const APPLY = process.argv.includes('--apply');
const ONLY_BUSINESS = arg('--business');
const ONLY_JOB = arg('--job');

const n = (v) => (v == null ? null : Number(v));
const fmt = (v) => (v == null ? '—' : String(v));

async function main() {
  console.log('');
  console.log(`recompute-application-scores — ${APPLY ? 'APPLY (writes)' : 'DRY RUN (writes nothing)'}`);
  if (ONLY_BUSINESS) console.log(`  business: ${ONLY_BUSINESS}`);
  if (ONLY_JOB) console.log(`  job:      ${ONLY_JOB}`);
  console.log('');

  const where = {};
  if (ONLY_BUSINESS) where.businessId = ONLY_BUSINESS;
  if (ONLY_JOB) where.jobId = ONLY_JOB;

  const apps = await prisma.application.findMany({
    where,
    select: {
      id: true, businessId: true, jobId: true, status: true,
      screeningScore: true, screeningMaxScore: true, knockedOut: true, meritScore: true,
      candidate: { select: { firstName: true, lastName: true, email: true } },
      job: { select: { title: true, code: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`${apps.length} application(s) in scope\n`);
  if (!apps.length) { await prisma.$disconnect(); return; }

  const changed = [];
  const unrejects = [];
  const failed = [];

  for (const a of apps) {
    const before = {
      score: n(a.screeningScore), max: n(a.screeningMaxScore),
      merit: n(a.meritScore), ko: !!a.knockedOut,
    };

    let after;
    try {
      if (APPLY) {
        const r = await recomputeAndPersist(null, a.businessId, a.id);
        if (!r) { failed.push({ a, why: 'not found' }); continue; }
        after = { score: n(r.screeningScore), max: n(r.screeningMaxScore), merit: n(r.meritScore), ko: !!r.knockedOut };
      } else {
        // DRY RUN — compute inside a transaction that is then ROLLED BACK, so the
        // preview goes through the exact same code path that --apply would use
        // rather than a reimplementation that could disagree with it.
        after = await prisma.$transaction(async (tx) => {
          const r = await recomputeAndPersist(tx, a.businessId, a.id);
          if (!r) throw new Error('not found');
          const snapshot = { score: n(r.screeningScore), max: n(r.screeningMaxScore), merit: n(r.meritScore), ko: !!r.knockedOut };
          throw Object.assign(new Error('__rollback__'), { snapshot });
        }).catch((e) => {
          if (e && e.snapshot) return e.snapshot;
          throw e;
        });
      }
    } catch (e) {
      failed.push({ a, why: e.message });
      continue;
    }

    const moved = before.score !== after.score
      || before.max !== after.max
      || before.merit !== after.merit
      || before.ko !== after.ko;
    if (!moved) continue;

    changed.push({ a, before, after });

    // The serious one: they were knocked out, they no longer are, and they were
    // rejected for it. A score is a ranking; this is a person who was turned away.
    if (before.ko && !after.ko && String(a.status).toUpperCase() === 'REJECTED') {
      unrejects.push({ a, before, after });
    }
  }

  const who = (a) => `${a.candidate?.firstName || ''} ${a.candidate?.lastName || ''}`.trim() || a.candidate?.email || a.id;

  if (!changed.length) {
    console.log('No application\'s score changes. Nothing to do.\n');
  } else {
    console.log(`${changed.length} application(s) change:\n`);
    for (const { a, before, after } of changed) {
      const job = a.job ? `${a.job.title}${a.job.code ? ` (${a.job.code})` : ''}` : a.jobId;
      console.log(`  ${who(a).padEnd(26)} ${job}`);
      console.log(`      application  ${fmt(before.score)}/${fmt(before.max)}  →  ${fmt(after.score)}/${fmt(after.max)}`);
      console.log(`      merit        ${fmt(before.merit)}  →  ${fmt(after.merit)}`);
      if (before.ko !== after.ko) console.log(`      knockedOut   ${before.ko}  →  ${after.ko}`);
      console.log('');
    }
  }

  if (unrejects.length) {
    console.log('─'.repeat(74));
    console.log(`ATTENTION — ${unrejects.length} REJECTED candidate(s) now PASS their knockout.`);
    console.log('Their status is left REJECTED: reinstating someone is a hiring decision,');
    console.log('not something a script should make. Review each and reopen if appropriate.');
    console.log('');
    for (const { a } of unrejects) {
      console.log(`  ${who(a).padEnd(26)} ${a.candidate?.email || ''}   application ${a.id}`);
    }
    console.log('─'.repeat(74));
    console.log('');
  }

  if (failed.length) {
    console.log(`${failed.length} could not be recomputed:`);
    for (const f of failed.slice(0, 20)) console.log(`  ${f.a.id} — ${f.why}`);
    console.log('');
  }

  if (!APPLY && changed.length) {
    console.log('DRY RUN — nothing was written. Re-run with --apply to persist these.\n');
  } else if (APPLY && changed.length) {
    console.log(`Applied to ${changed.length} application(s).\n`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FAILED', e);
  try { await prisma.$disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
