-- CreateEnum
CREATE TYPE "TestDriveStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "test_drive_request" (
    "test_drive_request_id" SERIAL NOT NULL,
    "vehicle_id" INTEGER NOT NULL,
    "seller_id" INTEGER NOT NULL,
    "buyer_id" INTEGER NOT NULL,
    "preferred_date" TIMESTAMP(6) NOT NULL,
    "preferred_time" VARCHAR(50) NOT NULL,
    "full_name" VARCHAR(255) NOT NULL,
    "phone_number" VARCHAR(50) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "notes" TEXT,
    "status" "TestDriveStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_drive_request_pkey" PRIMARY KEY ("test_drive_request_id")
);

-- CreateIndex
CREATE INDEX "test_drive_request_vehicle_id_idx" ON "test_drive_request"("vehicle_id");

-- CreateIndex
CREATE INDEX "test_drive_request_seller_id_idx" ON "test_drive_request"("seller_id");

-- CreateIndex
CREATE INDEX "test_drive_request_buyer_id_idx" ON "test_drive_request"("buyer_id");

-- CreateIndex
CREATE INDEX "test_drive_request_status_idx" ON "test_drive_request"("status");

-- AddForeignKey
ALTER TABLE "test_drive_request" ADD CONSTRAINT "test_drive_request_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_drive_request" ADD CONSTRAINT "test_drive_request_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_drive_request" ADD CONSTRAINT "test_drive_request_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
