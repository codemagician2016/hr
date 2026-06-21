-- P11 — "Got it wrong" report flow. Routes through walletLib.credit() up to
-- per-feature autoCreditMaxMinor cap; above the cap, status stays PENDING.
CREATE TABLE "OrderIssueReport" (
  "id"             TEXT PRIMARY KEY,
  "businessId"     TEXT NOT NULL,
  "orderId"        TEXT NOT NULL,
  "orderItemId"    TEXT,
  "customerId"     TEXT,
  "customerEmail"  TEXT,
  "reasonCode"     TEXT NOT NULL,
  "description"    TEXT,
  "photoUrl"       TEXT,
  "status"         TEXT NOT NULL DEFAULT 'PENDING',
  "requestedMinor" INTEGER NOT NULL DEFAULT 0,
  "creditedMinor"  INTEGER NOT NULL DEFAULT 0,
  "walletEntryId"  TEXT,
  "reviewedAt"     TIMESTAMP(3),
  "reviewedById"   TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);
CREATE INDEX "OrderIssueReport_businessId_status_createdAt_idx" ON "OrderIssueReport"("businessId","status","createdAt");
CREATE INDEX "OrderIssueReport_orderId_idx" ON "OrderIssueReport"("orderId");
