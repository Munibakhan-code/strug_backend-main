-- AlterTable
ALTER TABLE "food_vendor" ADD COLUMN "lat" DOUBLE PRECISION,
ADD COLUMN "long" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "store_profile" (
    "store_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "store_name" VARCHAR(255),
    "address" VARCHAR(1000),
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "prep_time" VARCHAR(255),
    "profile_pic_url" VARCHAR(1000),

    CONSTRAINT "store_profile_pkey" PRIMARY KEY ("store_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_profile_user_id_key" ON "store_profile"("user_id");

-- AddForeignKey
ALTER TABLE "store_profile" ADD CONSTRAINT "store_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
