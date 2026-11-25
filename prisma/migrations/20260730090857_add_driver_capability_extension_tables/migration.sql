-- CreateTable
CREATE TABLE "driver_delivery_profile" (
    "driver_profile_id" INTEGER NOT NULL,
    "vendor_type_id" INTEGER,
    "is_online" BOOLEAN,
    "current_lat" DOUBLE PRECISION,
    "current_long" DOUBLE PRECISION,

    CONSTRAINT "driver_delivery_profile_pkey" PRIMARY KEY ("driver_profile_id")
);

-- CreateTable
CREATE TABLE "driver_courier_profile" (
    "driver_profile_id" INTEGER NOT NULL,
    "display_name" TEXT,
    "price_per_km" DOUBLE PRECISION,

    CONSTRAINT "driver_courier_profile_pkey" PRIMARY KEY ("driver_profile_id")
);

-- AddForeignKey
ALTER TABLE "driver_delivery_profile" ADD CONSTRAINT "driver_delivery_profile_driver_profile_id_fkey" FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profile"("driver_profile_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_delivery_profile" ADD CONSTRAINT "driver_delivery_profile_vendor_type_id_fkey" FOREIGN KEY ("vendor_type_id") REFERENCES "vendor_type"("vendor_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_courier_profile" ADD CONSTRAINT "driver_courier_profile_driver_profile_id_fkey" FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profile"("driver_profile_id") ON DELETE CASCADE ON UPDATE NO ACTION;
