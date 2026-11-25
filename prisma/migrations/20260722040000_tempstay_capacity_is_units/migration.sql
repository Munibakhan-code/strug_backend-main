-- Tempstay stored a guest count in booking_listing.capacity, which the booking engine reads
-- as the number of concurrent bookable units — so a cottage listed as "Max guests = 4"
-- accepted four overlapping bookings for the same dates.
--
-- Move the guest count into attributes.max_guests (where the guest surfaces already look for
-- it) when it isn't recorded there, then pin capacity to 1: a stay listing is one property.
--
-- Note the explicit IS NULL arms. `attributes ? 'max_guests'` is NULL for a NULL attributes
-- column and NOT NULL is NULL, so those rows would be skipped without it; likewise
-- `NULL <> 1` is NULL. Both statements are re-runnable: after one pass neither predicate
-- matches anything.
--
-- Scoped to vertical = 'tempstay' only. hotel capacity ("Default rooms available") and
-- equipment copies genuinely mean units and must not be touched.

UPDATE booking_listing
SET attributes = COALESCE(attributes, '{}'::jsonb) || jsonb_build_object('max_guests', capacity)
WHERE vertical = 'tempstay'
  AND capacity IS NOT NULL
  AND capacity > 1
  AND (attributes IS NULL OR NOT (attributes ? 'max_guests'));

UPDATE booking_listing
SET capacity = 1
WHERE vertical = 'tempstay'
  AND (capacity IS NULL OR capacity <> 1);
