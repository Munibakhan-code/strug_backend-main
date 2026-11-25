-- Recruiter-initiated invites (consent-preserving recruiter revenue-share).
-- A recruiter invites a user by username; the invited user must accept before a
-- shared_ref_code link is created. Additive, idempotent.

CREATE TABLE IF NOT EXISTS "recruit_invite" (
  "invite_id"         SERIAL       NOT NULL,
  "recruiter_user_id" INTEGER      NOT NULL,
  "invited_user_id"   INTEGER      NOT NULL,
  "ref_code"          VARCHAR(1000) NOT NULL,
  "status"            VARCHAR(12)  NOT NULL DEFAULT 'pending',
  "created_at"        TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  "responded_at"      TIMESTAMP(6),
  CONSTRAINT "recruit_invite_pkey" PRIMARY KEY ("invite_id")
);

-- One invite row per (recruiter, invited) pair; re-inviting resets the existing row.
CREATE UNIQUE INDEX IF NOT EXISTS "recruit_invite_recruiter_user_id_invited_user_id_key"
  ON "recruit_invite" ("recruiter_user_id", "invited_user_id");

-- Fast lookup of a user's pending incoming invites.
CREATE INDEX IF NOT EXISTS "recruit_invite_invited_user_id_status_idx"
  ON "recruit_invite" ("invited_user_id", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recruit_invite_recruiter_user_id_fkey'
  ) THEN
    ALTER TABLE "recruit_invite"
      ADD CONSTRAINT "recruit_invite_recruiter_user_id_fkey"
      FOREIGN KEY ("recruiter_user_id") REFERENCES "user"("user_id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recruit_invite_invited_user_id_fkey'
  ) THEN
    ALTER TABLE "recruit_invite"
      ADD CONSTRAINT "recruit_invite_invited_user_id_fkey"
      FOREIGN KEY ("invited_user_id") REFERENCES "user"("user_id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
