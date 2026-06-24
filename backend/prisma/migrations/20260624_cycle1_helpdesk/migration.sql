-- Cycle 1 — HR Helpdesk (ticketing) — wire the orphaned schema.
--
-- WHY: HelpdeskCategory / HelpdeskTicket / HelpdeskMessage (+ TicketPriority /
-- TicketStatus enums) were designed in schema.prisma but never had a migration,
-- so a fresh / production DB never got the tables. This migration is the canonical
-- DDL for the three models, PLUS the two Cycle-1 additive columns on HelpdeskTicket
-- (firstResponseAt — real SLA first-response stamp; satisfactionComment — free-text
-- alongside the 1–5 rating) and an ESS "My tickets" index (businessId, employeeId,
-- status).
--
-- ADDITIVE + idempotent (IF NOT EXISTS / DO blocks): applies cleanly to a fresh DB,
-- to a `prisma db push` DB (hr_test, where the base tables may already exist), and
-- re-runs safely. No data dropped or rewritten. The HD NumberSequence rows are minted
-- on demand by allocateCode(scope:'HD'), so no sequence seeding is needed here.

-- ── Enums ──────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "TicketPriority" AS ENUM ('LOW','NORMAL','HIGH','URGENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TicketStatus" AS ENUM ('OPEN','IN_PROGRESS','WAITING_ON_EMPLOYEE','RESOLVED','CLOSED','REOPENED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── HelpdeskCategory ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "HelpdeskCategory" (
  "id"                text NOT NULL,
  "businessId"        text NOT NULL,
  "name"              text NOT NULL,
  "slaHours"          integer,
  "defaultAssigneeId" text,
  "isActive"          boolean NOT NULL DEFAULT true,
  "createdAt"         timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HelpdeskCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HelpdeskCategory_businessId_name_key" ON "HelpdeskCategory" ("businessId","name");
CREATE INDEX IF NOT EXISTS "HelpdeskCategory_businessId_isActive_idx" ON "HelpdeskCategory" ("businessId","isActive");

-- ── HelpdeskTicket ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "HelpdeskTicket" (
  "id"                 text NOT NULL,
  "businessId"         text NOT NULL,
  "code"               text NOT NULL,
  "employeeId"         text NOT NULL,
  "categoryId"         text,
  "subject"            text NOT NULL,
  "description"        text,
  "priority"           "TicketPriority" NOT NULL DEFAULT 'NORMAL',
  "status"             "TicketStatus" NOT NULL DEFAULT 'OPEN',
  "assigneeId"         text,
  "slaDueAt"           timestamp(3),
  "firstResponseAt"    timestamp(3),
  "resolvedAt"         timestamp(3),
  "closedAt"           timestamp(3),
  "satisfactionRating" integer,
  "satisfactionComment" text,
  "createdAt"          timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          timestamp(3) NOT NULL,
  "deletedAt"          timestamp(3),
  "version"            integer NOT NULL DEFAULT 0,
  CONSTRAINT "HelpdeskTicket_pkey" PRIMARY KEY ("id")
);
-- Additive columns for an already-pushed table (hr_test) where the base CREATE was a no-op.
ALTER TABLE "HelpdeskTicket" ADD COLUMN IF NOT EXISTS "firstResponseAt" timestamp(3);
ALTER TABLE "HelpdeskTicket" ADD COLUMN IF NOT EXISTS "satisfactionComment" text;
CREATE UNIQUE INDEX IF NOT EXISTS "HelpdeskTicket_businessId_code_key" ON "HelpdeskTicket" ("businessId","code");
CREATE INDEX IF NOT EXISTS "HelpdeskTicket_businessId_status_priority_idx" ON "HelpdeskTicket" ("businessId","status","priority");
CREATE INDEX IF NOT EXISTS "HelpdeskTicket_businessId_assigneeId_status_idx" ON "HelpdeskTicket" ("businessId","assigneeId","status");
CREATE INDEX IF NOT EXISTS "HelpdeskTicket_businessId_employeeId_status_idx" ON "HelpdeskTicket" ("businessId","employeeId","status");

-- ── HelpdeskMessage (the threaded reply / internal-note model) ────────────────────
CREATE TABLE IF NOT EXISTS "HelpdeskMessage" (
  "id"              text NOT NULL,
  "businessId"      text NOT NULL,
  "ticketId"        text NOT NULL,
  "authorUserId"    text NOT NULL,
  "body"            text NOT NULL,
  "isInternal"      boolean NOT NULL DEFAULT false,
  "attachmentsJson" jsonb,
  "createdAt"       timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HelpdeskMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "HelpdeskMessage_businessId_ticketId_idx" ON "HelpdeskMessage" ("businessId","ticketId");

-- ── Foreign keys (tenant + raiser + thread cascade) ───────────────────────────────
DO $$ BEGIN
  ALTER TABLE "HelpdeskCategory" ADD CONSTRAINT "HelpdeskCategory_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "HelpdeskTicket" ADD CONSTRAINT "HelpdeskTicket_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "HelpdeskTicket" ADD CONSTRAINT "HelpdeskTicket_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- categoryId → HelpdeskCategory (SET NULL on delete so deleting a category keeps tickets).
DO $$ BEGIN
  ALTER TABLE "HelpdeskTicket" ADD CONSTRAINT "HelpdeskTicket_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "HelpdeskCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "HelpdeskMessage" ADD CONSTRAINT "HelpdeskMessage_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "HelpdeskMessage" ADD CONSTRAINT "HelpdeskMessage_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "HelpdeskTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
