-- AlterTable
ALTER TABLE "board_role" ADD COLUMN     "can_create_channels" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "board_notification" ADD COLUMN     "channel_id" INTEGER,
ADD COLUMN     "message_id" INTEGER;

-- CreateTable
CREATE TABLE "staff_channel" (
    "channel_id" SERIAL NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120),
    "dashboard_key" VARCHAR(60),
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "allowed_roles" JSONB,
    "created_by" INTEGER NOT NULL,
    "dm_key" VARCHAR(120),
    "archived_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_channel_pkey" PRIMARY KEY ("channel_id")
);

-- CreateTable
CREATE TABLE "staff_channel_member" (
    "id" SERIAL NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "member_id" INTEGER NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'member',
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "last_read_message_id" INTEGER,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "staff_channel_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_message" (
    "message_id" SERIAL NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "sender_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "content_type" VARCHAR(20) NOT NULL DEFAULT 'text',
    "parent_id" INTEGER,
    "metadata" JSONB,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_message_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_staff_channel_dm_key" ON "staff_channel"("dm_key");

-- CreateIndex
CREATE INDEX "idx_staff_channel_kind" ON "staff_channel"("kind");

-- CreateIndex
CREATE INDEX "idx_staff_channel_last_message" ON "staff_channel"("last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_staff_channel_team" ON "staff_channel"("kind", "dashboard_key");

-- CreateIndex
CREATE INDEX "idx_staff_channel_member_member" ON "staff_channel_member"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_staff_channel_member" ON "staff_channel_member"("channel_id", "member_id");

-- CreateIndex
CREATE INDEX "idx_staff_message_channel_created" ON "staff_message"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_staff_message_parent" ON "staff_message"("parent_id");

