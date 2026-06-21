-- Grocery fulfilment: sold-by-weight items + pick-exception (substitution / short) flow.
-- Additive, non-destructive: every new column is nullable or has a default, so
-- existing orders/products are unaffected.

-- Product: variable-weight selling (loose produce, meat, deli).
ALTER TABLE "Product"
  ADD COLUMN "soldByWeight"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pricePerKgMinor" INTEGER;

-- Order: pick-exception reconciliation + SLA promise time.
ALTER TABLE "Order"
  ADD COLUMN "adjustedTotalMinor" INTEGER,
  ADD COLUMN "refundedMinor"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "substitutionPolicy" TEXT,
  ADD COLUMN "promisedAt"         TIMESTAMP(3);

-- OrderItem: sold-by-weight snapshots + substitution / short state.
ALTER TABLE "OrderItem"
  ADD COLUMN "soldByWeight"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pricePerKgMinor"       INTEGER,
  ADD COLUMN "orderedWeightGrams"    INTEGER,
  ADD COLUMN "pickedWeightGrams"     INTEGER,
  ADD COLUMN "fulfillmentStatus"     TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "exceptionReason"       TEXT,
  ADD COLUMN "shortedQuantity"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "substitutionStatus"    TEXT,
  ADD COLUMN "substituteProductId"   TEXT,
  ADD COLUMN "substituteProductName" TEXT,
  ADD COLUMN "substitutePriceMinor"  INTEGER,
  ADD COLUMN "substituteQuantity"    INTEGER,
  ADD COLUMN "substituteWeightGrams" INTEGER;
