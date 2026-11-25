-- Mail Health send ledger (Phase 2). Recipients stored as hash + hint only.

CREATE TABLE "mail_send_log" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" VARCHAR(32) NOT NULL,
    "to_hash" VARCHAR(64) NOT NULL,
    "to_hint" VARCHAR(128),
    "subject" VARCHAR(500),
    "template" VARCHAR(100),
    "status" VARCHAR(32) NOT NULL,
    "provider_message_id" VARCHAR(255),
    "error" VARCHAR(1000),
    "vertical" VARCHAR(64),
    "tags" JSONB,

    CONSTRAINT "mail_send_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mail_send_log_created_at_idx" ON "mail_send_log"("created_at");
CREATE INDEX "mail_send_log_status_created_at_idx" ON "mail_send_log"("status", "created_at");
CREATE INDEX "mail_send_log_template_created_at_idx" ON "mail_send_log"("template", "created_at");
