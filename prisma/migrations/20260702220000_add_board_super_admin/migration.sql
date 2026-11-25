-- Super-admin tier for board_member: the most exclusive gate (the God Mode panel:
-- member management + invite-only onboarding). Independent of every other flag so
-- exclusivity is durable. Additive; default false.
ALTER TABLE "board_member" ADD COLUMN "is_super_admin" BOOLEAN NOT NULL DEFAULT false;

-- Backfill the three super-admins by EMAIL (not member_id): staging (Neon) and prod
-- (Azure) are separate databases whose ids don't line up, so match on the stable email.
UPDATE "board_member"
SET "is_super_admin" = true
WHERE "email" IN ('codezero@strug.ca', 'senudak@strug.ca', 'asmarafee@strug.ca');
