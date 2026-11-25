-- Threaded replies for community post comments.
-- Additive: adds a nullable self-referencing parent_id to community_post_comment.

ALTER TABLE "community_post_comment" ADD COLUMN IF NOT EXISTS "parent_id" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'community_post_comment_parent_id_fkey'
  ) THEN
    ALTER TABLE "community_post_comment"
      ADD CONSTRAINT "community_post_comment_parent_id_fkey"
      FOREIGN KEY ("parent_id") REFERENCES "community_post_comment"("comment_id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "community_post_comment_parent_id_idx"
  ON "community_post_comment"("parent_id");
