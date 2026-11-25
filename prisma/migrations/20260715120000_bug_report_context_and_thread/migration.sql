-- Bug report: auto-captured reporter context + reporter↔board thread.
--
-- Strictly additive: new nullable columns and one new table. No data is rewritten and no
-- existing column changes type, so this is safe to replay against prod (which has a history
-- of migrations marked-applied-without-running — see CLAUDE.md).
--
-- `status` gains a new allowed value 'awaiting_reporter'. It is a free VarChar with no CHECK
-- constraint, so no DDL is needed for that; the allow-list is enforced in the route layer.

-- Auto-captured context (client_context is board-only; it can contain console text).
ALTER TABLE "bug_report" ADD COLUMN IF NOT EXISTS "build_sha"      VARCHAR(40);
ALTER TABLE "bug_report" ADD COLUMN IF NOT EXISTS "viewport"       VARCHAR(24);
ALTER TABLE "bug_report" ADD COLUMN IF NOT EXISTS "device_type"    VARCHAR(12);
ALTER TABLE "bug_report" ADD COLUMN IF NOT EXISTS "nav_id"         VARCHAR(64);
ALTER TABLE "bug_report" ADD COLUMN IF NOT EXISTS "client_context" JSONB;

-- Reporter ↔ board conversation. Every row is visible to both sides (board-internal notes
-- stay in bug_report.admin_note), so there is no is_internal flag to get wrong.
CREATE TABLE IF NOT EXISTS "bug_report_message" (
    "message_id"       SERIAL       NOT NULL,
    "bug_report_id"    INTEGER      NOT NULL,
    "author_type"      VARCHAR(12)  NOT NULL,
    "author_member_id" INTEGER,
    "author_user_id"   INTEGER,
    "author_name"      VARCHAR(120),
    "body"             TEXT         NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bug_report_message_pkey" PRIMARY KEY ("message_id")
);

CREATE INDEX IF NOT EXISTS "idx_bug_report_message_report"
    ON "bug_report_message" ("bug_report_id", "created_at");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_report_message_report_fkey') THEN
        ALTER TABLE "bug_report_message"
            ADD CONSTRAINT "bug_report_message_report_fkey"
            FOREIGN KEY ("bug_report_id") REFERENCES "bug_report"("bug_report_id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
