-- Self-billed (Razorpay/India) GST tax invoices: a sequential invoice number on
-- each paid PaymentAttempt + an atomic per-series counter so the series is gapless.

ALTER TABLE "PaymentAttempt" ADD COLUMN "invoiceNumber" TEXT;
CREATE UNIQUE INDEX "PaymentAttempt_invoiceNumber_key" ON "PaymentAttempt"("invoiceNumber");

CREATE TABLE "InvoiceCounter" (
    "series" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("series")
);
