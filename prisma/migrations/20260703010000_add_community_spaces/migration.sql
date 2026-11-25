-- #334 Community Spaces: live group-audio rooms. Additive only (two new tables +
-- FKs + indexes); nothing existing is altered. Audio is peer-to-peer (WebRTC); only
-- room lifecycle + participant roles are persisted.

-- CreateTable
CREATE TABLE "community_space" (
    "id" SERIAL NOT NULL,
    "community_id" TEXT,
    "host_id" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'live',
    "started_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    CONSTRAINT "community_space_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_space_participant" (
    "id" SERIAL NOT NULL,
    "space_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'listener',
    "hand_raised" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(6),
    CONSTRAINT "community_space_participant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_community_space_status" ON "community_space"("status");

-- CreateIndex
CREATE INDEX "idx_community_space_community" ON "community_space"("community_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_space_participant" ON "community_space_participant"("space_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_space_participant_space" ON "community_space_participant"("space_id");

-- AddForeignKey
ALTER TABLE "community_space" ADD CONSTRAINT "community_space_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "community_space" ADD CONSTRAINT "community_space_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "community"("community_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "community_space_participant" ADD CONSTRAINT "community_space_participant_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "community_space"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "community_space_participant" ADD CONSTRAINT "community_space_participant_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;
