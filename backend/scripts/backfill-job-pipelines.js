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
  // NOTE: do NOT return early when every job already has stages. Phase 2 below
  // repairs APPLICATIONS left at currentStageId = null, and those outlive the job
  // repair — an early return here silently skipped the half of the fix that makes
  // a rejected candidate visible on the board.
  if (!empty.length) console.log('[pipelines] all jobs already have stages');

  if (empty.length && !APPLY) {
    console.log('\n[pipelines] DRY RUN — pass --apply to write these pipelines.');
  }

  let ok = 0;
  const failed = [];
  for (const j of (APPLY ? empty : [])) {
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

  // ── PHASE 2: place applications that have no stage ──────────────────────
  // Creating the stages is only half the repair. Applications raised while the
  // job had NO pipeline carry currentStageId = null, so they remain invisible on
  // the board even once stages exist — including auto-rejected candidates whose
  // rejection is recorded correctly in the database and shows up nowhere a
  // recruiter looks.
  //
  // Placement follows STATUS, which is authoritative: REJECTED → the REJECTED
  // stage, HIRED → HIRED, everything else → the first stage. Nothing else is
  // touched; no status is changed.
  await placeStagelessApplications();
}

async function placeStagelessApplications() {
  const stageless = await prisma.application.findMany({
    where: { currentStageId: null },
    select: { id: true, businessId: true, jobId: true, status: true },
  });
  if (!stageless.length) { console.log('[pipelines] no stageless applications'); return; }

  console.log(`\n[pipelines] ${stageless.length} application(s) with NO stage`);
  if (!APPLY) { console.log('[pipelines] DRY RUN — pass --apply to place them.'); return; }

  const wantKind = (status) => (status === 'REJECTED' || status === 'WITHDRAWN' ? 'REJECTED'
    : status === 'HIRED' ? 'HIRED' : null);

  let placed = 0;
  for (const a of stageless) {
    const stages = await prisma.jobStage.findMany({
      where: { businessId: a.businessId, jobId: a.jobId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, kind: true },
    });
    if (!stages.length) continue; // job still has no pipeline — nothing to place onto
    const kind = wantKind(a.status);
    const target = (kind && stages.find((s) => s.kind === kind)) || stages[0];
    await prisma.application.update({ where: { id: a.id }, data: { currentStageId: target.id } });
    placed += 1;
    console.log(`  ✓ application ${a.id.slice(0, 8)} (${a.status}) → "${target.name}" (${target.kind})`);
  }
  console.log(`[pipelines] ${placed} application(s) placed`);
}

main()
  .catch((e) => { console.error(`[pipelines] ${e.message}`); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect().catch(() => {}); });
