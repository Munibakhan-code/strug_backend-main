-- Friend Journal: highlights, bucket list, time capsules

CREATE TABLE IF NOT EXISTS "journal_highlight" (
    "id" SERIAL NOT NULL,
    "channel_id" INTEGER,
    "saved_by" INTEGER,
    "message_id" INTEGER,
    "content" TEXT,
    "content_type" VARCHAR(50),
    "media_url" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "journal_highlight_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_journal_highlight_channel" ON "journal_highlight"("channel_id");
CREATE INDEX IF NOT EXISTS "idx_journal_highlight_saved_by" ON "journal_highlight"("saved_by");
ALTER TABLE "journal_highlight" ADD CONSTRAINT "journal_highlight_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channel"("channel_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "journal_highlight" ADD CONSTRAINT "journal_highlight_saved_by_fkey" FOREIGN KEY ("saved_by") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE IF NOT EXISTS "journal_bucket_item" (
    "id" SERIAL NOT NULL,
    "channel_id" INTEGER,
    "created_by" INTEGER,
    "title" TEXT,
    "description" TEXT,
    "emoji" VARCHAR(10),
    "category" VARCHAR(50),
    "due_date" TIMESTAMP(6),
    "priority" VARCHAR(10) DEFAULT 'medium',
    "is_completed" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMP(6),
    "completed_by" INTEGER,
    "completion_note" TEXT,
    "completion_media" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    CONSTRAINT "journal_bucket_item_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_journal_bucket_channel" ON "journal_bucket_item"("channel_id");
ALTER TABLE "journal_bucket_item" ADD CONSTRAINT "journal_bucket_item_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channel"("channel_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE IF NOT EXISTS "journal_time_capsule" (
    "id" SERIAL NOT NULL,
    "channel_id" INTEGER,
    "created_by" INTEGER,
    "title" TEXT,
    "description" TEXT,
    "cover_url" TEXT,
    "unlock_date" TIMESTAMP(6) NOT NULL,
    "is_unlocked" BOOLEAN NOT NULL DEFAULT false,
    "contents" JSONB,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "journal_time_capsule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_journal_time_capsule_channel" ON "journal_time_capsule"("channel_id");
CREATE INDEX IF NOT EXISTS "idx_journal_time_capsule_unlock" ON "journal_time_capsule"("unlock_date");
ALTER TABLE "journal_time_capsule" ADD CONSTRAINT "journal_time_capsule_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channel"("channel_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
