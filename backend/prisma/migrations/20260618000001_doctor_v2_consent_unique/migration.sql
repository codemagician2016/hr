-- Doctor v2 — ConsentRecord unique per (business, customer, purpose) so the
-- consent upsert can't race into duplicate DPDP records. Replaces the plain
-- index with a unique one. Additive + retry-safe.
DROP INDEX IF EXISTS "ConsentRecord_businessId_customerId_purpose_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "ConsentRecord_businessId_customerId_purpose_key" ON "ConsentRecord"("businessId","customerId","purpose");
