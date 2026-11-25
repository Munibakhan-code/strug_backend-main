-- Set is_creator = true on the persistent test account (identified by ref_code to avoid encryption)
UPDATE "user" SET "is_creator" = true WHERE "ref_code" = 'TEST-STRUG';
