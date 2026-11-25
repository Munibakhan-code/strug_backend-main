-- Recovery: full chat schema drift fix for staging (and any env where 20260602 /
-- 20260602_add_chat_lifecycle_fields were marked applied without running).
-- Idempotent (IF NOT EXISTS). No messages dropped.
--
-- Order matters:
--   1) All columns
--   2) Safe indexes (dm_key unique — all NULLs; non-unique context/last_message)
--   3) Consolidate duplicate context channels + duplicate participants
--   4) Unique indexes that would fail on duplicate data if run earlier

-- ── chat_channel: lifecycle + context + messaging ──
ALTER TABLE "chat_channel"
ADD COLUMN IF NOT EXISTS "context_type" VARCHAR(50),
ADD COLUMN IF NOT EXISTS "context_id" VARCHAR(255),
ADD COLUMN IF NOT EXISTS "created_by" INTEGER,
ADD COLUMN IF NOT EXISTS "last_message_at" TIMESTAMP(6),
ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) DEFAULT 'active',
ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(6),
ADD COLUMN IF NOT EXISTS "dm_key" VARCHAR(255);

-- ── chat_messages: edit / delete / media metadata ──
ALTER TABLE "chat_messages"
ADD COLUMN IF NOT EXISTS "edited_at" TIMESTAMP(6),
ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(6),
ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- ── chat_participants: lifecycle + read state ──
ALTER TABLE "chat_participants"
ADD COLUMN IF NOT EXISTS "joined_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "left_at" TIMESTAMP(6),
ADD COLUMN IF NOT EXISTS "muted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "last_read_message_id" INTEGER;

-- dm_key was just added (all NULL); NULLs are distinct in unique indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_channel_dm_key"
ON "chat_channel" ("dm_key");

CREATE INDEX IF NOT EXISTS "idx_chat_channel_context"
ON "chat_channel" ("context_type", "context_id");

CREATE INDEX IF NOT EXISTS "idx_chat_channel_last_message"
ON "chat_channel" ("last_message_at");

-- ── Consolidate duplicate context channels before enforcing uniqueness ──
-- Keep the lowest channel_id per (context_type, context_id), repoint messages/
-- participants onto it, then delete empty duplicate channels. DMs (NULL context)
-- are untouched.
UPDATE "chat_messages" m
SET "channel_id" = d.keep_id
FROM (
  SELECT "channel_id" AS dup_id,
         MIN("channel_id") OVER (PARTITION BY "context_type", "context_id") AS keep_id
  FROM "chat_channel"
  WHERE "context_type" IS NOT NULL AND "context_id" IS NOT NULL
) d
WHERE m."channel_id" = d.dup_id AND d.dup_id <> d.keep_id;

UPDATE "chat_participants" p
SET "channel_id" = d.keep_id
FROM (
  SELECT "channel_id" AS dup_id,
         MIN("channel_id") OVER (PARTITION BY "context_type", "context_id") AS keep_id
  FROM "chat_channel"
  WHERE "context_type" IS NOT NULL AND "context_id" IS NOT NULL
) d
WHERE p."channel_id" = d.dup_id AND d.dup_id <> d.keep_id;

DELETE FROM "chat_channel" c
USING (
  SELECT "channel_id" AS dup_id,
         MIN("channel_id") OVER (PARTITION BY "context_type", "context_id") AS keep_id
  FROM "chat_channel"
  WHERE "context_type" IS NOT NULL AND "context_id" IS NOT NULL
) d
WHERE c."channel_id" = d.dup_id AND d.dup_id <> d.keep_id;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_channel_context"
ON "chat_channel" ("context_type", "context_id");

CREATE INDEX IF NOT EXISTS "idx_chat_messages_channel_sent"
ON "chat_messages" ("channel_id", "sent_at");

CREATE INDEX IF NOT EXISTS "idx_chat_messages_sender_sent"
ON "chat_messages" ("sender_id", "sent_at");

-- Repointing can create duplicate (channel_id, user_id) rows — keep lowest id.
DELETE FROM "chat_participants" a
USING "chat_participants" b
WHERE a."chat_participant_id" > b."chat_participant_id"
  AND a."channel_id" = b."channel_id"
  AND a."user_id" = b."user_id";

CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_participants_channel_user"
ON "chat_participants" ("channel_id", "user_id");

CREATE INDEX IF NOT EXISTS "idx_chat_participants_user_channel"
ON "chat_participants" ("user_id", "channel_id");
