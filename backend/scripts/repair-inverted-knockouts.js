#!/usr/bin/env node
/**
 * repair-inverted-knockouts.js — find BOOLEAN knockouts whose pass value is
 * almost certainly inverted, and re-evaluate the candidates they rejected.
 *
 * WHY
 * ───────────────────────────────────────────────────────────────────────────
 * The job-level screening editor took the knockout pass value as FREE TEXT and
 * parsed BOOLEAN with:
 *
 *     parts.map((p) => p.toLowerCase() === 'true')
 *
 * so any word that was not literally "true" became FALSE. Typing "Yes" — the
 * obvious answer for a Yes/No question — silently configured the rule as "you
 * pass ONLY if you answer No", and every candidate who answered correctly was
 * auto-rejected with "failed a knockout screening question".
 *
 * That happened on a live job. Candidates who answered Yes to "Can you commit to
 * a minimum internship duration of 3 months?" were rejected for it.
 *
 * The editor is fixed. This repairs the DATA the old editor wrote, and the people
 * it wrongly turned away.
 *
 * WHAT IT CONSIDERS SUSPECT
 * ───────────────────────────────────────────────────────────────────────────
 * A BOOLEAN knockout whose pass value is FALSE — i.e. "answering No is what
 * qualifies you". That is a legitimate rule in rare cases ("Do you require visa
 * sponsorship?"), so this NEVER edits silently: it reports every candidate, and
 * only flips the ones you name.
 *
 *   node scripts/repair-inverted-knockouts.js                 # report only
 *   node scripts/repair-inverted-knockouts.js --fix <qId>...  # flip + re-evaluate
 */
'use strict';

const prisma = require('../src/core/lib/prisma');
const { scoreScreening } = require('../src/hr/talent/recruitment/scoring');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const targets = new Set(args.filter((a) => !a.startsWith('--')));

async function main() {
  const suspects = await prisma.screeningQuestion.findMany({
    where: { isKnockout: true, kind: 'BOOLEAN', deletedAt: null },
    select: { id: true, businessId: true, jobId: true, prompt: true, knockoutValue: true },
  });

  const inverted = suspects.filter((q) => q.knockoutValue === false
    || (Array.isArray(q.knockoutValue) && q.knockoutValue.length === 1 && q.knockoutValue[0] === false));

  if (!inverted.length) { console.log('[knockouts] no BOOLEAN knockout has a FALSE pass value'); return; }

  console.log(`[knockouts] ${inverted.length} BOOLEAN knockout(s) where only "No" passes:\n`);
  for (const q of inverted) {
    const job = await prisma.job.findUnique({ where: { id: q.jobId }, select: { title: true, code: true } });
    const rejected = await prisma.application.count({
      where: { businessId: q.businessId, jobId: q.jobId, knockedOut: true },
    });
    console.log(`  ${q.id}`);
    console.log(`    job      : ${job ? `${job.title} (${job.code})` : q.jobId}`);
    console.log(`    question : ${q.prompt}`);
    console.log(`    rule     : passes ONLY if the candidate answers "No"`);
    console.log(`    impact   : ${rejected} knocked-out application(s) on this job`);
    console.log('');
  }

  if (!FIX) {
    console.log('[knockouts] REPORT ONLY. Some of these may be intentional');
    console.log('            ("Do you require visa sponsorship?"), so nothing is');
    console.log('            changed automatically. To flip one and re-evaluate its');
    console.log('            candidates:\n');
    console.log('            node scripts/repair-inverted-knockouts.js --fix <questionId>');
    return;
  }

  for (const q of inverted.filter((x) => targets.has(x.id))) {
    await prisma.screeningQuestion.update({ where: { id: q.id }, data: { knockoutValue: true } });
    console.log(`[knockouts] ${q.id} → pass value now TRUE ("Yes" qualifies)`);
    await reevaluate(q);
  }
}

// Re-score every knocked-out application on the job and lift the ones that now
// pass. Only applications rejected BY A KNOCKOUT are touched; a human rejection
// is never reversed.
async function reevaluate(q) {
  const questions = await prisma.screeningQuestion.findMany({
    where: { businessId: q.businessId, jobId: q.jobId, deletedAt: null },
    include: { options: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { sortOrder: 'asc' },
  });

  const apps = await prisma.application.findMany({
    where: { businessId: q.businessId, jobId: q.jobId, knockedOut: true },
    select: { id: true, status: true, rejectReason: true },
  });

  const firstStage = await prisma.jobStage.findFirst({
    where: { businessId: q.businessId, jobId: q.jobId },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, name: true },
  });

  let lifted = 0;
  for (const a of apps) {
    const answers = await prisma.screeningAnswer.findMany({
      where: { businessId: q.businessId, applicationId: a.id },
      select: { questionId: true, answerValue: true },
    });
    const res = scoreScreening(questions, answers);
    if (res.knockedOut) continue; // still legitimately knocked out

    // Only reverse OUR auto-rejection, never a human decision.
    const wasAuto = /auto-rejected/i.test(a.rejectReason || '');
    await prisma.application.update({
      where: { id: a.id },
      data: {
        knockedOut: false,
        screeningScore: res.score,
        screeningMaxScore: res.max,
        ...(wasAuto && a.status === 'REJECTED'
          ? { status: 'APPLIED', rejectReason: null, ...(firstStage ? { currentStageId: firstStage.id } : {}) }
          : {}),
      },
    });
    lifted += 1;
    console.log(`  ✓ ${a.id.slice(0, 8)} re-scored ${res.score}/${res.max}`
      + (wasAuto ? ` — auto-rejection LIFTED → ${firstStage ? firstStage.name : 'APPLIED'}` : ' (human rejection kept)'));
  }
  console.log(`[knockouts] ${lifted} application(s) re-evaluated on this job`);
}

main()
  .catch((e) => { console.error(`[knockouts] ${e.message}`); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect().catch(() => {}); });
