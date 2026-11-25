-- AlterTable: comment vote score
ALTER TABLE "community_post_comment" ADD COLUMN IF NOT EXISTS "upvotes" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE IF NOT EXISTS "community_comment_vote" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "comment_id" INTEGER NOT NULL,
    "vote_type" INTEGER NOT NULL,

    CONSTRAINT "community_comment_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "community_post_save" (
    "user_id" INTEGER NOT NULL,
    "post_id" INTEGER NOT NULL,
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "community_comment_vote_user_id_comment_id_key" ON "community_comment_vote"("user_id", "comment_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "community_post_save_user_id_post_id_key" ON "community_post_save"("user_id", "post_id");

-- AddForeignKey
ALTER TABLE "community_comment_vote" ADD CONSTRAINT "community_comment_vote_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "community_post_comment"("comment_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_comment_vote" ADD CONSTRAINT "community_comment_vote_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_save" ADD CONSTRAINT "community_post_save_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "community_posts"("community_post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_save" ADD CONSTRAINT "community_post_save_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
