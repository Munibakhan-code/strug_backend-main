-- Add cover_url to projects (Raise campaigns) so an uploaded cover photo persists and renders on the user side.
-- AlterTable
ALTER TABLE "projects" ADD COLUMN "cover_url" TEXT;
