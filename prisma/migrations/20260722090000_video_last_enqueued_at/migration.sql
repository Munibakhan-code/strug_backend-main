-- Track when a video's transcode task was last PUSHED to the queue.
--
-- Distinct from last_attempt_at (when a worker last picked one UP). The reconciliation sweep needs
-- to tell "this video's enqueue was lost" apart from "this video's message is still waiting its turn
-- in a deep lane", and last_attempt_at cannot: both look like a stale/absent attempt.
--
-- The previous guard compared TOTAL lane depth against the outstanding count, which conflated
-- unrelated messages with coverage of the outstanding set. On 2026-07-22 a lane full of new-video
-- messages made the sweep skip re-queueing every cycle for hours while the stalled backlog grew
-- 74 -> 132. Per-video recency replaces that global heuristic.
--
-- Nullable with no backfill ON PURPOSE: NULL reads as "never enqueued (or not since this shipped)",
-- which makes the sweep treat the row as recoverable and re-queue it once. That is the safe
-- direction — the per-video debounce then stamps it, so it cannot amplify.
ALTER TABLE "video" ADD COLUMN "last_enqueued_at" TIMESTAMP(3);

-- Supports the sweep's ordering/filtering over outstanding rows.
CREATE INDEX "video_last_enqueued_at_idx" ON "video"("last_enqueued_at");
