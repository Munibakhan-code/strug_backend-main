-- Chat messaging fields + indexes.
-- This migration includes a one-time data consolidation step BEFORE the UNIQUE
-- indexes so it is safe to apply to environments that may already contain
-- duplicate context channels or duplicate channel participants. This matters
-- because prod migration history is drifted (migrations are marked applied
-- without having run), so a bare `CREATE UNIQUE INDEX` against legacy data
-- could fail mid-migration and leave the DB inconsistent. No messages are
-- dropped — child rows are repointed onto the surviving channel.

ALTER TABLE "chat_channel"
ADD COLUMN IF NOT EXISTS "dm_key" VARCHAR(255);

ALTER TABLE "chat_messages"
ADD COLUMN IF NOT EXISTS "edited_at" TIMESTAMP(6),
ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(6),
ADD COLUMN IF NOT EXISTS "metadata" JSONB;

ALTER TABLE "chat_participants"
ADD COLUMN IF NOT EXISTS "muted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "last_read_message_id" INTEGER;

-- dm_key was just added (all NULL); NULLs are distinct, so this is always safe.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_channel_dm_key"
ON "chat_channel" ("dm_key");

CREATE INDEX IF NOT EXISTS "idx_chat_channel_context"
ON "chat_channel" ("context_type", "context_id");

CREATE INDEX IF NOT EXISTS "idx_chat_channel_last_message"
ON "chat_channel" ("last_message_at");

-- ── Consolidate duplicate context channels before enforcing uniqueness ──
-- Keep the lowest channel_id per (context_type, context_id), repoint all of the
-- duplicates' messages/participants onto it, then delete the now-empty
-- duplicate channels. Only runs where both context columns are non-NULL, since
-- a NULL in either column makes the tuple distinct in the unique index (so
-- NULL-context channels, e.g. DMs, never collide and are left untouched).
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

-- ── Remove duplicate participants before enforcing uniqueness ──
-- The repointing above can also produce duplicate (channel_id, user_id) rows.
-- Keep the lowest chat_participant_id per pair. The `=` comparisons exclude
-- NULLs, matching the unique index semantics (NULLs are distinct).
DELETE FROM "chat_participants" a
USING "chat_participants" b
WHERE a."chat_participant_id" > b."chat_participant_id"
  AND a."channel_id" = b."channel_id"
  AND a."user_id" = b."user_id";

CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_participants_channel_user"
ON "chat_participants" ("channel_id", "user_id");

CREATE INDEX IF NOT EXISTS "idx_chat_participants_user_channel"
ON "chat_participants" ("user_id", "channel_id");
