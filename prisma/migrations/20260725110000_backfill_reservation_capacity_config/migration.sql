-- Backfill reservation listing capacity configuration so existing production
-- restaurants remain bookable after the engine began requiring explicit config.
--
-- Strategy (safe / additive only — never deactivates listings):
-- 1) Party size: copy attributes.max_guests → capacity when capacity is null/<=0.
-- 2) Concurrent inventory: if neither seating_capacity nor tables is a positive int,
--    default tables = 1 (one concurrent party). Hosts can raise this later.
-- 3) Turn time: default turn_time_minutes = 90 when missing.
-- 4) Strip any accidentally persisted booked_today computed field.

UPDATE booking_listing
SET capacity = (attributes->>'max_guests')::int
WHERE vertical = 'reservation'
  AND (capacity IS NULL OR capacity <= 0)
  AND attributes ? 'max_guests'
  AND (attributes->>'max_guests') ~ '^[1-9][0-9]*$';

UPDATE booking_listing
SET attributes = COALESCE(attributes, '{}'::jsonb)
  || jsonb_build_object('tables', 1)
WHERE vertical = 'reservation'
  AND (
    attributes IS NULL
    OR (
      NOT (
        attributes ? 'seating_capacity'
        AND (attributes->>'seating_capacity') ~ '^[1-9][0-9]*$'
      )
      AND NOT (
        attributes ? 'tables'
        AND (attributes->>'tables') ~ '^[1-9][0-9]*$'
      )
    )
  );

UPDATE booking_listing
SET attributes = COALESCE(attributes, '{}'::jsonb)
  || jsonb_build_object('turn_time_minutes', 90)
WHERE vertical = 'reservation'
  AND (
    attributes IS NULL
    OR (
      NOT (
        attributes ? 'turn_time_minutes'
        AND (attributes->>'turn_time_minutes') ~ '^[1-9][0-9]*$'
      )
      AND NOT (
        attributes ? 'turn_minutes'
        AND (attributes->>'turn_minutes') ~ '^[1-9][0-9]*$'
      )
    )
  );

UPDATE booking_listing
SET attributes = COALESCE(attributes, '{}'::jsonb)
  || jsonb_build_object('max_guests', capacity)
WHERE vertical = 'reservation'
  AND capacity IS NOT NULL
  AND capacity > 0
  AND (attributes IS NULL OR NOT (attributes ? 'max_guests'));

UPDATE booking_listing
SET attributes = attributes - 'booked_today'
WHERE vertical = 'reservation'
  AND attributes ? 'booked_today';
