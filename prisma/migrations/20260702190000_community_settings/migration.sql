-- Community settings & post rules (#263) — additive.

-- Community-level post settings
ALTER TABLE "community" ADD COLUMN "allowed_post_types" TEXT[] NOT NULL DEFAULT ARRAY['text','link','image','poll']::TEXT[];
ALTER TABLE "community" ADD COLUMN "require_flair" BOOLEAN NOT NULL DEFAULT false;

-- Post-level: type, flair, spoiler / nsfw tags
ALTER TABLE "community_posts" ADD COLUMN "post_type" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "community_posts" ADD COLUMN "flair_id" INTEGER;
ALTER TABLE "community_posts" ADD COLUMN "is_spoiler" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "community_posts" ADD COLUMN "is_nsfw" BOOLEAN NOT NULL DEFAULT false;

-- Editable community rules
CREATE TABLE "community_rule" (
    "rule_id" SERIAL NOT NULL,
    "community_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "community_rule_pkey" PRIMARY KEY ("rule_id")
);
CREATE INDEX "community_rule_community_id_idx" ON "community_rule"("community_id");
ALTER TABLE "community_rule" ADD CONSTRAINT "community_rule_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "community"("community_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Community flair
CREATE TABLE "community_flair" (
    "flair_id" SERIAL NOT NULL,
    "community_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#2563eb',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "community_flair_pkey" PRIMARY KEY ("flair_id")
);
CREATE INDEX "community_flair_community_id_idx" ON "community_flair"("community_id");
ALTER TABLE "community_flair" ADD CONSTRAINT "community_flair_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "community"("community_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Post → flair FK
CREATE INDEX "community_posts_flair_id_idx" ON "community_posts"("flair_id");
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_flair_id_fkey"
    FOREIGN KEY ("flair_id") REFERENCES "community_flair"("flair_id") ON DELETE SET NULL ON UPDATE CASCADE;
