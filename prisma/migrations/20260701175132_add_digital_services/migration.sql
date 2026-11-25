/*
  Warnings:

  - You are about to drop the column `category` on the `Gig` table. All the data in the column will be lost.
  - You are about to drop the column `subcategory` on the `Gig` table. All the data in the column will be lost.
  - You are about to drop the `Category` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SubCategory` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `Freelance_Category` to the `Gig` table without a default value. This is not possible if the table is not empty.
  - Added the required column `Freelance_SubCategory` to the `Gig` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "SubCategory" DROP CONSTRAINT "SubCategory_category_id_fkey";

-- AlterTable
ALTER TABLE "Gig" DROP COLUMN "category",
DROP COLUMN "subcategory",
ADD COLUMN     "Freelance_Category" VARCHAR(150) NOT NULL,
ADD COLUMN     "Freelance_SubCategory" VARCHAR(150) NOT NULL;

-- DropTable
DROP TABLE "Category";

-- DropTable
DROP TABLE "SubCategory";

-- CreateTable
CREATE TABLE "Freelance_Category" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "slug" VARCHAR(150) NOT NULL,
    "icon" TEXT,

    CONSTRAINT "Freelance_Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Freelance_SubCategory" (
    "id" SERIAL NOT NULL,
    "category_id" INTEGER NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "slug" VARCHAR(150) NOT NULL,

    CONSTRAINT "Freelance_SubCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Freelance_Category_slug_key" ON "Freelance_Category"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Freelance_SubCategory_slug_key" ON "Freelance_SubCategory"("slug");

-- CreateIndex
CREATE INDEX "Freelance_SubCategory_category_id_idx" ON "Freelance_SubCategory"("category_id");

-- AddForeignKey
ALTER TABLE "Freelance_SubCategory" ADD CONSTRAINT "Freelance_SubCategory_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "Freelance_Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
