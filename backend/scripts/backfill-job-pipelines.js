#!/usr/bin/env node
/**
 * backfill-job-pipelines.js — give existing jobs the pipeline they never got.
 *
 * WHY
 * ───────────────────────────────────────────────────────────────────────────
 * createJob used to seed a job's stages only when a pipeline template resolved,
 * and silently produced NO stages otherwise. A job with no stages looks completely
 * healthy — it lists, it publishes, candidates apply — but:
 *
 *   • the pipeline board is empty, so nobody can be moved through it,
 *   • an auto-rejected candidate has no REJECTED stage to land on, so a knockout
 *     failure never becomes visible on the board,
 *   • every stage-move call has nowhere to go.
 *
 * That was fixed in 5e1866b, but the fix only helps jobs created AFTER it. A
 * production audit found live jobs still sitting at zero stages, including a
 * client's only open role — with a real applicant already auto-rejected against a
 * pipeline that does not exist.
 *
 * This backfills them using the SAME resolution createJob now uses: the tenant's
 * default pipeline template → any template they have → the built-in fallback.
 *
 * SAFETY
 * ───────────────────────────────────────────────────────────────────────────
 * Additive and idempotent. autoApplyDefaultTemplate refuses any job that already
 * has stages, so re-running cannot disturb a configured pipeline. It touches no
 * application, no candidate and no status.
 *
 *   node scripts/backfill-job-pipelines.js            # report only (default)
 *   node scripts/backfill-job-pipelines.js --apply    # actually write
 */
'use strict';

const prisma = require('../src/core/lib/prisma');
const { autoApplyDefaultTemplate } = require('../src/hr/talent/controllers/pipelineTemplates.controller');

const APPLY = process.argv.includes('--apply');

async function main() {
  const jobs = await prisma.job.findMany({
    where: { deletedAt: null },
    select: { id: true, businessId: true, title: true, code: true, status: true },
  });

  const empty = [];
  for (const j of jobs) {
    const n = await prisma.jobStage.count({ where: { businessId: j.businessId, jobId: j.id } });
    if (n === 0) empty.push(j);
  }

  const businesses = await prisma.business.findMany({
    where: { id: { in: [...new Set(empty.map((j) => j.businessId))] } },
    select: { id: true, name: true },
  });
  const nameOf = Object.fromEntries(businesses.map((b) => [b.id, b.name]));

  console.log(`[pipelines] ${jobs.length} live job(s); ${empty.length} with NO stages`);
  for (const j of empty) {
    console.log(`  - ${nameOf[j.businessId] || j.businessId} :: "${j.title}" (${j.code}, ${j.status})`);
  }
  if (!empty.length) { console.log('[pipelines] nothing to backfill'); return; }

  if (!APPLY) {
    console.log('\n[pipelines] DRY RUN — pass --apply to write these pipelines.');
    return;
  }

  let ok = 0;
  const failed = [];
  for (const j of empty) {
    try {
      const res = await autoApplyDefaultTemplate(prisma, j.businessId, j.id);
      if (res && res.applied) {
        ok += 1;
        console.log(`  ✓ "${j.title}" ← ${res.source} (${res.count} stage(s))`);
      } else {
        failed.push(`${j.title}: ${(res && res.reason) || 'not applied'}`);
      }
    } catch (e) {
      failed.push(`${j.title}: ${e.message}`);
    }
  }

  console.log(`\n[pipelines] ${ok} job(s) backfilled, ${failed.length} failed`);
  for (const f of failed) console.error(`  ! ${f}`);
}

main()
  .catch((e) => { console.error(`[pipelines] ${e.message}`); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect().catch(() => {}); });
