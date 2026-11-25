-- One-off: remove the fixture seeded on 2026-07-13 to verify board tickets #410/#407 on prod.
-- Everything created was tagged '[verify-seed]'. The posts were already deleted through the API;
-- the social_profile could not be, because no delete endpoint exists for it.
--
-- Scoped on purpose: only the profile whose handle is exactly 'verifyseed', and only if it belongs
-- to test@strug.ca. Never a blanket delete.
BEGIN;

-- Guard: refuse to run if this does not match exactly the one row we expect.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM social_profile sp
    JOIN "user" u ON u.user_id = sp.user_id
   WHERE sp.handle = 'verifyseed';
  IF n <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 @verifyseed profile, found %. Aborting.', n;
  END IF;
END $$;

-- Real user posts live in social_feed. `social_post` is an UNRELATED campaign/marketing table
-- (title / account_id / campaign_id) with no caption_text at all — the dry run caught this as
-- 'column "caption_text" does not exist' before anything was deleted.
-- social_feed.profile_id is ON DELETE CASCADE, so dropping the profile would take its posts with
-- it anyway; delete them explicitly so the counts below actually prove the fixture is gone.
DELETE FROM social_feed
 WHERE caption_text LIKE '[verify-seed]%'
   AND profile_id IN (SELECT profile_id FROM social_profile WHERE handle = 'verifyseed');

DELETE FROM social_profile WHERE handle = 'verifyseed';

SELECT (SELECT count(*) FROM social_profile WHERE handle = 'verifyseed')            AS profiles_left,
       (SELECT count(*) FROM social_feed WHERE caption_text LIKE '[verify-seed]%')  AS seed_posts_left;

COMMIT;
