-- Feature 2: Attendance & Time — additive data model (no destructive change)

-- 3.3 Regularization kind discriminator
CREATE TYPE "RegularizationKind" AS ENUM ('MISSED_PUNCH', 'LATE_WAIVER', 'EARLY_OUT_WAIVER', 'WFH', 'ON_DUTY');
ALTER TABLE "AttendanceRegularizationRequest" ADD COLUMN "kind" "RegularizationKind" NOT NULL DEFAULT 'MISSED_PUNCH';

-- 3.2 ShiftPattern derivation-config columns + list index
ALTER TABLE "ShiftPattern" ADD COLUMN "graceOutMinutes" INTEGER;
ALTER TABLE "ShiftPattern" ADD COLUMN "minMinutesForPresent" INTEGER;
ALTER TABLE "ShiftPattern" ADD COLUMN "isFlexi" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShiftPattern" ADD COLUMN "otEligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShiftPattern" ADD COLUMN "dailyOtThresholdMin" INTEGER;
CREATE INDEX "ShiftPattern_businessId_isActive_idx" ON "ShiftPattern"("businessId", "isActive");

-- 3.1 Attendance.employee FK (employeeId already exists as a scalar column)
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3.4 OvertimeRule (entity/location-scoped policy)
CREATE TABLE "OvertimeRule" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "entityId" TEXT,
  "locationId" TEXT,
  "dailyThresholdMin" INTEGER NOT NULL DEFAULT 480,
  "weekdayMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 1.0,
  "weeklyOffMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 2.0,
  "holidayMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 2.0,
  "dailyCapMin" INTEGER,
  "roundingMin" INTEGER NOT NULL DEFAULT 15,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OvertimeRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OvertimeRule_businessId_entityId_locationId_idx" ON "OvertimeRule"("businessId", "entityId", "locationId");
ALTER TABLE "OvertimeRule" ADD CONSTRAINT "OvertimeRule_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
