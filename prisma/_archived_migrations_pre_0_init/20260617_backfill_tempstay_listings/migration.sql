-- Backfill: copy demo Temp Stay rows from the legacy rental_listing table into
-- the shared booking engine (vertical = 'tempstay'). Idempotent — a row is only
-- migrated once, tracked via attributes->>'rental_listing_id'. Listings without
-- an owner are skipped (a booking needs a host). Default cleaning/service fees
-- ($35 / 12%) were previously hardcoded in the frontend; they live on the
-- listing now so pricing is server-authoritative.
INSERT INTO "booking_listing"
  (vertical, owner_id, title, description, location, price, price_unit,
   currency, instant_book, is_active, cleaning_fee, service_fee_pct, images, attributes)
SELECT
  'tempstay',
  rl.owner_id,
  rl.rental_listing_name,
  rl.description,
  rl.location,
  rl.amount,
  'night',
  'CAD',
  COALESCE(rl.instant_booking, false),
  COALESCE(rl.is_available, true),
  35,
  12,
  (SELECT json_agg(p.url)
     FROM "rental_listing_pics" p
    WHERE p.rental_listing_id = rl.rental_listing_id AND p.url IS NOT NULL),
  jsonb_build_object('rental_listing_id', rl.rental_listing_id, 'migrated_from', 'rental_listing')
FROM "rental_listing" rl
WHERE rl.owner_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "booking_listing" bl
     WHERE bl.vertical = 'tempstay'
       AND bl.attributes->>'rental_listing_id' = rl.rental_listing_id::text
  );
