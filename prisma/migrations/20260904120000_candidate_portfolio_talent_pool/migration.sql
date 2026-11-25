-- Jobs Phase 4: seeker portfolio gallery + opt-in talent pool discoverability.
ALTER TABLE "candidate" ADD COLUMN IF NOT EXISTS "discoverable" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "candidate_portfolio_item" (
    "portfolio_item_id" SERIAL NOT NULL,
    "candidate_id" INTEGER NOT NULL,
    "title" TEXT,
    "url" TEXT NOT NULL,
    "media_type" VARCHAR(20),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_portfolio_item_pkey" PRIMARY KEY ("portfolio_item_id")
);

CREATE INDEX IF NOT EXISTS "candidate_portfolio_item_candidate_id_idx"
  ON "candidate_portfolio_item"("candidate_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'candidate_portfolio_item_candidate_id_fkey'
  ) THEN
    ALTER TABLE "candidate_portfolio_item"
      ADD CONSTRAINT "candidate_portfolio_item_candidate_id_fkey"
      FOREIGN KEY ("candidate_id") REFERENCES "candidate"("candidate_id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
