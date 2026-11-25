-- One-off (board request 2026-07-16): delete the QA artifact bug_report #466
-- ("Prod verify: context capture and follow-up thread", filed by our own test account)
-- and renumber #467 ("Messages" feature request) down to 466, so the ids stay contiguous.
--
-- Safe because #467 has NO child rows (bug_report_message / bug_report_screenshot), so the
-- primary-key move is a single-row UPDATE with no FK cascade to manage. Every mutation is
-- guarded: the transaction aborts unless the two rows are EXACTLY the expected titles, so a
-- re-run (or drifted data) can never renumber the wrong report.
--
-- Run under: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f this-file
-- ON_ERROR_STOP guarantees a failed guard aborts before COMMIT (server rolls the tx back).

BEGIN;

-- ── Guards ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT title FROM bug_report WHERE bug_report_id = 466)
       IS DISTINCT FROM 'Prod verify: context capture and follow-up thread' THEN
    RAISE EXCEPTION 'ABORT: bug_report #466 is not the expected QA artifact (got %)',
      COALESCE((SELECT title FROM bug_report WHERE bug_report_id = 466), '<missing>');
  END IF;
  IF (SELECT title FROM bug_report WHERE bug_report_id = 467)
       IS DISTINCT FROM 'Messages' THEN
    RAISE EXCEPTION 'ABORT: bug_report #467 is not the expected Messages ticket (got %)',
      COALESCE((SELECT title FROM bug_report WHERE bug_report_id = 467), '<missing>');
  END IF;
  IF EXISTS (SELECT 1 FROM bug_report_message    WHERE bug_report_id = 467)
     OR EXISTS (SELECT 1 FROM bug_report_screenshot WHERE bug_report_id = 467) THEN
    RAISE EXCEPTION 'ABORT: #467 unexpectedly has child rows; the PK move is unsafe';
  END IF;
END $$;

-- ── 1) Delete the QA artifact #466 (cascades its thread messages) ───────────
DELETE FROM bug_report WHERE bug_report_id = 466;

-- ── 2) Renumber #467 -> #466 (no children, so a plain PK update is safe) ─────
UPDATE bug_report SET bug_report_id = 466 WHERE bug_report_id = 467;

-- ── 3) Loose polymorphic task refs (no FK, so they never cascade) ───────────
UPDATE board_task SET source_id = 466 WHERE source_type = 'bug' AND source_id = 467;

-- ── 4) Notification deep-links (entity_type='bug_report'):
--        drop the deleted #466's now-orphaned rows FIRST, then move #467's down.
DELETE FROM notification WHERE entity_type = 'bug_report' AND entity_id = 466;
UPDATE notification SET entity_id = 466 WHERE entity_type = 'bug_report' AND entity_id = 467;

-- ── 5) Reset the id sequence so the next insert is 467, not 468 (stays contiguous)
SELECT setval(pg_get_serial_sequence('bug_report', 'bug_report_id'),
              (SELECT MAX(bug_report_id) FROM bug_report));

COMMIT;

-- ── Post-state (echoed into the workflow log) ───────────────────────────────
SELECT bug_report_id, title, status FROM bug_report
 WHERE bug_report_id IN (464, 465, 466, 467) ORDER BY bug_report_id;
SELECT MAX(bug_report_id) AS max_id, COUNT(*) AS total FROM bug_report;
