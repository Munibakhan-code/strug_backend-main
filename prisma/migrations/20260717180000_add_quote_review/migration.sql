-- Additive: quote_review for post-deal requester ratings of quote providers.
-- Mirrors work_review shape; aggregates into quote_provider.rating.
-- Idempotent guards so staging DBs that already received the table via db push stay safe.

CREATE TABLE IF NOT EXISTS "quote_review" (
    "quote_review_id"  SERIAL NOT NULL,
    "quote_request_id" INTEGER NOT NULL,
    "quote_id"         INTEGER,
    "provider_id"      INTEGER NOT NULL,
    "reviewer_id"      INTEGER,
    "rating"           DOUBLE PRECISION,
    "comment"          TEXT,
    "created_at"       TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_review_pkey" PRIMARY KEY ("quote_review_id")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'quote_review_request_fkey'
    ) THEN
        ALTER TABLE "quote_review"
            ADD CONSTRAINT "quote_review_request_fkey"
            FOREIGN KEY ("quote_request_id") REFERENCES "quote_request"("quote_request_id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'quote_review_quote_fkey'
    ) THEN
        ALTER TABLE "quote_review"
            ADD CONSTRAINT "quote_review_quote_fkey"
            FOREIGN KEY ("quote_id") REFERENCES "quote"("quote_id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'quote_review_provider_fkey'
    ) THEN
        ALTER TABLE "quote_review"
            ADD CONSTRAINT "quote_review_provider_fkey"
            FOREIGN KEY ("provider_id") REFERENCES "quote_provider"("quote_provider_id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'quote_review_reviewer_fkey'
    ) THEN
        ALTER TABLE "quote_review"
            ADD CONSTRAINT "quote_review_reviewer_fkey"
            FOREIGN KEY ("reviewer_id") REFERENCES "user"("user_id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_quote_review_request_reviewer'
    ) THEN
        -- A UNIQUE constraint creates a backing index of the same name. A prior partial/failed
        -- apply can leave that index (a relation) WITHOUT the constraint being registered in
        -- pg_constraint, so the guard above passes but ADD CONSTRAINT then fails with 42P07
        -- "relation already exists" (the staging P3018 jam). Drop any orphan index first.
        DROP INDEX IF EXISTS "uq_quote_review_request_reviewer";
        ALTER TABLE "quote_review"
            ADD CONSTRAINT "uq_quote_review_request_reviewer"
            UNIQUE ("quote_request_id", "reviewer_id");
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_quote_review_provider" ON "quote_review"("provider_id");
CREATE INDEX IF NOT EXISTS "idx_quote_review_reviewer" ON "quote_review"("reviewer_id");
