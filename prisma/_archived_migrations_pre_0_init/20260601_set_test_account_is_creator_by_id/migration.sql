-- Set is_creator = true on test account (user_id = 1, confirmed from JWT)
UPDATE "user" SET "is_creator" = true WHERE "user_id" = 1;
