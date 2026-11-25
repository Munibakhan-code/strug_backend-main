-- Twitch-style paid livestream subscriptions (auto-renewing monthly via Stripe).
-- Additive only. Safe to apply manually via psql (IF NOT EXISTS guards) on drifted prod.

CREATE TABLE IF NOT EXISTS "live_subscription" (
    "subscription_id"        SERIAL       NOT NULL,
    "subscriber_user_id"     INTEGER      NOT NULL,
    "streamer_id"            INTEGER      NOT NULL,
    "stripe_subscription_id" TEXT,
    "stripe_customer_id"     TEXT,
    "stripe_price_id"        TEXT,
    "status"                 TEXT         NOT NULL DEFAULT 'incomplete',
    "current_period_end"     TIMESTAMP(3),
    "cancel_at_period_end"   BOOLEAN      NOT NULL DEFAULT false,
    "price_cents"            INTEGER,
    "currency"               TEXT         NOT NULL DEFAULT 'CAD',
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "live_subscription_pkey" PRIMARY KEY ("subscription_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "live_subscription_stripe_subscription_id_key"
    ON "live_subscription"("stripe_subscription_id");
CREATE UNIQUE INDEX IF NOT EXISTS "live_subscription_subscriber_user_id_streamer_id_key"
    ON "live_subscription"("subscriber_user_id", "streamer_id");
CREATE INDEX IF NOT EXISTS "live_subscription_streamer_id_idx"
    ON "live_subscription"("streamer_id");
CREATE INDEX IF NOT EXISTS "live_subscription_stripe_subscription_id_idx"
    ON "live_subscription"("stripe_subscription_id");

DO $$ BEGIN
    ALTER TABLE "live_subscription"
        ADD CONSTRAINT "live_subscription_streamer_id_fkey"
        FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "live_subscription"
        ADD CONSTRAINT "live_subscription_subscriber_user_id_fkey"
        FOREIGN KEY ("subscriber_user_id") REFERENCES "user"("user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "live_subscription_payment" (
    "payment_id"          SERIAL         NOT NULL,
    "stripe_invoice_id"   TEXT           NOT NULL,
    "subscription_id"     INTEGER,
    "streamer_id"         INTEGER        NOT NULL,
    "subscriber_user_id"  INTEGER,
    "amount_cents"        INTEGER        NOT NULL,
    "currency"            TEXT           NOT NULL DEFAULT 'CAD',
    "creator_share"       DECIMAL(12,2)  NOT NULL,
    "platform_share"      DECIMAL(12,2)  NOT NULL,
    "created_at"          TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "live_subscription_payment_pkey" PRIMARY KEY ("payment_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "live_subscription_payment_stripe_invoice_id_key"
    ON "live_subscription_payment"("stripe_invoice_id");
CREATE INDEX IF NOT EXISTS "live_subscription_payment_streamer_id_idx"
    ON "live_subscription_payment"("streamer_id");
