-- Phase 5 mail hardening: suppression list + critical-mail outbox.

CREATE TABLE "mail_suppression" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "to_hash" VARCHAR(64) NOT NULL,
    "to_hint" VARCHAR(128),
    "reason" VARCHAR(32) NOT NULL,
    "source" VARCHAR(64),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" VARCHAR(500),

    CONSTRAINT "mail_suppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_suppression_to_hash_key" ON "mail_suppression"("to_hash");
CREATE INDEX "mail_suppression_active_created_at_idx" ON "mail_suppression"("active", "created_at");

CREATE TABLE "mail_outbox" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "to_hash" VARCHAR(64) NOT NULL,
    "to_hint" VARCHAR(128),
    "to_ciphertext" VARCHAR(2000) NOT NULL,
    "subject" VARCHAR(500) NOT NULL,
    "template" VARCHAR(100),
    "vertical" VARCHAR(64),
    "payload" JSONB NOT NULL,
    "last_error" VARCHAR(1000),
    "provider_message_id" VARCHAR(255),
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "mail_outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mail_outbox_status_next_attempt_at_idx" ON "mail_outbox"("status", "next_attempt_at");
CREATE INDEX "mail_outbox_to_hash_created_at_idx" ON "mail_outbox"("to_hash", "created_at");
CREATE INDEX "mail_outbox_template_created_at_idx" ON "mail_outbox"("template", "created_at");
