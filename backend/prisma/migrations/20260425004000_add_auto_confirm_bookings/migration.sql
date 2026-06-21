-- Per-business toggle for auto-confirming new customer bookings.
-- Default OFF (false) so existing tenants stay on the manual-confirm
-- flow — the safe behaviour where the admin reviews each booking.
-- Admins flip this on from Settings → Bookings when they want
-- hands-off scheduling.

ALTER TABLE "Business"
  ADD COLUMN "autoConfirmBookings" BOOLEAN NOT NULL DEFAULT false;
