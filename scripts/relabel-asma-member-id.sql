-- One-off: renumber asmarafee@strug.ca from member_id 29 to member_id 3.
--
-- Asma was recreated as #29 after the 07-11 board wipe (originally #4); this sets a
-- clean low id. board_member has NO declared FK relations — references (approved_by,
-- board_task.assignee_id/reviewer_id/assigner_id, board_notification.member_id) are
-- loose integers — so we update them defensively in the same transaction.
--
-- Guarded: aborts unless id 3 is free AND #29 is exactly asmarafee. Idempotent-ish
-- (safe to re-run only before it succeeds). Run via the relabel workflow (dryrun rolls back).
--
-- NOTE: asma's existing JWTs encode member_id 29 and will 401 after this — she must
-- re-login. is_super_admin (a column on the row) travels with the row, unaffected.

BEGIN;

DO $$
DECLARE
  asma_email text;
  id3_taken  int;
BEGIN
  SELECT email INTO asma_email FROM board_member WHERE member_id = 29;
  IF asma_email IS DISTINCT FROM 'asmarafee@strug.ca' THEN
    RAISE EXCEPTION 'member_id 29 is not asmarafee (got %), aborting', COALESCE(asma_email, '<none>');
  END IF;
  SELECT count(*) INTO id3_taken FROM board_member WHERE member_id = 3;
  IF id3_taken <> 0 THEN
    RAISE EXCEPTION 'member_id 3 is already taken, aborting';
  END IF;
END $$;

-- Defensively repoint any loose references (expected: none, asma is brand new).
UPDATE board_member    SET approved_by = 3 WHERE approved_by = 29;
UPDATE board_task      SET assignee_id = 3 WHERE assignee_id = 29;
UPDATE board_task      SET reviewer_id = 3 WHERE reviewer_id = 29;
UPDATE board_task      SET assigner_id = 3 WHERE assigner_id = 29;
UPDATE board_notification SET member_id = 3 WHERE member_id = 29;

-- The renumber itself.
UPDATE board_member SET member_id = 3 WHERE member_id = 29;

-- Verify the end state: asma is #3, approved, still super-admin; #29 is gone.
DO $$
DECLARE ok boolean;
BEGIN
  SELECT (member_id = 3 AND status = 'approved' AND is_super_admin)
    INTO ok FROM board_member WHERE email = 'asmarafee@strug.ca';
  IF NOT COALESCE(ok, false) THEN
    RAISE EXCEPTION 'post-check failed: asmarafee is not #3/approved/super after update';
  END IF;
  IF EXISTS (SELECT 1 FROM board_member WHERE member_id = 29) THEN
    RAISE EXCEPTION 'post-check failed: member_id 29 still exists';
  END IF;
END $$;

SELECT member_id, email, status, is_super_admin FROM board_member ORDER BY member_id;

COMMIT;
