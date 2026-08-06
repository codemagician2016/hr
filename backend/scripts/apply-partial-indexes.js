#!/usr/bin/env node
/**
 * apply-partial-indexes.js — reapply the partial UNIQUE indexes after `db push`.
 *
 * WHY THIS EXISTS
 * ───────────────────────────────────────────────────────────────────────────
 * Prisma's schema language cannot express a partial index (one with a WHERE
 * clause), so the nine in prisma/sql/partial-indexes.sql live only in raw SQL.
 * The deploy pipeline runs `prisma db push`, which reconciles the database
 * against schema.prisma and never executes those raw migrations — so on a box
 * that has only ever been deployed this way, NONE of them exist. A production
 * audit confirmed it: 1264 indexes, zero partial ones.
 *
 * Each is the database-level backstop behind a non-atomic application check
 * (e.g. seedOnboardingJourney pre-checks with findFirst, and acceptOffer catches
 * the resulting P2002 to return 409 "Offer already accepted"). Without the
 * index, two concurrent accepts each seed a separate onboarding journey and
 * nothing ever errors.
 *
 * BEHAVIOUR
 * ───────────────────────────────────────────────────────────────────────────
 * Idempotent (every statement is IF NOT EXISTS) and NON-FATAL. A unique index
 * cannot be created over data that already violates it, and these boxes have
 * been running unguarded — so duplicates may already exist. When one fails, this
 * reports the index and the reason and moves on rather than aborting a deploy
 * mid-flight. Exit code stays 0; the summary line is the signal to act on.
 *
 * Usage:  node scripts/apply-partial-indexes.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const prisma = require('../src/core/lib/prisma');

const SQL_FILE = path.join(__dirname, '..', 'prisma', 'sql', 'partial-indexes.sql');

// Split on ';' at statement end, dropping comments and blank lines.
function parseStatements(sql) {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${s};`);
}

function indexName(stmt) {
  const m = stmt.match(/INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i);
  return m ? m[1] : stmt.slice(0, 60);
}

async function main() {
  if (!fs.existsSync(SQL_FILE)) {
    console.error(`[partial-indexes] missing ${SQL_FILE} — nothing to apply`);
    return;
  }
  const statements = parseStatements(fs.readFileSync(SQL_FILE, 'utf8'));

  const before = await prisma.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexdef ILIKE '%WHERE%'`
  );
  const had = new Set(before.map((r) => r.indexname));

  let created = 0;
  const failed = [];

  for (const stmt of statements) {
    const name = indexName(stmt);
    if (had.has(name)) {
      console.log(`[partial-indexes] ok      ${name} (already present)`);
      continue;
    }
    try {
      await prisma.$executeRawUnsafe(stmt);
      created += 1;
      console.log(`[partial-indexes] created ${name}`);
    } catch (e) {
      // The overwhelmingly likely cause is pre-existing duplicate rows that the
      // index would forbid — real data that needs a human decision, not a retry.
      failed.push({ name, message: e.message.split('\n')[0] });
      console.error(`[partial-indexes] FAILED  ${name}: ${e.message.split('\n')[0]}`);
    }
  }

  console.log(`[partial-indexes] summary: ${created} created, ${statements.length - created - failed.length} already present, ${failed.length} failed`);
  if (failed.length) {
    console.error('[partial-indexes] the failures above are almost certainly duplicate rows that the');
    console.error('[partial-indexes] index would forbid. The guard is NOT in place for those tables —');
    console.error('[partial-indexes] dedupe the data, then re-run this script.');
  }
}

main()
  .catch((e) => {
    // Never fail a deploy from here.
    console.error(`[partial-indexes] unexpected error: ${e.message}`);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
