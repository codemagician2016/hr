-- P3 — CustomerWallet + WalletLedgerEntry. One wallet per (businessId,
-- customerId); the ledger is the source of truth, balanceMinor is the
-- cached running total. Refunds with the walletCredit feature on route
-- to the wallet instead of the payment gateway.
CREATE TABLE "CustomerWallet" (
  "id"           TEXT PRIMARY KEY,
  "businessId"   TEXT NOT NULL,
  "customerId"   TEXT NOT NULL,
  "balanceMinor" INTEGER NOT NULL DEFAULT 0,
  "currency"     TEXT NOT NULL DEFAULT 'INR',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "CustomerWallet_businessId_customerId_key" ON "CustomerWallet"("businessId","customerId");
CREATE INDEX "CustomerWallet_businessId_idx" ON "CustomerWallet"("businessId");

CREATE TABLE "WalletLedgerEntry" (
  "id"                TEXT PRIMARY KEY,
  "walletId"          TEXT NOT NULL REFERENCES "CustomerWallet"("id") ON DELETE CASCADE,
  "businessId"        TEXT NOT NULL,
  "customerId"        TEXT NOT NULL,
  "deltaMinor"        INTEGER NOT NULL,
  "balanceAfterMinor" INTEGER NOT NULL,
  "reason"            TEXT NOT NULL,
  "refType"           TEXT,
  "refId"             TEXT,
  "note"              TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "WalletLedgerEntry_walletId_createdAt_idx" ON "WalletLedgerEntry"("walletId","createdAt");
CREATE INDEX "WalletLedgerEntry_businessId_createdAt_idx" ON "WalletLedgerEntry"("businessId","createdAt");
