-- DropForeignKey
ALTER TABLE "courier_service_provider" DROP CONSTRAINT "courier_service_provider_courier_service_provider_user_id_fkey";

-- DropForeignKey
ALTER TABLE "delivery_driver" DROP CONSTRAINT "delivery_driver_user_id_fkey";

-- DropForeignKey
ALTER TABLE "delivery_driver" DROP CONSTRAINT "delivery_driver_vendor_type_id_fkey";

-- DropTable
DROP TABLE "courier_service_provider";

-- DropTable
DROP TABLE "delivery_driver";
