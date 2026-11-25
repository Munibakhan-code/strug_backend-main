-- Live viewer coins + gifts (80/20 split to streamer wallet on send)

CREATE TABLE "live_coin_wallet" (
    "wallet_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "coin_balance" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_coin_wallet_pkey" PRIMARY KEY ("wallet_id")
);

CREATE UNIQUE INDEX "live_coin_wallet_user_id_key" ON "live_coin_wallet"("user_id");

ALTER TABLE "live_coin_wallet" ADD CONSTRAINT "live_coin_wallet_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "live_coin_purchase" (
    "purchase_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "pack_id" VARCHAR(50) NOT NULL,
    "coins" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "stripe_payment_intent_id" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_coin_purchase_pkey" PRIMARY KEY ("purchase_id")
);

CREATE UNIQUE INDEX "live_coin_purchase_stripe_payment_intent_id_key" ON "live_coin_purchase"("stripe_payment_intent_id");

ALTER TABLE "live_coin_purchase" ADD CONSTRAINT "live_coin_purchase_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "live_gift" (
    "gift_id" SERIAL NOT NULL,
    "sender_user_id" INTEGER NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "session_id" INTEGER,
    "gift_key" VARCHAR(50) NOT NULL,
    "coins" INTEGER NOT NULL,
    "fiat_cents" INTEGER NOT NULL,
    "creator_share" DECIMAL(12,4) NOT NULL,
    "platform_share" DECIMAL(12,4) NOT NULL,
    "message" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_gift_pkey" PRIMARY KEY ("gift_id")
);

CREATE INDEX "live_gift_streamer_id_idx" ON "live_gift"("streamer_id");
CREATE INDEX "live_gift_session_id_idx" ON "live_gift"("session_id");

ALTER TABLE "live_gift" ADD CONSTRAINT "live_gift_sender_user_id_fkey"
    FOREIGN KEY ("sender_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "live_gift" ADD CONSTRAINT "live_gift_streamer_id_fkey"
    FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
