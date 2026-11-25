-- Single-use ad-view tokens (Redis-independent replay guard). See model used_ad_token.
-- Each ad_token carries a unique jti; ad-view-complete consumes it once inside the payout
-- transaction, so a replayed token aborts on this PK and cannot double-credit a creator.
CREATE TABLE IF NOT EXISTS "used_ad_token" (
    "jti" TEXT NOT NULL,
    "video_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "used_ad_token_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX IF NOT EXISTS "used_ad_token_used_at_idx" ON "used_ad_token"("used_at");
