-- Add NO_SHOW to AppointmentStatus so staff can mark a customer
-- who booked but didn't turn up. Distinguishes genuine cancellations
-- from ghost bookings (useful for per-customer reliability scoring later).
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'NO_SHOW';
