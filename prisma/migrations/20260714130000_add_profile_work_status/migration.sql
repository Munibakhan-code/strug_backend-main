-- Board #436: a LinkedIn-style "Available for work" status on the social profile, with room for
-- the other categories the ticket asks for ("open to career"/looking for a job, hiring).
--
-- Nullable with no default: NULL means the user has not opted in, and the profile renders no badge
-- at all. So this is additive and inert for every existing row.
--
-- VarChar rather than a Postgres enum on purpose — the allowed values are validated in the route
-- (social-profile-routes.js: WORK_STATUSES), so adding a status later is a code change instead of
-- a migration that rewrites a live table.

ALTER TABLE "social_profile" ADD COLUMN IF NOT EXISTS "work_status" VARCHAR(32);
