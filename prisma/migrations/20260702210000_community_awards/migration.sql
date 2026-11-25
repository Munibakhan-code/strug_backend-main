-- Community awards & karma (#267) — additive.

CREATE TABLE "community_award" (
    "award_id" SERIAL NOT NULL,
    "community_id" TEXT,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'star',
    "color" TEXT NOT NULL DEFAULT '#f59e0b',
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "community_award_pkey" PRIMARY KEY ("award_id")
);
CREATE INDEX "community_award_community_id_idx" ON "community_award"("community_id");
ALTER TABLE "community_award" ADD CONSTRAINT "community_award_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "community"("community_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "award_grant" (
    "grant_id" SERIAL NOT NULL,
    "award_id" INTEGER NOT NULL,
    "giver_id" INTEGER NOT NULL,
    "target_type" TEXT NOT NULL,
    "post_id" INTEGER,
    "comment_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "award_grant_pkey" PRIMARY KEY ("grant_id")
);
CREATE INDEX "award_grant_post_id_idx" ON "award_grant"("post_id");
CREATE INDEX "award_grant_comment_id_idx" ON "award_grant"("comment_id");
CREATE INDEX "award_grant_award_id_idx" ON "award_grant"("award_id");
ALTER TABLE "award_grant" ADD CONSTRAINT "award_grant_award_id_fkey"
    FOREIGN KEY ("award_id") REFERENCES "community_award"("award_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the platform-wide award set (community_id NULL). Icon keys are rendered as line-style SVG glyphs.
INSERT INTO "community_award" ("community_id", "name", "icon", "color") VALUES
    (NULL, 'Helpful',   'star',   '#f59e0b'),
    (NULL, 'Wholesome', 'heart',  '#ec4899'),
    (NULL, 'Insightful','gem',    '#8b5cf6'),
    (NULL, 'Rocket',    'rocket', '#2563eb'),
    (NULL, 'Gold',      'trophy', '#eab308');
