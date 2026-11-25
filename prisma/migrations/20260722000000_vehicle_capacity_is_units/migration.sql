-- Vehicles previously stored passenger "Seats" in booking_listing.capacity, which the
-- booking engine treats as concurrent rentable units. Move seat counts into
-- attributes.seats (when missing) and force capacity = 1 for all vehicle listings.

UPDATE booking_listing
SET attributes = COALESCE(attributes, '{}'::jsonb) || jsonb_build_object('seats', capacity)
WHERE vertical = 'vehicle'
  AND capacity IS NOT NULL
  AND capacity > 1
  AND (attributes IS NULL OR NOT (attributes ? 'seats'));

UPDATE booking_listing
SET capacity = 1
WHERE vertical = 'vehicle'
  AND (capacity IS NULL OR capacity <> 1);
