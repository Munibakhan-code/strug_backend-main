-- #428: seeded accounts advertised themselves through their referral code.
--
-- Seeded/demo accounts carry codes like 'DUMMY-ANDERSONCOOPER' and 'SEED7KW49T' instead of the
-- normal 'STRUG-XXXXXXXX'. That was harmless while the code was private — but #423 made the
-- referral code PUBLIC on every profile, so these now tell any visitor that @andersoncooper and
-- @therock are fake accounts. Give them real-looking codes.
--
-- Two hazards this handles:
--   1. user.ref_code is UNIQUE — the inner loop re-rolls until the candidate is free.
--   2. shared_ref_code.ref_code is a FOREIGN KEY onto it with ON UPDATE NO ACTION, so rewriting a
--      code that someone has actually shared would fail the whole migration. Those rows are
--      skipped with a notice rather than blowing up the deploy; a shared code is by definition
--      one a real person is using, and must not be silently changed underneath them.
--
-- Idempotent: re-running matches nothing, because the rewritten codes are 'STRUG-' prefixed.
DO $$
DECLARE
    r        RECORD;
    newcode  TEXT;
    changed  INT := 0;
    skipped  INT := 0;
BEGIN
    FOR r IN
        SELECT user_id, ref_code FROM "user"
        WHERE ref_code LIKE 'DUMMY-%' OR ref_code LIKE 'SEED%'
    LOOP
        IF EXISTS (SELECT 1 FROM shared_ref_code s WHERE s.ref_code = r.ref_code) THEN
            RAISE NOTICE 'skipping user % — ref_code % has been shared', r.user_id, r.ref_code;
            skipped := skipped + 1;
            CONTINUE;
        END IF;

        LOOP
            newcode := 'STRUG-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
            EXIT WHEN NOT EXISTS (SELECT 1 FROM "user" u WHERE u.ref_code = newcode);
        END LOOP;

        UPDATE "user" SET ref_code = newcode WHERE user_id = r.user_id;
        changed := changed + 1;
    END LOOP;

    RAISE NOTICE '#428: rewrote % seeded ref code(s); skipped % that had been shared', changed, skipped;
END
$$;
