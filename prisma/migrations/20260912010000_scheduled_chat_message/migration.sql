-- Server-backed scheduled chat messages (delivered by scheduled-chat cron).
CREATE TABLE "scheduled_chat_message" (
    "scheduled_message_id" SERIAL NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "sender_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "content_type" VARCHAR(255) NOT NULL DEFAULT 'text',
    "metadata" JSONB,
    "client_msg_id" VARCHAR(100),
    "scheduled_for" TIMESTAMP(6) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_message_id" INTEGER,
    "error_message" TEXT,
    "claimed_at" TIMESTAMP(6),
    "sent_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_chat_message_pkey" PRIMARY KEY ("scheduled_message_id")
);

CREATE INDEX "idx_scheduled_chat_due" ON "scheduled_chat_message"("status", "scheduled_for");
CREATE INDEX "idx_scheduled_chat_sender" ON "scheduled_chat_message"("sender_id", "status");
CREATE INDEX "idx_scheduled_chat_channel" ON "scheduled_chat_message"("channel_id", "status");
CREATE INDEX "idx_scheduled_chat_client_msg" ON "scheduled_chat_message"("sender_id", "client_msg_id");

ALTER TABLE "scheduled_chat_message" ADD CONSTRAINT "scheduled_chat_message_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channel"("channel_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "scheduled_chat_message" ADD CONSTRAINT "scheduled_chat_message_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
