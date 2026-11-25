-- Payout Triggers: append-only audit trail for board-initiated payout write-actions
-- (approve / reject / mark-paid) from the Finance dashboard.
CREATE TABLE "payout_audit" (
    "audit_id" SERIAL NOT NULL,
    "payout_id" INTEGER NOT NULL,
    "actor_member_id" INTEGER,
    "actor_name" VARCHAR(255),
    "action" VARCHAR(24) NOT NULL,
    "from_status" VARCHAR(16),
    "to_status" VARCHAR(16) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "stripe_transfer_id" VARCHAR(80),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_audit_pkey" PRIMARY KEY ("audit_id")
);

CREATE INDEX "payout_audit_payout_id_idx" ON "payout_audit"("payout_id");
CREATE INDEX "payout_audit_created_at_idx" ON "payout_audit"("created_at");
