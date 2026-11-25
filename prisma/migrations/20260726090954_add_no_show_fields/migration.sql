-- AlterTable
ALTER TABLE "work_job" ADD COLUMN     "no_show_marked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "no_show_worker_id" INTEGER;
