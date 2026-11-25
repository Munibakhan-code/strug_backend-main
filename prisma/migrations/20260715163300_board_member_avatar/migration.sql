-- Self-serve staff profile picture (2026-07-15). Additive, nullable.
ALTER TABLE "board_member" ADD COLUMN "avatar_url" VARCHAR(1000);
