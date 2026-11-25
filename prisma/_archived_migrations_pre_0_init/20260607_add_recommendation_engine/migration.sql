-- CreateTable
CREATE TABLE "user_interest_profile" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "interests" JSONB NOT NULL DEFAULT '{}',
    "top_tokens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "top_creators" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "signal_count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_interest_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_impression" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "content_type" VARCHAR(10) NOT NULL,
    "content_id" INTEGER NOT NULL,
    "dwell_ms" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 1,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "source" VARCHAR(20),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_impression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trending_topic" (
    "id" SERIAL NOT NULL,
    "token" VARCHAR(80) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "window_days" INTEGER NOT NULL DEFAULT 3,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trending_topic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_interest_profile_profile_id_key" ON "user_interest_profile"("profile_id");

-- CreateIndex
CREATE INDEX "user_interest_profile_profile_id_idx" ON "user_interest_profile"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_impression_profile_id_content_type_content_id_key" ON "content_impression"("profile_id", "content_type", "content_id");

-- CreateIndex
CREATE INDEX "content_impression_profile_id_idx" ON "content_impression"("profile_id");

-- CreateIndex
CREATE INDEX "content_impression_profile_id_content_type_idx" ON "content_impression"("profile_id", "content_type");

-- CreateIndex
CREATE UNIQUE INDEX "trending_topic_token_key" ON "trending_topic"("token");

-- CreateIndex
CREATE INDEX "trending_topic_score_idx" ON "trending_topic"("score");
