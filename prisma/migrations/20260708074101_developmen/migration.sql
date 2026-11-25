/*
  Warnings:

  - You are about to drop the `internal_campaign` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `social_account` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `social_post` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "social_post" DROP CONSTRAINT "social_post_account_id_fkey";

-- DropForeignKey
ALTER TABLE "social_post" DROP CONSTRAINT "social_post_campaign_id_fkey";

-- DropTable
DROP TABLE "internal_campaign";

-- DropTable
DROP TABLE "social_account";

-- DropTable
DROP TABLE "social_post";
