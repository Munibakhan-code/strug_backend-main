-- Board #434: add a "Videography" service under Events & Entertainment, and a new
-- "Driving School" macro category (with its bookable child services) to the /ondemand
-- main page.
--
-- The work_category taxonomy's source of truth is prisma/seed.js, but `prisma db seed`
-- does NOT run on deploy — only migrations do. So the seed is updated in the same commit
-- (for fresh environments) and this migration carries the same rows into the existing
-- staging and production databases.
--
-- Additive + idempotent: ON CONFLICT (slug) DO NOTHING, so re-running is a no-op and this
-- cannot disturb any existing category or the worker_category rows pointing at them.
--
-- Slug convention matches the seed exactly: macros are `<macro-slug>`, leaves are
-- `<macro-slug>--<leaf-name-slugified>`. is_active/is_live are set true to match every
-- other live category (the schema default for is_live is false, so it must be explicit).

-- 1. Videography, as a child of the existing Events & Entertainment macro.
INSERT INTO "work_category" ("name", "slug", "parent_id", "is_active", "is_live")
SELECT 'Videography', 'events-entertainment--videography', p."work_category_id", true, true
FROM "work_category" p
WHERE p."slug" = 'events-entertainment'
ON CONFLICT ("slug") DO NOTHING;

-- 2. The Driving School macro (parent_id NULL = shows on the /ondemand main page).
INSERT INTO "work_category" ("name", "slug", "parent_id", "is_active", "is_live") VALUES
  ('Driving School', 'driving-school', NULL, true, true)
ON CONFLICT ("slug") DO NOTHING;

-- 3. Its child services. A macro with no children opens an empty "Select a service to
--    book" grid, so these ship together with it.
INSERT INTO "work_category" ("name", "slug", "parent_id", "is_active", "is_live")
SELECT v.name, v.slug, p."work_category_id", true, true
FROM (VALUES
  ('Driving Instructor', 'driving-school--driving-instructor'),
  ('Road Test Prep',     'driving-school--road-test-prep'),
  ('Defensive Driving',  'driving-school--defensive-driving'),
  ('Refresher Lessons',  'driving-school--refresher-lessons')
) AS v(name, slug)
JOIN "work_category" p ON p."slug" = 'driving-school'
ON CONFLICT ("slug") DO NOTHING;
