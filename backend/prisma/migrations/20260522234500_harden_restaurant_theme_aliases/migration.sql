-- Restaurant Reservations can be selected by the theme key
-- restaurant_reservations as well as older profession aliases. Keep all
-- existing appointment tenants on the restaurant theme, and repair obvious
-- doctor-clinic starter copy that was saved before the alias was handled.

UPDATE "Subscription" AS s
SET "theme" = 'restaurant_reservations'
FROM "Business" AS b
WHERE s."businessId" = b."id"
  AND b."vertical" = 'APPOINTMENT'
  AND (
    b."category" IN ('restaurant-bookings', 'restaurant-reservations', 'restaurant_reservations')
    OR s."theme" IN ('restaurant-bookings', 'restaurant_bookings', 'restaurant-reservations')
  )
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
      'restaurant-reservations',
      'restaurant_reservations'
    )
  );

UPDATE "BusinessContent" AS bc
SET
  "heroHeadline" = 'Reserve your table',
  "heroSubheading" = 'Choose your party size, pick a time, and arrive to a dining room that is ready for you.',
  "heroCtaText" = 'Reserve a Table',
  "tagline" = 'Warm service, well-paced dining',
  "servicesIntro" = 'Book lunch, dinner, or a private dining enquiry.',
  "aboutTitle" = 'A smoother way to welcome guests',
  "aboutBody" = 'Online reservations are matched against real tables, service periods, party size, and turnover time so the host stand stays calm even on busy nights.',
  "teamTitle" = 'Meet our hosts',
  "teamIntro" = 'Our host team coordinates table flow, guest notes, and smooth arrivals.',
  "teamMemberLabel" = 'Host',
  "contactTitle" = 'Plan your visit',
  "contactBody" = 'Share your party size, preferred time, and any seating or dietary notes.',
  "ctaHeadline" = 'Ready to dine?',
  "ctaBody" = 'Reserve a table online and arrive to a dining room prepared for your group.',
  "heroTrust1" = 'Real table availability',
  "heroTrust2" = 'Guest notes captured',
  "heroTrust3" = 'Host stand ready',
  "navTeamLabel" = 'Hosts',
  "navBookingLabel" = 'Reservations',
  "footerLinkBookLabel" = 'Reserve a Table',
  "heroBannerUrl" = NULL,
  "aboutImageUrl" = NULL,
  "cmsServices" = '[{"name":"Table Reservation","duration":90,"category":"Dining","description":"Reserve a table for lunch, dinner, or a special occasion.","price":"","currency":"USD"},{"name":"Private Dining Enquiry","duration":120,"category":"Private Dining","description":"Request a larger table, private room, or event-style dining experience.","price":"","currency":"USD"}]',
  "cmsTeam" = '[{"name":"Host Stand","role":"Reservations team","bio":"Coordinates arrivals, seating preferences, and service-period pacing.","showOnWebsite":true}]'
FROM "Business" AS b
JOIN "Subscription" AS s ON s."businessId" = b."id"
WHERE bc."businessId" = b."id"
  AND b."vertical" = 'APPOINTMENT'
  AND s."theme" = 'restaurant_reservations'
  AND (
    bc."heroHeadline" ILIKE '%health%'
    OR bc."heroHeadline" ILIKE '%medical%'
    OR bc."heroSubheading" ILIKE '%medical%'
    OR bc."aboutBody" ILIKE '%medical%'
    OR bc."teamTitle" ILIKE '%doctor%'
    OR bc."teamMemberLabel" ILIKE '%doctor%'
    OR bc."navTeamLabel" ILIKE '%doctor%'
    OR bc."heroCtaText" ILIKE '%appointment%'
  );
