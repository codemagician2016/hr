-- Keep existing restaurant tenants on the restaurant reservations theme.
-- The onboarding profession key is restaurant-bookings; older mapping code
-- only understood restaurant-reservations, so some tenants landed on a
-- generic/doctor-like fallback theme.

UPDATE "Subscription" AS s
SET "theme" = 'restaurant_reservations'
FROM "Business" AS b
WHERE s."businessId" = b."id"
  AND b."vertical" = 'APPOINTMENT'
  AND b."category" IN ('restaurant-bookings', 'restaurant-reservations')
  AND (
    s."theme" IS NULL
    OR s."theme" IN (
      'default',
      'other',
      'general_practice',
      'doctor_clinic',
      'restaurant',
      'restaurant-bookings',
      'restaurant_bookings',
      'restaurant-reservations'
    )
  );
