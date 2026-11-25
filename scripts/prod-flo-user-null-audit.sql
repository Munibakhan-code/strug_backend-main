-- Read-only. Counts exactly the rows that migration
-- 20260905140000_flo_user_unique_health_fks would DELETE on prod.
--
-- That migration opens with three unconditional deletes plus a cascade:
--   DELETE FROM "cycle_prediction" WHERE "flo_user_id" IS NULL;
--   DELETE FROM "period"           WHERE "flo_user_id" IS NULL;
--   DELETE FROM "symptom_log"      WHERE "flo_user_id" IS NULL;
--   DELETE FROM "flo_user"         WHERE "user_id"     IS NULL;   (cascades to the three above)
-- Health data is not recoverable once it goes, so count before promoting.
\pset pager off
SELECT 'cycle_prediction: flo_user_id IS NULL' AS check, count(*) FROM "cycle_prediction" WHERE "flo_user_id" IS NULL
UNION ALL SELECT 'period: flo_user_id IS NULL',           count(*) FROM "period"           WHERE "flo_user_id" IS NULL
UNION ALL SELECT 'symptom_log: flo_user_id IS NULL',      count(*) FROM "symptom_log"      WHERE "flo_user_id" IS NULL
UNION ALL SELECT 'flo_user: user_id IS NULL',             count(*) FROM "flo_user"         WHERE "user_id"     IS NULL
ORDER BY 1;

\echo '--- rows that would cascade from the flo_user delete ---'
SELECT 'cycle_prediction via orphan flo_user' AS check, count(*) FROM "cycle_prediction" c
  JOIN "flo_user" f ON f."flo_user_id" = c."flo_user_id" WHERE f."user_id" IS NULL
UNION ALL SELECT 'period via orphan flo_user', count(*) FROM "period" p
  JOIN "flo_user" f ON f."flo_user_id" = p."flo_user_id" WHERE f."user_id" IS NULL
UNION ALL SELECT 'symptom_log via orphan flo_user', count(*) FROM "symptom_log" s
  JOIN "flo_user" f ON f."flo_user_id" = s."flo_user_id" WHERE f."user_id" IS NULL
ORDER BY 1;

\echo '--- table totals for context ---'
SELECT 'flo_user' AS table, count(*) FROM "flo_user"
UNION ALL SELECT 'cycle_prediction', count(*) FROM "cycle_prediction"
UNION ALL SELECT 'period',           count(*) FROM "period"
UNION ALL SELECT 'symptom_log',      count(*) FROM "symptom_log"
ORDER BY 1;
