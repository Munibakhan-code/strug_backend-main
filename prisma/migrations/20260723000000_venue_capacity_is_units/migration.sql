-- Venues previously stored "Max attendees" in booking_listing.capacity. For
-- price_unit = event the booking engine treats capacity as concurrent same-day
-- inventory, so a hall listed for 200 people accepted ~200 overlapping bookings.
--
-- Move the attendee count into attributes.max_attendees (when missing) and force
-- capacity = 1: a venue listing is one physical space.
--
-- Explicit IS NULL arms: `attributes ? 'max_attendees'` is NULL when attributes
-- is NULL, and `NULL <> 1` is NULL — both statements are re-runnable.

UPDATE booking_listing
SET attributes = COALESCE(attributes, '{}'::jsonb) || jsonb_build_object('max_attendees', capacity)
WHERE vertical = 'venue'
  AND capacity IS NOT NULL
  AND capacity > 1
  AND (attributes IS NULL OR NOT (attributes ? 'max_attendees'));

UPDATE booking_listing
SET capacity = 1
WHERE vertical = 'venue'
  AND (capacity IS NULL OR capacity <> 1);
