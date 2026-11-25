-- Community moderation & safety (#264 / #268) — additive.

-- Post moderation flags
ALTER TABLE "community_posts" ADD COLUMN "is_removed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "community_posts" ADD COLUMN "is_locked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "community_posts" ADD COLUMN "removed_by" INTEGER;

-- Moderator roster
CREATE TABLE "community_moderator" (
    "id" SERIAL NOT NULL,
    "community_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY['all']::TEXT[],
    "added_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "community_moderator_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "community_moderator_community_id_user_id_key" ON "community_moderator"("community_id", "user_id");
CREATE INDEX "community_moderator_community_id_idx" ON "community_moderator"("community_id");
ALTER TABLE "community_moderator" ADD CONSTRAINT "community_moderator_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "community"("community_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bans / timeouts
CREATE TABLE "community_ban" (
    "id" SERIAL NOT NULL,
    "community_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "banned_by" INTEGER,
    "reason" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "community_ban_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "community_ban_community_id_user_id_key" ON "community_ban"("community_id", "user_id");
CREATE INDEX "community_ban_community_id_idx" ON "community_ban"("community_id");
ALTER TABLE "community_ban" ADD CONSTRAINT "community_ban_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "community"("community_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Community-scoped reports (mod queue)
CREATE TABLE "community_report" (
    "id" SERIAL NOT NULL,
    "community_id" TEXT NOT NULL,
    "reporter_id" INTEGER NOT NULL,
    "target_type" TEXT NOT NULL,
    "post_id" INTEGER,
    "comment_id" INTEGER,
    "target_user_id" INTEGER,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolved_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "community_report_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "community_report_community_id_status_idx" ON "community_report"("community_id", "status");
ALTER TABLE "community_report" ADD CONSTRAINT "community_report_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "community"("community_id") ON DELETE CASCADE ON UPDATE CASCADE;
