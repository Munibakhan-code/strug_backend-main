-- On-Demand Work notifications log (M8). Additive + idempotent.
CREATE TABLE IF NOT EXISTS "work_notification" (
    "work_notification_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "work_job_id" INTEGER,
    "title" VARCHAR(160) NOT NULL,
    "body" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "work_notification_pkey" PRIMARY KEY ("work_notification_id"),
    CONSTRAINT "work_notification_user_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_work_notification_user" ON "work_notification"("user_id", "is_read", "created_at");
