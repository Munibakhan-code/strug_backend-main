-- Video transcode pipeline lifecycle tracking.
-- Enables: (1) surfacing "processing"/"failed" state to creators, (2) a reconciliation
-- sweep that re-queues stalled/lost transcodes, (3) bounded retry + dead-lettering in
-- the standalone worker. `processing_status` is independent of `status` (which carries
-- visibility: safe/unlisted/banned) so none of the existing status='safe' feed filters change.
--
-- Additive + idempotent (IF NOT EXISTS) so it's safe against drifted environments
-- (the prod Azure DB has historically had migrations marked-applied-without-running).

ALTER TABLE "video" ADD COLUMN IF NOT EXISTS "processing_status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "video" ADD COLUMN IF NOT EXISTS "processing_error" VARCHAR(500);
ALTER TABLE "video" ADD COLUMN IF NOT EXISTS "processing_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "video" ADD COLUMN IF NOT EXISTS "last_attempt_at" TIMESTAMP(3);

-- Backfill existing rows: anything already streamable (has hls_url) is 'done'. Everything
-- else stays 'pending' so the reconciliation sweep evaluates it (and either re-queues it
-- or leaves it alone per the staleness/attempt guards).
UPDATE "video" SET "processing_status" = 'done'
WHERE "hls_url" IS NOT NULL AND "processing_status" = 'pending';

CREATE INDEX IF NOT EXISTS "video_processing_status_created_at_idx"
ON "video" ("processing_status", "created_at");
