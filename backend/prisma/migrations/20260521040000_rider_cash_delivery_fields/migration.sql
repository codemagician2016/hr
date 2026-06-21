-- Rider delivery cash control: record what cash was handed over,
-- what change was returned, and any payment note/reference captured at
-- the doorstep.
ALTER TABLE "EcomDeliveryRouteStop"
  ADD COLUMN "cashReceivedMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cashChangeDueMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "paymentReference" TEXT,
  ADD COLUMN "paymentNote" TEXT;
