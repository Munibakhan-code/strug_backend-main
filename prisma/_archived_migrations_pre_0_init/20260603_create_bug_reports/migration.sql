-- User-submitted bug reports + their screenshots.
-- Additive and idempotent (IF NOT EXISTS) so it is safe to run against a drifted
-- production database where tables may already exist.

CREATE TABLE IF NOT EXISTS "bug_report" (
    "bug_report_id" SERIAL PRIMARY KEY,
    "user_id"       INTEGER,
    "email"         VARCHAR(1000),
    "title"         VARCHAR(255) NOT NULL,
    "description"   TEXT NOT NULL,
    "category"      VARCHAR(50)  NOT NULL DEFAULT 'bug',
    "severity"      VARCHAR(20)  NOT NULL DEFAULT 'medium',
    "status"        VARCHAR(20)  NOT NULL DEFAULT 'open',
    "is_public"     BOOLEAN      NOT NULL DEFAULT false,
    "page_url"      VARCHAR(1000),
    "user_agent"    VARCHAR(1000),
    "admin_note"    TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bug_report_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_bug_report_status" ON "bug_report"("status");
CREATE INDEX IF NOT EXISTS "idx_bug_report_public" ON "bug_report"("is_public", "status");
CREATE INDEX IF NOT EXISTS "idx_bug_report_user"   ON "bug_report"("user_id");

CREATE TABLE IF NOT EXISTS "bug_report_screenshot" (
    "screenshot_id"  SERIAL PRIMARY KEY,
    "bug_report_id"  INTEGER NOT NULL,
    "screenshot_url" VARCHAR(1000) NOT NULL,
    "sequence_order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "bug_report_screenshot_report_fkey" FOREIGN KEY ("bug_report_id") REFERENCES "bug_report"("bug_report_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_bug_report_screenshot_report" ON "bug_report_screenshot"("bug_report_id");
