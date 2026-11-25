-- AlterTable
ALTER TABLE "worker_profile" ADD COLUMN     "reliability_score" INTEGER NOT NULL DEFAULT 100;

-- CreateTable
CREATE TABLE "reliability_audit" (
    "audit_id" SERIAL NOT NULL,
    "worker_profile_id" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "score_before" INTEGER NOT NULL,
    "score_after" INTEGER NOT NULL,
    "reason" VARCHAR(80) NOT NULL,
    "reference_type" VARCHAR(40),
    "reference_id" INTEGER,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reliability_audit_pkey" PRIMARY KEY ("audit_id")
);

-- CreateIndex
CREATE INDEX "idx_reliability_audit_worker" ON "reliability_audit"("worker_profile_id");

-- CreateIndex
CREATE INDEX "idx_reliability_audit_created" ON "reliability_audit"("created_at");

-- NOTE: 4 unrelated drift indexes (subscription_channel_id_created_at_idx,
-- video_title_idx, video_comments_video_id_created_at_idx,
-- video_likes_video_id_is_like_created_at_idx) were removed from this migration.
-- video_title_idx used `gin_trgm_ops`, but pg_trgm is NOT installed on prod Azure
-- Postgres, so `CREATE INDEX ... USING GIN (... gin_trgm_ops)` fails there and jams
-- every later migration (P3009). This is the same drift bundle already stripped from
-- 20260723105113_book_artist_schema_added for the same reason. These indexes are
-- unrelated to the reliability feature; omitting them keeps prod consistent with its
-- current state. The migration is already applied on staging (with the indexes), and
-- `migrate deploy` does not re-run applied migrations, so this edit is a no-op there.

-- AddForeignKey
ALTER TABLE "reliability_audit" ADD CONSTRAINT "reliability_audit_worker_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profile"("worker_profile_id") ON DELETE CASCADE ON UPDATE NO ACTION;
