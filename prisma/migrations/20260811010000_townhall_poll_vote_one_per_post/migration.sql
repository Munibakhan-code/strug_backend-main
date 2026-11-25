-- Enforce one Town Hall poll vote per user per post (closes concurrent double-vote race
-- across different options of the same poll).

ALTER TABLE "town_hall_poll_vote" ADD COLUMN IF NOT EXISTS "post_id" INTEGER;

UPDATE "town_hall_poll_vote" AS v
SET "post_id" = o."post_id"
FROM "town_hall_poll_option" AS o
WHERE v."option_id" = o."option_id"
  AND (v."post_id" IS NULL OR v."post_id" <> o."post_id");

-- Keep the earliest vote when a user somehow voted on multiple options of the same poll.
DELETE FROM "town_hall_poll_vote" AS a
USING "town_hall_poll_vote" AS b
WHERE a."post_id" = b."post_id"
  AND a."user_id" = b."user_id"
  AND a."vote_id" > b."vote_id";

-- Orphan rows (option gone) cannot satisfy NOT NULL / FK — drop them.
DELETE FROM "town_hall_poll_vote" WHERE "post_id" IS NULL;

ALTER TABLE "town_hall_poll_vote" ALTER COLUMN "post_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'town_hall_poll_vote_post_id_fkey'
  ) THEN
    ALTER TABLE "town_hall_poll_vote"
      ADD CONSTRAINT "town_hall_poll_vote_post_id_fkey"
      FOREIGN KEY ("post_id") REFERENCES "town_hall_post"("post_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "town_hall_poll_vote_post_id_user_id_key"
  ON "town_hall_poll_vote"("post_id", "user_id");

CREATE INDEX IF NOT EXISTS "town_hall_poll_vote_post_id_idx"
  ON "town_hall_poll_vote"("post_id");
