-- AlterTable
ALTER TABLE "staff_message" ADD COLUMN     "pinned" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "idx_staff_message_pinned" ON "staff_message"("channel_id", "pinned");
