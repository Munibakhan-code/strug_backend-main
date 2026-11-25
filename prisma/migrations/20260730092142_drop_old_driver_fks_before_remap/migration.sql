-- DropForeignKey
ALTER TABLE "courier_order" DROP CONSTRAINT "courier_order_courier_service_provider_id_fkey";

-- DropForeignKey
ALTER TABLE "food_order" DROP CONSTRAINT "food_order_driver_id_fkey";
