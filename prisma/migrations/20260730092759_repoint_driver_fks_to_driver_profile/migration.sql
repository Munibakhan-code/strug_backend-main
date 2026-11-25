-- AddForeignKey
ALTER TABLE "courier_order" ADD CONSTRAINT "courier_order_courier_service_provider_id_fkey" FOREIGN KEY ("courier_service_provider_id") REFERENCES "driver_profile"("driver_profile_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_order" ADD CONSTRAINT "food_order_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver_profile"("driver_profile_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_order" ADD CONSTRAINT "product_order_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver_profile"("driver_profile_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
