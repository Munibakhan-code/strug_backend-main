-- Phase 0.4: durable "notify me when this stream starts" opt-ins.
--
-- These previously lived only in the Redis set `live:sched:notify:<schedule_id>`. Prod has no
-- managed Redis, and utils/redis-client.js turns every command into a silent no-op there, so
-- the SADD stored nothing while the endpoint still answered `{ reminded: true }`, and the
-- later SMEMBERS read back an empty list. Every opt-in since launch was discarded.
--
-- Phase 0.3 also adds an index for the gift throttle's Postgres fallback, which filters on
-- (sender_user_id, created_at) and would otherwise sequentially scan the gift hot path.
--
-- Additive and idempotent: IF NOT EXISTS throughout, FKs dropped then re-added.

CREATE TABLE IF NOT EXISTS "live_schedule_reminder" (
    "id" SERIAL NOT NULL,
    "schedule_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "live_schedule_reminder_pkey" PRIMARY KEY ("id")
);

-- One opt-in per person per scheduled stream; the route upserts on this.
CREATE UNIQUE INDEX IF NOT EXISTS "live_schedule_reminder_schedule_id_user_id_key"
    ON "live_schedule_reminder"("schedule_id", "user_id");

-- The go-live fan-out reads exactly this: un-notified opt-ins for one schedule.
CREATE INDEX IF NOT EXISTS "live_schedule_reminder_schedule_id_notified_at_idx"
    ON "live_schedule_reminder"("schedule_id", "notified_at");

CREATE INDEX IF NOT EXISTS "live_schedule_reminder_user_id_idx"
    ON "live_schedule_reminder"("user_id");

ALTER TABLE "live_schedule_reminder" DROP CONSTRAINT IF EXISTS "live_schedule_reminder_schedule_id_fkey";
ALTER TABLE "live_schedule_reminder" ADD CONSTRAINT "live_schedule_reminder_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "live_stream_schedule"("schedule_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "live_schedule_reminder" DROP CONSTRAINT IF EXISTS "live_schedule_reminder_user_id_fkey";
ALTER TABLE "live_schedule_reminder" ADD CONSTRAINT "live_schedule_reminder_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 0.3: gift rate-limit fallback lookup.
CREATE INDEX IF NOT EXISTS "live_gift_sender_user_id_created_at_idx"
    ON "live_gift"("sender_user_id", "created_at");
