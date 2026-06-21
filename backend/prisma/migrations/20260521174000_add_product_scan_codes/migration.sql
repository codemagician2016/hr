-- Product scan-code placeholders for barcode / QR workflows.
ALTER TABLE "Product"
  ADD COLUMN "barcode" TEXT,
  ADD COLUMN "qrCode" TEXT;

CREATE INDEX "Product_businessId_barcode_idx" ON "Product"("businessId", "barcode");
