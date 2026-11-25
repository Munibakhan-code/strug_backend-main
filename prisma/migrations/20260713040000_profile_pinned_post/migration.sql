-- #422: a user-selectable pinned post on the profile.
--
-- A pointer on social_profile rather than a flag on the post: town_hall_post.is_pinned already
-- drives the GLOBAL town hall feed sort (ORDER BY is_pinned DESC, ...), so reusing it for a
-- personal profile pin would shove that post to the top of everyone's feed. pinned_post_type
-- discriminates which table pinned_post_id points at ('social' | 'townhall').
--
-- Additive and nullable — no backfill needed; an unset pin simply means "nothing pinned", which
-- is exactly the pre-existing behaviour minus the fake most-liked-post guess.
ALTER TABLE "social_profile" ADD COLUMN IF NOT EXISTS "pinned_post_id" INTEGER;
ALTER TABLE "social_profile" ADD COLUMN IF NOT EXISTS "pinned_post_type" VARCHAR(20);
