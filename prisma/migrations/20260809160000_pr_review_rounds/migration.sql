-- PR review rounds: super-admin-only review board.
-- Workflow (status, reviewer, notes, audit, PR links) reuses board_task via
-- source_type='pr_review' + source_id=round_id. These tables add only the
-- round write-up and the per-PR review content board_task has nowhere to put.
-- Bare Int FKs to board_* match the existing board convention (no @relation),
-- except the detail -> round cascade, which we do want enforced.

CREATE TABLE IF NOT EXISTS "pr_review_round" (
    "round_id" SERIAL NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "summary" TEXT NOT NULL,
    "author_id" INTEGER,
    "reviewed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_review_round_pkey" PRIMARY KEY ("round_id")
);

CREATE INDEX IF NOT EXISTS "idx_pr_review_round_reviewed" ON "pr_review_round"("reviewed_at");

CREATE TABLE IF NOT EXISTS "pr_review_detail" (
    "detail_id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "round_id" INTEGER NOT NULL,
    "repo" VARCHAR(120),
    "pr_number" INTEGER,
    "pr_author" VARCHAR(120),
    "branch" VARCHAR(200),
    "verdict" VARCHAR(20),
    "tldr" TEXT,
    "plain_summary" TEXT NOT NULL,
    "technical_detail" TEXT,
    "before_text" TEXT,
    "after_text" TEXT,
    "before_code" TEXT,
    "after_code" TEXT,
    "code_lang" VARCHAR(30),
    "risk_note" TEXT,
    "risk_level" VARCHAR(10),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_review_detail_pkey" PRIMARY KEY ("detail_id")
);

-- One detail row per task: re-publishing a round upserts rather than duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS "pr_review_detail_task_id_key" ON "pr_review_detail"("task_id");
CREATE INDEX IF NOT EXISTS "idx_pr_review_detail_round" ON "pr_review_detail"("round_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pr_review_detail_round_id_fkey'
  ) THEN
    ALTER TABLE "pr_review_detail"
      ADD CONSTRAINT "pr_review_detail_round_id_fkey"
      FOREIGN KEY ("round_id") REFERENCES "pr_review_round"("round_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
