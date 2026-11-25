-- One-off: bootstrap the first board super-admins.
--
-- The board_member API enforces "only a super-admin can grant super-admin"
-- (routes/board-members-routes.js) — a chicken-and-egg that can only be broken
-- with a direct DB write. This grants is_super_admin to the three bootstrap
-- accounts. Idempotent, transactional, and guarded: it aborts unless it ends
-- with exactly the three named rows flagged and all three approved.
--
-- Run via .github/workflows/grant-board-super-admin.yml (dryrun rolls back).

BEGIN;

UPDATE board_member
   SET is_super_admin = true
 WHERE email IN ('codezero@strug.ca', 'senudak@strug.ca', 'asmarafee@strug.ca')
   AND status = 'approved';

-- Guard: exactly the three intended accounts are now super-admins, no more, no less.
DO $$
DECLARE
  target_supers int;
  total_supers  int;
BEGIN
  SELECT count(*) INTO target_supers
    FROM board_member
   WHERE email IN ('codezero@strug.ca', 'senudak@strug.ca', 'asmarafee@strug.ca')
     AND is_super_admin = true
     AND status = 'approved';
  IF target_supers <> 3 THEN
    RAISE EXCEPTION 'Expected 3 flagged bootstrap accounts, found %', target_supers;
  END IF;

  SELECT count(*) INTO total_supers
    FROM board_member
   WHERE is_super_admin = true;
  IF total_supers <> 3 THEN
    RAISE EXCEPTION 'Expected exactly 3 super-admins total, found % (unexpected extra grants)', total_supers;
  END IF;
END $$;

-- Show the resulting super-admin roster in the run log.
SELECT member_id, email, status, is_super_admin, can_manage_members
  FROM board_member
 WHERE is_super_admin = true
 ORDER BY member_id;

COMMIT;
