-- Make courier_customer.user_id unique (one customer row per user).
--
-- Dedup-safe: before adding the constraint, repoint any orders on a duplicate
-- row to the earliest row for that user, then delete the duplicates. Nullable
-- unique allows multiple NULL user_ids (Postgres), which is fine.
--
-- NOTE: prod (Azure) `migrate deploy` no-ops — apply this manually via psql,
-- and run the dedup blocks first. Staging (Neon) applies normally.

WITH ranked AS (
  SELECT customer_id,
         MIN(customer_id) OVER (PARTITION BY user_id) AS keep_id
  FROM "courier_customer"
  WHERE user_id IS NOT NULL
)
UPDATE "courier_order" o
SET customer_id = r.keep_id
FROM ranked r
WHERE o.customer_id = r.customer_id AND r.customer_id <> r.keep_id;

DELETE FROM "courier_customer" c
USING (
  SELECT customer_id,
         MIN(customer_id) OVER (PARTITION BY user_id) AS keep_id
  FROM "courier_customer"
  WHERE user_id IS NOT NULL
) r
WHERE c.customer_id = r.customer_id AND r.customer_id <> r.keep_id;

CREATE UNIQUE INDEX "courier_customer_user_id_key" ON "courier_customer"("user_id");
