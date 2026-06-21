-- Per-user "Service provider" flag — separate from showOnWebsite.
-- Governs whether the user appears in the booking flow (can receive
-- customer appointments). Lets the business owner step away from taking
-- bookings personally once they have staff to handle them.
-- Defaults to true so existing users keep their current bookable state.
-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "isServiceProvider" BOOLEAN NOT NULL DEFAULT true;
