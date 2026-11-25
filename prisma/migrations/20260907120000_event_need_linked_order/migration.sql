-- Shared Event (v1): a need can be fulfilled by a booking OR a food_order.
-- linked_order_kind disambiguates which table linked_order_id references.
ALTER TABLE "event_need" ADD COLUMN IF NOT EXISTS "linked_order_id" INTEGER;
ALTER TABLE "event_need" ADD COLUMN IF NOT EXISTS "linked_order_kind" VARCHAR(20);
