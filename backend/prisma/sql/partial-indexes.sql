-- ═══════════════════════════════════════════════════════════════════════════
-- Partial UNIQUE indexes — reapplied on EVERY deploy.
-- ───────────────────────────────────────────────────────────────────────────
-- Prisma's schema language cannot express a partial index (an index with a
-- WHERE clause), so these live only in raw SQL. The deploy pipeline runs
-- `prisma db push`, which reconciles the database against schema.prisma and
-- therefore NEVER creates them — the raw migrations that define them are not
-- executed. A production audit found 1264 indexes and ZERO partial ones: every
-- guard below was missing, on a live system.
--
-- They are not cosmetic. Each one is the DB-level backstop behind an
-- application check that is NOT atomic — the pre-check `findFirst` in
-- seedOnboardingJourney, for instance, is exactly why acceptOffer catches P2002
-- and returns 409. Without the index, two concurrent accepts each seed their own
-- onboarding journey and no error is ever raised.
--
-- Every statement is IF NOT EXISTS, so this file is safe to run on every deploy.
-- Keep it in sync when a new partial index is added to a migration.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS "onb_one_active_per_offer" ON "LifecycleJourney"("businessId", "offerId") WHERE "direction" = 'ONBOARDING' AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ofb_one_active_per_employee" ON "LifecycleJourney"("businessId", "employeeId") WHERE "direction" = 'OFFBOARDING' AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_workflowstep_seq" ON "WorkflowStep"("businessId","workflowDefinitionId","stepOrder") WHERE NOT "isParallel";

CREATE UNIQUE INDEX IF NOT EXISTS "Employee_businessId_workEmail_hireDate_active_key" ON "Employee" ("businessId", "workEmail", "hireDate") WHERE "workEmail" IS NOT NULL AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_letterhead_default" ON "CompanyLetterhead"("businessId","entityId") WHERE "isDefault" AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_letterhead_category" ON "CompanyLetterhead"("businessId","entityId","letterCategory") WHERE "letterCategory" IS NOT NULL AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "AnomalyAcknowledgement_payRunId_code_runscoped_key" ON "AnomalyAcknowledgement" ("payRunId", "code") WHERE "employeeId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Form16Certificate_active_emp_batch_key" ON "Form16Certificate"("businessId", "batchId", "employeeId") WHERE "status" IN ('PENDING', 'ISSUED', 'PENDING_SIGNATURE', 'VOIDED');

CREATE UNIQUE INDEX IF NOT EXISTS "ArrearCycle_businessId_compensationRevisionId_live_key" ON "ArrearCycle" ("businessId", "compensationRevisionId") WHERE "deletedAt" IS NULL;
