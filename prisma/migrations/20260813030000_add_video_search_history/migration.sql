-- Video discovery: record what people search for, and how many results they got.
-- Additive only. Nothing existing is altered, so this is safe to apply to a live database.
CREATE TABLE IF NOT EXISTS "video_search_history" (
    "search_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "query" VARCHAR(255) NOT NULL,
    "result_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_search_history_pkey" PRIMARY KEY ("search_id")
);

CREATE INDEX IF NOT EXISTS "video_search_history_user_id_created_at_idx" ON "video_search_history"("user_id", "created_at");

-- Powers the "searched for, found nothing" report.
CREATE INDEX IF NOT EXISTS "video_search_history_result_count_created_at_idx" ON "video_search_history"("result_count", "created_at");

ALTER TABLE "video_search_history" ADD CONSTRAINT "video_search_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
