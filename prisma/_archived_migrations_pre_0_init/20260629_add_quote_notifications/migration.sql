-- Insurance & Mortgage Quote Marketplace (M6) — additive, idempotent.
-- Persisted notifications for the quote vertical (mirrors work_notification).

CREATE TABLE IF NOT EXISTS "quote_notification" (
    "quote_notification_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "quote_request_id" INTEGER,
    "title" VARCHAR(160) NOT NULL,
    "body" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quote_notification_pkey" PRIMARY KEY ("quote_notification_id"),
    CONSTRAINT "quote_notification_user_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_quote_notification_user" ON "quote_notification"("user_id", "is_read", "created_at");
