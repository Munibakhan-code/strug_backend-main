-- AlterTable
ALTER TABLE "food_order" ADD COLUMN     "batch_id" INTEGER;

-- AlterTable
ALTER TABLE "product_order" ADD COLUMN     "batch_id" INTEGER;

-- CreateTable
CREATE TABLE "delivery_batch" (
    "batch_id" SERIAL NOT NULL,
    "driver_profile_id" INTEGER NOT NULL,
    "vertical" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_batch_pkey" PRIMARY KEY ("batch_id")
);

-- AddForeignKey
ALTER TABLE "delivery_batch" ADD CONSTRAINT "delivery_batch_driver_profile_id_fkey" FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profile"("driver_profile_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_order" ADD CONSTRAINT "food_order_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "delivery_batch"("batch_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_order" ADD CONSTRAINT "product_order_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "delivery_batch"("batch_id") ON DELETE SET NULL ON UPDATE NO ACTION;
