-- Feature 15 — India income-tax projection: additive, nullable declaration
-- inputs on StatutoryProfile (OLD-regime HRA/Chapter-VI-A, perquisites,
-- previous-employer income/TDS). All columns nullable -> zero migration risk;
-- no backfill, no NOT NULL, no defaults beyond the existing boolean defaults.

ALTER TABLE "StatutoryProfile"
  ADD COLUMN IF NOT EXISTS "hraAnnualRentPaid"        DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "hraMetroCity"             BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sec80DDeclared"           DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "sec80CCD1BDeclared"       DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "sec80TTADeclared"         DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "sec24BHomeLoanInterest"   DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "otherChapterVIADeclared"  JSONB,
  ADD COLUMN IF NOT EXISTS "perqRentFreeAccom"        BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS "perqAccomCityPopBand"     VARCHAR(8),
  ADD COLUMN IF NOT EXISTS "perqAccomIsLeased"        BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS "perqAccomLeaseRentPaid"   DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "perqConcessionalLoanBal"  DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "perqLoanRateChargedPct"   DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "prevEmployerTaxableIncome" DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "prevEmployerTdsDeducted"   DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS "prevEmployerFY"            VARCHAR(7);
