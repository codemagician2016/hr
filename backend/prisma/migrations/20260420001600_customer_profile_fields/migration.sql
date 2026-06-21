-- Customer profile fields — phone + dateOfBirth.
-- Both optional; surfaced in the customer portal Settings → Profile card.
-- Existing customers stay NULL until they fill them in.

ALTER TABLE "Customer" ADD COLUMN "phone" TEXT;
ALTER TABLE "Customer" ADD COLUMN "dateOfBirth" TIMESTAMP(3);
