-- Board #448: add a "General" service under the Automotive & Roadside macro, so a hirer can
-- book automotive work that doesn't fit one of the specific leaves, and a worker can offer it.
--
-- Both the user-facing picker (OnDemandHire) and the provider service picker (OnDemandWorker)
-- read the same GET /work-categories, so this single row covers "both user facing and provider
-- side" as the ticket asks — no frontend change is needed. The leaf has no ondemand.categories
-- i18n key, which is the existing convention for leaves: workCategoryLabel() falls back to the
-- DB name.
--
-- The work_category taxonomy's source of truth is prisma/seed.js, but `prisma db seed` does NOT
-- run on deploy — only migrations do. So the seed is updated in the same commit (for fresh
-- environments) and this migration carries the same row into the existing staging and production
-- databases.
--
-- Additive + idempotent: ON CONFLICT (slug) DO NOTHING, so re-running is a no-op and this cannot
-- disturb any existing category or the worker_category rows pointing at them.
--
-- Slug convention matches the seed exactly: leaves are `<macro-slug>--<leaf-name-slugified>`.
-- is_active/is_live are set true to match every other live category (the schema default for
-- is_live is false, so it must be explicit).

INSERT INTO "work_category" ("name", "slug", "parent_id", "is_active", "is_live")
SELECT 'General', 'automotive-roadside--general', p."work_category_id", true, true
FROM "work_category" p
WHERE p."slug" = 'automotive-roadside'
ON CONFLICT ("slug") DO NOTHING;
