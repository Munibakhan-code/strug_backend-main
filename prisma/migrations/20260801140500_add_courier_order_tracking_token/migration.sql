-- No-login shareable tracking link for courier order recipients.
ALTER TABLE "courier_order" ADD COLUMN "tracking_token" TEXT;
CREATE UNIQUE INDEX "courier_order_tracking_token_key" ON "courier_order"("tracking_token");
