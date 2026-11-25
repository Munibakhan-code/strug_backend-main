CREATE TABLE IF NOT EXISTS "video_comment_likes" (
    "id"         SERIAL PRIMARY KEY,
    "comment_id" INTEGER NOT NULL,
    "user_id"    INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "video_comment_likes_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "video_comments"("comment_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "video_comment_likes_user_id_fkey"    FOREIGN KEY ("user_id")    REFERENCES "user"("user_id")            ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "video_comment_likes_user_id_comment_id_key"
    ON "video_comment_likes"("user_id", "comment_id");
