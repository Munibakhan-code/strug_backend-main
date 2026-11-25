-- Internal Task Board (strug.ca/board). See task-board-implementation-plan.md.
--
-- Additive and idempotent (IF NOT EXISTS) so it is safe to re-run and safe against a
-- drifted production database. Mirrors the house migration style (bug_report etc.).
--
-- A dedicated `board_member` table for internal dev staff, deliberately separate from
-- the app `user` table and the bare `admin` table.

-- ---- members --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "board_member" (
    "member_id"          SERIAL PRIMARY KEY,
    "name"               VARCHAR(255) NOT NULL,
    "email"              VARCHAR(255) NOT NULL,
    "password"           VARCHAR(2000) NOT NULL,
    "status"             VARCHAR(20)  NOT NULL DEFAULT 'pending',
    "can_assign"         BOOLEAN      NOT NULL DEFAULT false,
    "can_review"         BOOLEAN      NOT NULL DEFAULT false,
    "can_manage_members" BOOLEAN      NOT NULL DEFAULT false,
    "approved_by"        INTEGER,
    "approved_at"        TIMESTAMP(3),
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "board_member_email_key" ON "board_member"("email");
CREATE INDEX IF NOT EXISTS "idx_board_member_status" ON "board_member"("status");

-- ---- tasks ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "board_task" (
    "task_id"       SERIAL PRIMARY KEY,
    "title"         VARCHAR(255) NOT NULL,
    "description"   TEXT NOT NULL,
    "status"        VARCHAR(30)  NOT NULL DEFAULT 'backlog',
    "assigner_id"   INTEGER NOT NULL,
    "assignee_id"   INTEGER,
    "reviewer_id"   INTEGER,
    "priority"      VARCHAR(20)  NOT NULL DEFAULT 'medium',
    "vertical"      VARCHAR(80),
    "deadline"      TIMESTAMP(3),
    "doc_links"     JSONB,
    "review_notes"  TEXT,
    "source_type"   VARCHAR(30),
    "source_id"     INTEGER,
    "reopened_from" INTEGER,
    "ready_at"      TIMESTAMP(3),
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at"   TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "idx_board_task_status"    ON "board_task"("status");
CREATE INDEX IF NOT EXISTS "idx_board_task_assignee"  ON "board_task"("assignee_id");
CREATE INDEX IF NOT EXISTS "idx_board_task_reviewer"  ON "board_task"("reviewer_id");

-- ---- subtasks -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "board_subtask" (
    "subtask_id" SERIAL PRIMARY KEY,
    "task_id"    INTEGER NOT NULL,
    "label"      VARCHAR(255) NOT NULL,
    "is_done"    BOOLEAN NOT NULL DEFAULT false,
    "pr_link"    VARCHAR(500),
    "position"   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "idx_board_subtask_task" ON "board_subtask"("task_id");

-- ---- pr links -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "board_pr_link" (
    "pr_link_id" SERIAL PRIMARY KEY,
    "task_id"    INTEGER NOT NULL,
    "url"        VARCHAR(500) NOT NULL,
    "repo"       VARCHAR(120),
    "merged"     BOOLEAN NOT NULL DEFAULT false,
    "merged_at"  TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "idx_board_pr_link_task" ON "board_pr_link"("task_id");

-- ---- comments -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "board_comment" (
    "comment_id" SERIAL PRIMARY KEY,
    "task_id"    INTEGER NOT NULL,
    "author_id"  INTEGER NOT NULL,
    "body"       TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_board_comment_task" ON "board_comment"("task_id");

-- ---- notifications --------------------------------------------------------
CREATE TABLE IF NOT EXISTS "board_notification" (
    "notification_id" SERIAL PRIMARY KEY,
    "member_id"       INTEGER NOT NULL,
    "task_id"         INTEGER,
    "type"            VARCHAR(40) NOT NULL,
    "body"            VARCHAR(500) NOT NULL,
    "is_read"         BOOLEAN NOT NULL DEFAULT false,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_board_notification_member" ON "board_notification"("member_id", "is_read");

-- ---- activity log ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS "board_activity" (
    "activity_id" SERIAL PRIMARY KEY,
    "task_id"     INTEGER NOT NULL,
    "actor_id"    INTEGER,
    "action"      VARCHAR(120) NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_board_activity_task" ON "board_activity"("task_id");
