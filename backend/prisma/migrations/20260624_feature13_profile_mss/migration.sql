-- Feature 13 — Rich Employee Profile + Field Governance, MSS, Org/Reporting tree.
-- ADDITIVE only: new nullable Employee columns + two new sub-models + their enums.
-- No data backfill, no NOT NULL on existing rows, no dropped columns — safe to apply
-- on a live tenant (mirrors the company-profile / feature10 additive migrations).
-- IF NOT EXISTS guards keep it idempotent against a schema that was previously
-- `db push`-ed (the hr_test schema was bootstrapped that way).

-- ── enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "EducationLevel" AS ENUM ('SCHOOL','DIPLOMA','BACHELORS','MASTERS','DOCTORATE','CERTIFICATION','OTHER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "AddressType" AS ENUM ('CORRESPONDENCE','PERMANENT','OFFICE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Employee: rich Personal + Contact columns (Figma §Personal/§Contact) ─────
ALTER TABLE "Employee"
  ADD COLUMN IF NOT EXISTS "religion"            TEXT,
  ADD COLUMN IF NOT EXISTS "community"           TEXT,
  ADD COLUMN IF NOT EXISTS "motherTongue"        TEXT,
  ADD COLUMN IF NOT EXISTS "placeOfBirth"        TEXT,
  ADD COLUMN IF NOT EXISTS "stateOfBirthCode"    CHAR(2),
  ADD COLUMN IF NOT EXISTS "identificationMark"  TEXT,
  ADD COLUMN IF NOT EXISTS "heightCm"            DECIMAL(5,1),
  ADD COLUMN IF NOT EXISTS "weightKg"            DECIMAL(5,1),
  ADD COLUMN IF NOT EXISTS "fatherName"          TEXT,
  ADD COLUMN IF NOT EXISTS "fatherOccupation"    TEXT,
  ADD COLUMN IF NOT EXISTS "motherName"          TEXT,
  ADD COLUMN IF NOT EXISTS "motherOccupation"    TEXT,
  ADD COLUMN IF NOT EXISTS "homePhone"           TEXT,
  ADD COLUMN IF NOT EXISTS "officePhone"         TEXT;

-- ── EmployeeEducation ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "EmployeeEducation" (
  "id"           TEXT NOT NULL,
  "businessId"   TEXT NOT NULL,
  "employeeId"   TEXT NOT NULL,
  "level"        "EducationLevel" NOT NULL,
  "institution"  TEXT NOT NULL,
  "fieldOfStudy" TEXT,
  "startYear"    INTEGER,
  "endYear"      INTEGER,
  "grade"        TEXT,
  "isHighest"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeEducation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "EmployeeEducation_businessId_employeeId_idx"
  ON "EmployeeEducation" ("businessId","employeeId");

-- ── EmployeeAddress ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "EmployeeAddress" (
  "id"          TEXT NOT NULL,
  "businessId"  TEXT NOT NULL,
  "employeeId"  TEXT NOT NULL,
  "type"        "AddressType" NOT NULL,
  "sameAsType"  "AddressType",
  "line1"       TEXT,
  "line2"       TEXT,
  "city"        TEXT,
  "stateCode"   TEXT,
  "postalCode"  TEXT,
  "countryCode" CHAR(2),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeAddress_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeAddress_businessId_employeeId_type_key"
  ON "EmployeeAddress" ("businessId","employeeId","type");
CREATE INDEX IF NOT EXISTS "EmployeeAddress_businessId_employeeId_idx"
  ON "EmployeeAddress" ("businessId","employeeId");

-- ── FKs (cascade on delete, mirroring the other employee sub-models) ──────────
DO $$ BEGIN
  ALTER TABLE "EmployeeEducation"
    ADD CONSTRAINT "EmployeeEducation_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "EmployeeEducation"
    ADD CONSTRAINT "EmployeeEducation_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "EmployeeAddress"
    ADD CONSTRAINT "EmployeeAddress_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "EmployeeAddress"
    ADD CONSTRAINT "EmployeeAddress_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
