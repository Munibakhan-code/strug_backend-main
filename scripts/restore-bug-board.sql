-- Strug board restore: recover tickets lost in the 2026-07-11 factory reset.
-- 1) shift the 11 post-reset tickets to 401-411  2) insert the 400 recovered/placeholder tickets  3) fix the sequence
-- All inserted rows land as status='open' pending regression re-verification.
BEGIN;

-- guard: abort unless the board is in the expected post-reset state (exactly the 11 new tickets, ids <= 11)
DO $$
DECLARE n int; mx int;
BEGIN
  SELECT count(*), coalesce(max(bug_report_id),0) INTO n, mx FROM bug_report;
  IF n <> 11 OR mx > 11 THEN
    RAISE EXCEPTION 'Unexpected board state: % rows, max id % (expected 11 rows, max id 11). Aborting.', n, mx;
  END IF;
END $$;

-- 1) shift current #1-#11 -> #401-#411 (FK on screenshots is not ON UPDATE CASCADE, so drop/re-add)
DO $$
DECLARE fk text;
BEGIN
  SELECT conname INTO fk FROM pg_constraint
   WHERE conrelid = 'bug_report_screenshot'::regclass AND contype = 'f';
  EXECUTE format('ALTER TABLE bug_report_screenshot DROP CONSTRAINT %I', fk);
  UPDATE bug_report            SET bug_report_id = bug_report_id + 400 WHERE bug_report_id <= 11;
  UPDATE bug_report_screenshot SET bug_report_id = bug_report_id + 400 WHERE bug_report_id <= 11;
  EXECUTE format('ALTER TABLE bug_report_screenshot ADD CONSTRAINT %I FOREIGN KEY (bug_report_id) REFERENCES bug_report(bug_report_id) ON DELETE CASCADE', fk);
END $$;

UPDATE bug_report
   SET admin_note = coalesce(admin_note || ' | ', '') || 'Renumbered ' || (bug_report_id - 400) || ' -> ' || bug_report_id || ' on 2026-07-12 to free the original 1-400 range for the restore.'
 WHERE bug_report_id BETWEEN 401 AND 411;

-- 2) restore the recovered tickets (user_id NULL: the reset wiped the users these pointed at)
INSERT INTO bug_report
  (bug_report_id, user_id, email, title, description, category, severity, status, is_public, page_url, user_agent, admin_note, created_at, updated_at)
VALUES
  (1, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (2, NULL, NULL, '[reconstructed] Merge #1059: board fixes #9/#2/#7', 'RECONSTRUCTED from git history — original report text lost in the 2026-07-11 factory reset.

Only the fix commit subject survives:
Merge #1059: board fixes #9/#2/#7', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit subject (2026-07-12); detail unrecoverable. Reopened for regression re-verification.', '2026-07-12T12:00:00'::timestamp, now()),
  (3, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (4, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (5, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (6, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (7, NULL, NULL, '[reconstructed] Merge #1059: board fixes #9/#2/#7', 'RECONSTRUCTED from git history — original report text lost in the 2026-07-11 factory reset.

Only the fix commit subject survives:
Merge #1059: board fixes #9/#2/#7', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit subject (2026-07-12); detail unrecoverable. Reopened for regression re-verification.', '2026-07-12T12:00:00'::timestamp, now()),
  (8, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (9, NULL, NULL, '[reconstructed] Merge #1059: board fixes #9/#2/#7', 'RECONSTRUCTED from git history — original report text lost in the 2026-07-11 factory reset.

Only the fix commit subject survives:
Merge #1059: board fixes #9/#2/#7', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit subject (2026-07-12); detail unrecoverable. Reopened for regression re-verification.', '2026-07-12T12:00:00'::timestamp, now()),
  (10, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (11, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (12, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (13, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (14, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (15, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (16, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (17, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (18, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (19, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (20, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (21, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (22, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (23, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (24, NULL, NULL, '[reconstructed] video page header collapses on mobile scroll-down, like the ', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
video page header collapses on mobile scroll-down, like the social feed', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 7f835bed (2026-06-07). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-07T12:00:00'::timestamp, now()),
  (25, NULL, NULL, '[reconstructed] mobile mini-player keeps the video playing in a fixed corner', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
mobile mini-player keeps the video playing in a fixed corner when scrolling', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 7f835bed (2026-06-07). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-07T12:00:00'::timestamp, now()),
  (26, NULL, NULL, '[reconstructed] bio is loaded from the social profile (its save target) and ', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
bio is loaded from the social profile (its save target) and no longer wiped when saving without retyping', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 7f835bed (2026-06-07). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-07T12:00:00'::timestamp, now()),
  (27, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (28, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (29, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (30, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (31, NULL, NULL, '[reconstructed] critical): photoless profiles no longer show the viewer''s av', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
critical): photoless profiles no longer show the viewer''s avatar; comment input uses the logged-in user''s avatar, not the viewed profile''s', 'bug', 'critical', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 7f835bed (2026-06-07). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-07T12:00:00'::timestamp, now()),
  (32, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (33, NULL, NULL, '[reconstructed] video thumbnails render via valid backgroundImage CSS in pla', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
video thumbnails render via valid backgroundImage CSS in playlist/liked/watch-later views (were raw URLs / invalid shorthand', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 7f835bed (2026-06-07). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-07T12:00:00'::timestamp, now()),
  (34, NULL, NULL, '[reconstructed] selectVideo() refetched only description from /video/play/:i', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
selectVideo() refetched only description from /video/play/:id, so up-next/recommended', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 94b87cc9 (2026-06-08). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-08T12:00:00'::timestamp, now()),
  (35, NULL, NULL, '[reconstructed] Fix open bug reports: #34 video playback, #36 insurance/mort', 'RECONSTRUCTED from git history — original report text lost in the 2026-07-11 factory reset.

Only the fix commit subject survives:
Fix open bug reports: #34 video playback, #36 insurance/mortgage crash, #37 messages bleed, #35 load perf (#408)', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit subject (2026-06-08); detail unrecoverable. Reopened for regression re-verification.', '2026-06-08T12:00:00'::timestamp, now()),
  (36, NULL, NULL, '[reconstructed] ComingSoonPage destructured icon->color, leaving Icon undefi', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
ComingSoonPage destructured icon->color, leaving Icon undefined -> ReferenceError', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 94b87cc9 (2026-06-08). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-08T12:00:00'::timestamp, now()),
  (37, NULL, NULL, '[reconstructed] SellerChatTab loaded the user''s entire global inbox -> perso', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
SellerChatTab loaded the user''s entire global inbox -> personal conversations bled', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 94b87cc9 (2026-06-08). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-08T12:00:00'::timestamp, now()),
  (38, NULL, NULL, '[reconstructed] Fix open bug reports: #38 username-change login lockout, #35', 'RECONSTRUCTED from git history — original report text lost in the 2026-07-11 factory reset.

Only the fix commit subject survives:
Fix open bug reports: #38 username-change login lockout, #35 query perf caps (#236)', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit subject (2026-06-08); detail unrecoverable. Reopened for regression re-verification.', '2026-06-08T12:00:00'::timestamp, now()),
  (39, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (40, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (41, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (42, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (43, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (44, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (45, NULL, NULL, '[reconstructed] Messages ''Could not load conversations'': remove invalid take', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
Messages ''Could not load conversations'': remove invalid take:1 on the', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 73facc4f (2026-06-14). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-14T12:00:00'::timestamp, now()),
  (46, NULL, NULL, '[reconstructed] Videos disappearing: surface the owner''s own un-transcoded/f', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
Videos disappearing: surface the owner''s own un-transcoded/failed videos with', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit b0434a39 (2026-06-14). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-14T12:00:00'::timestamp, now()),
  (47, NULL, NULL, '[reconstructed] Search to wrong profile: dedup channel results by real chann', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
Search to wrong profile: dedup channel results by real channel_id (not display', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit b0434a39 (2026-06-14). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-14T12:00:00'::timestamp, now()),
  (48, NULL, NULL, '[reconstructed] Constant re-login: derive the shared parent cookie domain (.', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
Constant re-login: derive the shared parent cookie domain (.strug.ca) from', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 73facc4f (2026-06-14). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-14T12:00:00'::timestamp, now()),
  (49, NULL, NULL, '[reconstructed] /shop slow: push the ~20km radius into SQL as a bounding-box', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
/shop slow: push the ~20km radius into SQL as a bounding-box WHERE so the', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 73facc4f (2026-06-14). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-14T12:00:00'::timestamp, now()),
  (50, NULL, NULL, '[reconstructed] Account bleeding: clearAuth() now wipes all per-user localSt', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
Account bleeding: clearAuth() now wipes all per-user localStorage (delivery', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit b0434a39 (2026-06-14). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-14T12:00:00'::timestamp, now()),
  (51, NULL, NULL, '[reconstructed] Merge pull request #51 from strug-org/fix/bugreports-2026061', 'RECONSTRUCTED from git history — original report text lost in the 2026-07-11 factory reset.

Only the fix commit subject survives:
Merge pull request #51 from strug-org/fix/bugreports-20260619', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit subject (2026-06-19); detail unrecoverable. Reopened for regression re-verification.', '2026-06-19T12:00:00'::timestamp, now()),
  (52, NULL, NULL, '[reconstructed] /#53 Vehicle (and hotel/venue/equipment/experience) provider', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
/#53 Vehicle (and hotel/venue/equipment/experience) provider dashboard was', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit b0434a39 (2026-06-14). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-14T12:00:00'::timestamp, now()),
  (53, NULL, NULL, '[reconstructed] Fix bug reports #46/#47/#50/#52/#53 (frontend)', 'RECONSTRUCTED from git history — original report text lost in the 2026-07-11 factory reset.

Only the fix commit subject survives:
Fix bug reports #46/#47/#50/#52/#53 (frontend)', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit subject (2026-06-14); detail unrecoverable. Reopened for regression re-verification.', '2026-06-14T12:00:00'::timestamp, now()),
  (54, NULL, NULL, '[reconstructed] Stories always start from first: Hub.jsx was mapping story_i', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
Stories always start from first: Hub.jsx was mapping story_id', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 8b9c2a3b (2026-06-17). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-17T12:00:00'::timestamp, now()),
  (55, NULL, NULL, '[reconstructed] Creator videos disappeared: SellerCreatorDashboard was using', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
Creator videos disappeared: SellerCreatorDashboard was using', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 8b9c2a3b (2026-06-17). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-17T12:00:00'::timestamp, now()),
  (56, NULL, NULL, '[reconstructed] Messages double-send: guard sendMsg with a useRef flag set', 'RECONSTRUCTED from git history — the original report text was lost in the 2026-07-11 factory reset.

What we know from the fix commit:
Messages double-send: guard sendMsg with a useRef flag set', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit 8b9c2a3b (2026-06-17). Original reporter text unrecoverable. Reopened for regression re-verification.', '2026-06-17T12:00:00'::timestamp, now()),
  (57, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (58, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (59, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (60, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (61, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (62, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (63, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (64, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (65, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (66, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (67, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (68, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (69, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (70, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (71, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (72, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (73, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (74, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (75, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (76, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (77, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (78, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (79, NULL, NULL, '[reconstructed] fix(#79): hide Ads Manager until billing works', 'RECONSTRUCTED from git history — original report text lost in the 2026-07-11 factory reset.

Only the fix commit subject survives:
fix(#79): hide Ads Manager until billing works', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit subject (2026-06-21); detail unrecoverable. Reopened for regression re-verification.', '2026-06-21T12:00:00'::timestamp, now()),
  (80, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (81, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (82, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (83, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (84, NULL, NULL, '[reconstructed] Bug tracker: port strug.ca card/compact design + split featu', 'RECONSTRUCTED from git history — original report text lost in the 2026-07-11 factory reset.

Only the fix commit subject survives:
Bug tracker: port strug.ca card/compact design + split features out (#84)', 'bug', 'medium', 'open', false, NULL, NULL, 'RECONSTRUCTED from commit subject (2026-07-03); detail unrecoverable. Reopened for regression re-verification.', '2026-07-03T12:00:00'::timestamp, now()),
  (85, NULL, NULL, 'UNKNOWN — lost in data wipe', 'UNKNOWN — lost in data wipe.

This ticket existed before the 2026-07-11 factory reset but predates the bug-report email alerts (which began at #86) and is not referenced in any commit. No record of its contents survives.', 'other', 'medium', 'open', false, NULL, NULL, 'Placeholder. No surviving record — not in email archive (alerts started at #86) and not referenced in git history.', '2026-06-16T12:00:00'::timestamp, now()),
  (86, NULL, NULL, 'Videos up next', 'Constantly reverting to videos that are not processed (shorts recommendations), maybe delete these shorts if needed but the up next is really broken', 'bug', 'high', 'open', false, 'https://app.strug.ca/v/NkE5yyFW-when-you-look-at-me', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #86, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-22T23:15:00'::timestamp, now()),
  (87, NULL, NULL, 'Social video loading (for you)', 'Black sreen shows, sometimes videos do not load at al or takes more than 4-5 mins to load a video/short.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/feed', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #87, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-22T23:36:00'::timestamp, now()),
  (88, NULL, NULL, 'Videos full screen mobile', 'Mobile full screen button not working on the mobile phones + videos not aligned on mobile', 'bug', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #88, reported by @strug. Status reset to open pending regression re-verification.', '2026-06-23T04:12:00'::timestamp, now()),
  (89, NULL, NULL, 'Social', 'Social feed (all of it, photos videos) keep crashing on phone, not something went wrong message just loading then crash', 'bug', 'critical', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #89, reported by @strug. Status reset to open pending regression re-verification.', '2026-06-23T05:37:00'::timestamp, now()),
  (90, NULL, NULL, 'Pin Board', 'No wy to delete your own posts or pins', 'bug', 'medium', 'open', false, 'https://app.strug.ca/pinboard', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #90, reported by @strug. Status reset to open pending regression re-verification.', '2026-06-23T22:42:00'::timestamp, now()),
  (91, NULL, NULL, 'Discounts', 'Discount has mock data, It is not wired to anything yet', 'ui', 'medium', 'open', false, 'https://app.strug.ca/discounts', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #91, reported by @strug. Status reset to open pending regression re-verification.', '2026-06-23T22:50:00'::timestamp, now()),
  (92, NULL, NULL, 'Messages', 'If signed up or logged in through google api, the name on the messages show your real name instead of the name or user that you set on the platform', 'bug', 'medium', 'open', false, 'https://app.strug.ca/messages', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #92, reported by @codezero. Status reset to open pending regression re-verification.', '2026-06-23T23:02:00'::timestamp, now()),
  (93, NULL, NULL, 'Comments (videos)', 'Can''t delete comments on Videos that you posted', 'ui', 'medium', 'open', false, 'https://app.strug.ca/v/798794c4d002-new-notifications-update-generative-instrumentals-comment-search', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #93, reported by @codezero. Status reset to open pending regression re-verification.', '2026-06-24T00:51:00'::timestamp, now()),
  (94, NULL, NULL, 'Shop and other categories', 'Deleted a product one week ago. Checked shop today and the stuff is back there. The same applies to some categories like food, groceries. Somehow some of the stuff just seems to come back, but if i check the "sell on strug" section, these things (products) are not there for me to even try and delete again.', 'bug', 'critical', 'open', false, 'https://app.strug.ca/', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #94, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-24T01:11:00'::timestamp, now()),
  (95, NULL, NULL, 'Welcome', 'Welcome walkthrough getting triggered even for existing accounts. This should be a one time thing that only happens for brand new accouts/first time users', 'bug', 'high', 'open', false, 'https://app.strug.ca/become', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #95, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-24T02:38:00'::timestamp, now()),
  (96, NULL, NULL, 'Welcome', 'Leaving the walkthrough is creating a category on the home dashboard for where you left off', 'bug', 'medium', 'open', false, 'https://app.strug.ca/become', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #96, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-24T02:39:00'::timestamp, now()),
  (97, NULL, NULL, 'Walkthrough', 'Walkthrough does not go away even after completing it. it becomes a category on the homedashboard called Earn', 'bug', 'medium', 'open', false, 'https://app.strug.ca/', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #97, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-24T02:46:00'::timestamp, now()),
  (98, NULL, NULL, 'Walkthrough', 'Walkthrough retriggers when you log out and log back in or log into a new device', 'bug', 'high', 'open', false, 'https://app.strug.ca/v/z5thPua4-the-rise-and-fall-of-evil-mortgy', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #98, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-24T03:00:00'::timestamp, now()),
  (99, NULL, NULL, 'Rideshare Map (desktop, laptop, tablet)', 'Requires you to start typing an address before map is shown, not indicating drivers in the area. and ux/on devices not aligned, currently centered but does not fit well with screens', 'ui', 'medium', 'open', false, 'https://app.strug.ca/ride', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #99, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-24T03:05:00'::timestamp, now()),
  (100, NULL, NULL, 'Videos', 'Videos disappeared from frontend user side', 'bug', 'critical', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #100, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-24T23:05:00'::timestamp, now()),
  (101, NULL, NULL, 'Temp stay', 'A listing that was not made on my profile appeared weeks ago. I deleted it, now it is showing again on my temp list hosting', 'bug', 'high', 'open', false, 'https://app.strug.ca/provider/host', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #101, reported by @strug. Status reset to open pending regression re-verification.', '2026-06-25T02:26:00'::timestamp, now()),
  (102, NULL, NULL, 'Mobile loading', 'Everything takes forever to load on the mobile version, both ios and android', 'bug', 'high', 'open', false, 'https://app.strug.ca/provider', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #102, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-25T03:56:00'::timestamp, now()),
  (103, NULL, NULL, 'Videos rotate', 'Rotate button does not work in mobile. It is also being covered on some devices by the "quality change button"', 'ui', 'medium', 'open', false, 'https://app.strug.ca/settings', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #103, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-25T03:59:00'::timestamp, now()),
  (104, NULL, NULL, 'Temp Stay', 'Deleted listing weeks ago, suddenly reappearing again', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/host', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #104, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-25T04:28:00'::timestamp, now()),
  (105, NULL, NULL, 'Delete function', 'Something is wrong with delete function across the platform for several categories. Checked shop today and stuff that was deleted reappeared again, third time', 'bug', 'medium', 'open', false, 'https://app.strug.ca/listing/host/74-stay-palace', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #105, reported by @strug. Status reset to open pending regression re-verification.', '2026-06-25T07:24:00'::timestamp, now()),
  (106, NULL, NULL, 'Videos (refreshing page)', 'Refreshing page while watching a video opens a new video.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/v/vrF9EVoB-how-a-country-with-zero-football-culture-built-a-superteam', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #106, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-25T22:36:00'::timestamp, now()),
  (107, NULL, NULL, 'Videos (skipping)', 'Skipping some videos results in ending the video to play next', 'bug', 'medium', 'open', false, 'https://app.strug.ca/v/z5thPua4-the-rise-and-fall-of-evil-mortgy', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #107, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-25T22:36:00'::timestamp, now()),
  (108, NULL, NULL, 'Search (videos and all)', 'The search is beautiful but hides behind as you are typing', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #108, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-25T22:57:00'::timestamp, now()),
  (109, NULL, NULL, 'Search', 'Search left side should also suggest the profile (picture and name)', 'ui', 'medium', 'open', false, 'https://app.strug.ca/v/3b80194e6ee7-from-fifa-to-football-club-owner-documentary', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #109, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-25T23:03:00'::timestamp, now()),
  (110, NULL, NULL, 'Videos (clicking to skip)', 'Clicking to skip to a certain part of a video automatically ends the video.', 'bug', 'high', 'open', false, 'https://app.strug.ca/v/dd91080cb3ee-find-the-cheater', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #110, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-25T23:39:00'::timestamp, now()),
  (111, NULL, NULL, 'Videos', 'Leave the video category, come back and it takes you to a specific video, even if you were not watching that video instead of the home video dashboard', 'bug', 'medium', 'open', false, 'https://app.strug.ca/v/971dbe476738-the-wwe-banned-me', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #111, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-25T23:40:00'::timestamp, now()),
  (112, NULL, NULL, 'Search Results (video home)', 'Searaching on videos opens dropdown and other results (channels) should combine these into one drop down with channels on left side and the video suggestions on the right. If the user clicks enter, then they should see the results on the page', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #112, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-25T23:45:00'::timestamp, now()),
  (113, NULL, NULL, 'Deep URL links', 'Deep links do not seem to apply throughout the platform. It becomes very generic. Eg. if you click on a youtube video and then their channel, the linnk shows app.strug.ca/videos . this also happens in other categories for other aspects. It should all be unique and adaptable', 'bug', 'high', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #113, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-25T23:59:00'::timestamp, now()),
  (114, NULL, NULL, 'Search (videos)', 'Search function disappears completely in some videos when they are playing', 'bug', 'medium', 'open', false, 'https://app.strug.ca/v/798794c4d002-new-notifications-update-generative-instrumentals-comment-search', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #114, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-26T00:07:00'::timestamp, now()),
  (115, NULL, NULL, 'Multiple video upload', 'Platform already has multiple video upload function but does not exist in the frontend UI', 'ui', 'high', 'open', false, 'https://app.strug.ca/v/f55e03390193-kang-origins', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #115, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-26T02:16:00'::timestamp, now()),
  (116, NULL, NULL, 'Videos, social (view count)', 'View count seems to be very inaccurate for the platform. Count is anytime someone clicks or interacts with the object (video or post), which should increase accordingly', 'bug', 'medium', 'open', false, 'https://app.strug.ca/v/z5thPua4-the-rise-and-fall-of-evil-mortgy', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #116, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-26T02:24:00'::timestamp, now()),
  (117, NULL, NULL, 'Videos', '1. Recommended videos in up next seem to always be the same videos over and over again
2. Video home page featured and initial videos seem to not be alternating or changing as new videos are coming in or the videos are being watched. Trending should not just be the most watched video on the platform (this way new creators can also be discovered more fairly)', 'bug', 'high', 'open', false, 'https://app.strug.ca/v/b43ba90bfb0b-even-the-steam-deck-got-hit', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #117, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-26T02:30:00'::timestamp, now()),
  (118, NULL, NULL, 'Signup Bug', 'Putting in information. WHen you add profile photo it says already have social profile (see attached) cant continue from there', 'bug', 'critical', 'open', false, 'https://app.strug.ca/', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #118, reported by @4fun. Status reset to open pending regression re-verification.', '2026-06-26T04:16:00'::timestamp, now()),
  (119, NULL, NULL, 'Videos (Quality)', 'Changing video quality breaks video, freezes it or skips.', 'bug', 'critical', 'open', false, 'https://app.strug.ca/v/4RIGAWZz-i-caught-married-cheaters-in-4k', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #119, reported by @4fun. Status reset to open pending regression re-verification.', '2026-06-26T04:37:00'::timestamp, now()),
  (120, NULL, NULL, 'Channel Bug (videos)', 'Created a channel, when editing, it says i dont have a channel yet', 'bug', 'high', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #120, reported by @amhoops. Status reset to open pending regression re-verification.', '2026-06-26T04:41:00'::timestamp, now()),
  (121, NULL, NULL, 'Videos showing up', 'Videos show up in order of upload date. This is not fair since all one persons video will show up on the homepage. Should find a way to make these random or recommended for new users and such instead of the same videos showing by upload date', 'performance', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #121, reported by @amhoops. Status reset to open pending regression re-verification.', '2026-06-26T04:44:00'::timestamp, now()),
  (122, NULL, NULL, 'Edit profile (Creator)', 'Edited my profile, came back and went to edit profile, the picture and banner are gone and i have to reupload again', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #122, reported by @amhoops. Status reset to open pending regression re-verification.', '2026-06-26T04:49:00'::timestamp, now()),
  (123, NULL, NULL, 'Video (preview image)', 'Video preview images come off VERY distorted sometimes', 'bug', 'high', 'open', false, 'https://app.strug.ca/v/S1OblAmQ-single-mom-to-one-child-s-father-left-them-make-at-least-70k-and-height-does-mat', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #123, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-26T04:52:00'::timestamp, now()),
  (124, NULL, NULL, 'Social (Stories)', 'No way to align stories when posting, the stories are not centered at all. no way to crop the story either', 'bug', 'medium', 'open', false, 'https://app.strug.ca/v/S1OblAmQ-single-mom-to-one-child-s-father-left-them-make-at-least-70k-and-height-does-mat', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #124, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-26T04:53:00'::timestamp, now()),
  (125, NULL, NULL, 'Banners', 'No way to properly crop banners for profile or creator profile (maybe use twitter to see how they do it and copy that?)', 'bug', 'medium', 'open', false, 'https://app.strug.ca/@aninews', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #125, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-26T04:55:00'::timestamp, now()),
  (126, NULL, NULL, 'Social Recommendations', 'All the recommendations are REDDIT?', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #126, reported by @kendrag. Status reset to open pending regression re-verification.', '2026-06-26T04:59:00'::timestamp, now()),
  (127, NULL, NULL, 'Creator Profile Photo', 'Creator Profile and Banner keeps disappearing on my page', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #127, reported by @amhoops. Status reset to open pending regression re-verification.', '2026-06-26T05:01:00'::timestamp, now()),
  (128, NULL, NULL, 'Search videos', 'If searching, it should not just show the creator but their videos as well maybe one or two. the you may also like is amazing btw keep that', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #128, reported by @chefnick. Status reset to open pending regression re-verification.', '2026-06-26T05:05:00'::timestamp, now()),
  (129, NULL, NULL, 'Profile Leaking', 'It keeps saying i already have a social media account. This is a new account. Are accounts leaking>>>?', 'bug', 'medium', 'open', false, 'https://app.strug.ca/@damilee', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #129, reported by @damilee. Status reset to open pending regression re-verification.', '2026-06-26T05:18:00'::timestamp, now()),
  (130, NULL, NULL, 'Video recommendations (search)', 'Repetitive recommendations in the search engine. All the videos seem to be in order', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #130, reported by @damilee. Status reset to open pending regression re-verification.', '2026-06-26T05:20:00'::timestamp, now()),
  (131, NULL, NULL, 'Accounts Leaking', 'Accounts are definitely leaking. Brand new account and i see the social posts without needing to follow', 'bug', 'medium', 'open', false, 'https://app.strug.ca/feed', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #131, reported by @fern. Status reset to open pending regression re-verification.', '2026-06-26T05:28:00'::timestamp, now()),
  (132, NULL, NULL, 'Handle already taken', 'Keeps saying handle already taken even though it failed to create the first time on signup when i am trying to change in the profile from user731', 'bug', 'medium', 'open', false, 'https://app.strug.ca/settings', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #132, reported by @fern. Status reset to open pending regression re-verification.', '2026-06-26T05:29:00'::timestamp, now()),
  (133, NULL, NULL, 'Videos Overview', 'Video preview should probably show you the video. The quality should be increased like the analytics', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #133, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-26T05:41:00'::timestamp, now()),
  (134, NULL, NULL, 'Video Content', 'Video overview section should increase like the analytics section. Clicking should pop the video up as well. Should have several options from there, seeing how the video is performing, going to the video etc', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #134, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-26T05:42:00'::timestamp, now()),
  (135, NULL, NULL, 'Creator profile and banner', 'My profile and banner keep disappearing. I''ve uploaded five times. 2 video on phone needs presentation upgrade', 'bug', 'high', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #135, reported by user/115. Status reset to open pending regression re-verification.', '2026-06-26T06:13:00'::timestamp, now()),
  (136, NULL, NULL, 'Loading', 'Loading on a new device takes a very long time for each category', 'performance', 'medium', 'open', false, 'https://app.strug.ca/ride', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #136, reported by @strug. Status reset to open pending regression re-verification.', '2026-06-26T07:38:00'::timestamp, now()),
  (137, NULL, NULL, 'Tour (walkthrough)', 'I skipped the tour but when i log back in its forcing me to take it.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #137, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T07:40:00'::timestamp, now()),
  (138, NULL, NULL, 'Scroll (laptop)', 'Really hard to scroll down or up on left side tab on laptop device', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #138, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T07:44:00'::timestamp, now()),
  (139, NULL, NULL, 'Video (content)', 'I cant interact with some of the videos in the content side (Creator) right now i can only delete or edit', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #139, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-26T08:00:00'::timestamp, now()),
  (140, NULL, NULL, 'Portal', 'All the portals say Seller Portal, even if it is just Creator, maybe change it to Strug Portal', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #140, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-26T08:01:00'::timestamp, now()),
  (141, NULL, NULL, 'Videos Homepage', 'Same videos over an over maybe make them random or new videos show up on home page each time or maybe based on the recommendation by user view', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #141, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-26T08:02:00'::timestamp, now()),
  (142, NULL, NULL, 'Empty sections on devices', 'Some sections on device feel empty (see image right hand corner)', 'ui', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #142, reported by @damilee. Status reset to open pending regression re-verification.', '2026-06-26T08:06:00'::timestamp, now()),
  (143, NULL, NULL, 'Video (Duration)', 'Many vidoes display a video duration of 0:00', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #143, reported by @damilee. Status reset to open pending regression re-verification.', '2026-06-26T08:08:00'::timestamp, now()),
  (144, NULL, NULL, 'Video playlist', 'A video playlist (sometimes auto created based on previously watched vides) like how youtube has it would be amazing', 'bug', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #144, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T08:37:00'::timestamp, now()),
  (145, NULL, NULL, 'Buffering bug', 'Skipping a video to a certain point before it buffers forces the video to end instead of going to that point and buffering', 'bug', 'high', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #145, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T08:40:00'::timestamp, now()),
  (146, NULL, NULL, 'Video Analytics', 'Video analytics do not seem to all. Probably should add some more features to this section to give creators a lot more information from audience location, watch times per videos and a lot more things the creator would find useful. Should also include this in the content videos when you click them (currently exists in the analytics when you click video but it is very limited)', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #146, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-26T08:45:00'::timestamp, now()),
  (147, NULL, NULL, 'Streaming (streamer side)', 'Should apply some of the stuff from video creator side to the streaming as well. such as indepth analytics, the earnings changes and so on.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/streamer', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #147, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-26T09:06:00'::timestamp, now()),
  (148, NULL, NULL, 'Streaming', 'For streaming, maybe add a way for the streamers to see (preview) their own stream as they stream as well. So they can see their chat, their viewers, and other things on their stream, including a way for moderation (word), banning, muting people, subscription (maybe just copy the twitch pricing),', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/streamer', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #148, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-26T09:12:00'::timestamp, now()),
  (149, NULL, NULL, 'Scroll bar', 'Some pages dont have a scroll bar for laptop. very difficult to navigate on laptop device', 'other', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #149, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-26T10:02:00'::timestamp, now()),
  (150, NULL, NULL, 'Shorts', 'Maybe sort the shorts display better. Also if searching the videos, right now it shows you shorts and videos (both are structured in the same square) separate it so people know which is a short and which is the video when the search', 'ui', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #150, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T10:40:00'::timestamp, now()),
  (151, NULL, NULL, 'Analytics', 'Should increase the analytics in the food, groceries, cateries, ecommerce, flowers, catering the following Order performance
Real-time and historical order volume, average order value, order frequency by time of day/day of week, and order completion rate. This helps spot peak hours and staffing needs.
Revenue analytics
Gross revenue, net revenue after platform fees, revenue trends over time, and revenue breakdown by menu category or item. Include comparison periods (this week vs last week, this month vs last year).
Menu intelligence
Best and worst performing items by orders, revenue, and margin. Attach rates (what gets ordered together), item-level refund rates, and demand forecasting by item so you can prep the right quantities.
Customer behavior
New vs returning customer ratio, customer lifetime value, repeat order frequency, and churn rate. Segment by ordering habits to identify your most loyal customers.
Operational efficiency
Prep time vs promised time, order-ready-to-pickup time, average time from order placed to delivered, and how often orders are late. This exposes bottlenecks in your kitchen workflow.
Ratings and reviews
Average rating over time, rating breakdown by category (food quality, packaging, accuracy), sentiment trends from review text, and correlation between ratings and specific menu items or time periods.
Cancellations and refunds
Cancellation rate and reasons, refund rate by item or order type, and financial impact of refunds. High rates on specific items often signal a quality or expectation problem.
Demand forecasting
Predicted order volume by hour and day using historical patterns, adjusted for weather, local events, and seasonality. Helps with staffing, prep, and inventory planning.
Promotions and discounts
Performance of each promo or discount campaign — orders driven, revenue impact, discount cost, and whether customers who used a promo came back without one.
Competitor benchmarking (where platform data allows)
Your average rating vs category average, your delivery time vs nearby restaurants, pricing positioning relative to similar menus.', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #151, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T10:47:00'::timestamp, now()),
  (152, NULL, NULL, 'Dashboard (from home page)', 'Maybe add other stuff like overall analytics, activity (already there but not really operational) and anything that would be useful to grab from the overall platform', 'bug', 'medium', 'open', false, 'https://app.strug.ca/dashboard', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #152, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T10:51:00'::timestamp, now()),
  (153, NULL, NULL, 'Raise', 'Uploading a photo on raise is not reflected on the user side', 'ui', 'medium', 'open', false, 'https://app.strug.ca/raise', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #153, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T10:53:00'::timestamp, now()),
  (154, NULL, NULL, 'Platform Preview', 'Should have platform preview for app.strug.ca so people can see the platform. if they click anywhere it prompts them to the sign in page', 'other', 'low', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #154, reported by @codezero. Status reset to open pending regression re-verification.', '2026-06-26T19:29:00'::timestamp, now()),
  (155, NULL, NULL, 'Videos (Popular right now)', 'Popular right now and trending seem to be the exact same thing or the exact same videos.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #155, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T19:35:00'::timestamp, now()),
  (156, NULL, NULL, 'Videos (squares and size)', 'The squares are nicely designed but 6 is too much for desktop, and laptop. If you are going for a youtube FEEL then just use their size (see attached) either four or 3 but preferably FOUR looks best', 'ui', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #156, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T19:40:00'::timestamp, now()),
  (157, NULL, NULL, 'Devices', 'I keep getting new login detected email on every time i log in even though it is the same email. It gets repetitive and annoying.', 'account', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #157, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T19:53:00'::timestamp, now()),
  (158, NULL, NULL, 'Login', 'If i log in on two different browsers, it shows me the same profile. Eg. When i logged in to this account on firefox and tried to log into a personal account on chrome, one of the accounts took over the other', 'other', 'high', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #158, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T19:54:00'::timestamp, now()),
  (159, NULL, NULL, 'Links', 'Links dont seem to properly exist at all. I can be watching a video, if i go back i cant go forward because there is no actual link of that video. It looks like the deep links are all in one place. Like for videos everything or most of the stuff is just app.strug.ca/videos', 'performance', 'medium', 'open', false, 'https://app.strug.ca/v/7bd56e5d076f-chill-music-for-work-lofi-beats-to-stay-productive', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #159, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T20:08:00'::timestamp, now()),
  (160, NULL, NULL, 'Clicking on Profile (videos)', 'Clicking on profile creator''s profile as you are watching a video does not go to that creator''s profile', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #160, reported by @avocadoanimations. Status reset to open pending regression re-verification.', '2026-06-26T22:49:00'::timestamp, now()),
  (161, NULL, NULL, 'Banner (Creator profile)', 'Banner size too small for modifying on the creator side. Cropping is limited as well', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #161, reported by @abaandpreach. Status reset to open pending regression re-verification.', '2026-06-26T22:54:00'::timestamp, now()),
  (162, NULL, NULL, 'Next video (auto play)', 'This is nice but more variety is and recommendations needed. Visibility as well', 'ui', 'medium', 'open', false, 'https://app.strug.ca/v/BlZOV3h4-velma-meets-the-original-velma', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #162, reported by @abaandpreach. Status reset to open pending regression re-verification.', '2026-06-26T22:57:00'::timestamp, now()),
  (163, NULL, NULL, 'Auto Play (bugged)', 'When a video is played next in auto play function, that new video freezes or stops playing then tries to jump to next video', 'bug', 'high', 'open', false, 'https://app.strug.ca/v/BlZOV3h4-velma-meets-the-original-velma', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #163, reported by @abaandpreach. Status reset to open pending regression re-verification.', '2026-06-26T22:58:00'::timestamp, now()),
  (164, NULL, NULL, 'Search Videos', 'While video is playing, searching a profile and clicking on the profile does nothing. Clicking on the video in the search works very well', 'bug', 'medium', 'open', false, 'https://app.strug.ca/v/86c11dfff062-p-no-ch-o-mc-gp-e-dj-glenner-kondzilla', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #164, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-06-26T23:48:00'::timestamp, now()),
  (165, NULL, NULL, 'Back button and links', 'While watching a video or doing anything on platform, if you click back (browser) it takes you to a random section instead of the previous page, same thing for forward button on browser. Seems link are a bit broken. Also clicking on profiles do not lead to profile and lastly search in videos is very case sensitive', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #165, reported by @yawaskits. Status reset to open pending regression re-verification.', '2026-06-27T00:07:00'::timestamp, now()),
  (166, NULL, NULL, 'Videos (Search profile)', 'My creator profile is not suggested as you type. And my profile picture and creator information keeps disappearing', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #166, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-27T00:11:00'::timestamp, now()),
  (167, NULL, NULL, 'Analytics and dashbard', 'Dashboards look amazing but seem a bit incomplete.', 'ui', 'high', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #167, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-27T00:12:00'::timestamp, now()),
  (168, NULL, NULL, 'Video Still processing', 'When video finished, if i click next video on the screen it just says still processing but when i go to that video a different way, it plays.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #168, reported by @aninews. Status reset to open pending regression re-verification.', '2026-06-27T00:17:00'::timestamp, now()),
  (169, NULL, NULL, 'View Count', 'Video view count is very inaccurate foor user frontend side. Ive watched my own video a few times. It shows when i click but when i go to home dashboard it says zero watches', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #169, reported by @jeffgao. Status reset to open pending regression re-verification.', '2026-06-27T01:07:00'::timestamp, now()),
  (170, NULL, NULL, 'Profile Videos', 'Editing profile and changing photo keeps disappearing', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #170, reported by @jeffgao. Status reset to open pending regression re-verification.', '2026-06-27T01:12:00'::timestamp, now()),
  (171, NULL, NULL, 'Blurry Banner', 'My creator banner and profile banner keep coming out so blurry', 'ui', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #171, reported by @julesonthecouch. Status reset to open pending regression re-verification.', '2026-06-27T01:32:00'::timestamp, now()),
  (172, NULL, NULL, 'Pending Video', 'A lot of videos previously still in pending?', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #172, reported by @uncleroger. Status reset to open pending regression re-verification.', '2026-06-27T03:17:00'::timestamp, now()),
  (173, NULL, NULL, 'Analytics Inaccurate', 'Analytics on my creator dashboard says 41 views but on the frontend user side it says 73 views for that same view. A few things seem to be out of sync', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #173, reported by @uncleroger. Status reset to open pending regression re-verification.', '2026-06-27T03:23:00'::timestamp, now()),
  (174, NULL, NULL, 'Shop', 'Created store testing weeks ago. Product was deleted. It keeps reappearing on the user side but when i check the seller dashboard, there is nothing there for me to delete again', 'bug', 'high', 'open', false, 'https://app.strug.ca/provider/ecommerce', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #174, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-27T03:39:00'::timestamp, now()),
  (175, NULL, NULL, 'Shop', 'Uploaded images on Shop do not show on the user side. Deleting product does not result in full delete. They come back.', 'ui', 'medium', 'open', false, 'https://app.strug.ca/shop', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #175, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-27T03:44:00'::timestamp, now()),
  (176, NULL, NULL, 'Shop', 'Users do not know how to add storefont cover page or edit it', 'ui', 'medium', 'open', false, 'https://app.strug.ca/shop', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #176, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-27T03:46:00'::timestamp, now()),
  (177, NULL, NULL, 'Food Storefront', 'There is no way to add image or edit Food storefront from the Store dashboard.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/food', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #177, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-27T03:53:00'::timestamp, now()),
  (178, NULL, NULL, 'Food Seller dashboard', 'Updating profile bio of restaurant does not save
2. When you create a new store, it is automatically set as offline. There is no way to go online to receive orders.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/food', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #178, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T03:59:00'::timestamp, now()),
  (179, NULL, NULL, 'Accounts', 'Accounts created at a certain period seem to only see older version of the platforms. They do not have new updates or recent changes applied whether it is their dashboard or the provider sections. Meaning if i registered for food before a certain update, my stuff is stuck in that period', 'account', 'critical', 'open', false, 'https://app.strug.ca/provider/food', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #179, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:00:00'::timestamp, now()),
  (180, NULL, NULL, 'Food (Online)', 'Going online requires the seller to set a time and closing time. Most people (including myself) would not figure this out without frustration', 'bug', 'medium', 'open', false, 'https://app.strug.ca/food', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #180, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:02:00'::timestamp, now()),
  (181, NULL, NULL, 'Food add item', 'Add item button does nothing, needs to go to menu to add food item', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/food', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #181, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:16:00'::timestamp, now()),
  (182, NULL, NULL, 'Messages (Food and other categories)', 'Sending a message to a store, driver or any other categories is directly ONLY going to the message vertical instead of instead that vertical as well. Currently no way to distinguish origin of the message', 'bug', 'medium', 'open', false, 'https://app.strug.ca/messages', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #182, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:21:00'::timestamp, now()),
  (183, NULL, NULL, 'Temp Stay (Host Edit Profile)', 'Host dashboard (edit profile) should not be Business name. It should be the host''s name. There should be no website URL', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/host', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #183, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:27:00'::timestamp, now()),
  (184, NULL, NULL, 'Editing listing (temp stay)', 'Came to edit listing, all information disappears forcing you to start again. 2. There is no way to add a cover photo or is that automatic', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/host', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #184, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:29:00'::timestamp, now()),
  (185, NULL, NULL, 'Temp Stay', 'Images are presented nicely in the row. However, it is DIFFICULT for the user to see them or play around with them. Most people want a FULL view of the property. The images banner is beautiful indeed and should stay but there has to be a way to view the image or preview the full image', 'ui', 'medium', 'open', false, 'https://app.strug.ca/listing/host/75-home-downtown', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #185, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:31:00'::timestamp, now()),
  (186, NULL, NULL, 'Clicking Back', 'Clicking back ANYWHERE on the browser or forward is taking you to the home dashboard', 'bug', 'medium', 'open', false, 'https://app.strug.ca/listing/host/75-home-downtown', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #186, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:32:00'::timestamp, now()),
  (187, NULL, NULL, 'Provider dashboard', 'Provider dashboard does not light up for some categories if you apply. It requires you to reapply', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #187, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:34:00'::timestamp, now()),
  (188, NULL, NULL, 'Host profile and hosted by', 'When you click on the host profile from the user side in temp stay, it takes you to the profile of the person (their regular profile not their temp stay professional profile). The current "edit host profile" is does not seem to be creating or linking a professional profile for the host. Think of it like the creator profile. When a user clicks on a video, then clicks on the profile that uploaded it, it does not take them to the user''s regular profile. It takes them to the creator''s professional profile where they can see information and other videos that creator has uploaded. In the same way a host professional profile and other profiles in different categories work the same way. It takes them to the created host profile that shows users all the properties the host has listed. Same with FOOD, SHOP, FLOWERS, and so on.', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/host', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #188, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:38:00'::timestamp, now()),
  (189, NULL, NULL, 'Host profile listings', 'There is currently no image preview for the host after uploading a product.', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/host', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #189, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:39:00'::timestamp, now()),
  (190, NULL, NULL, 'Provider', 'Keeps asking me to sign up as a provider each time i click on certain things. Registration should only happen once', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/ecommerce', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #190, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:41:00'::timestamp, now()),
  (191, NULL, NULL, 'Analytics', 'Analytics dashboard should be added and adapted to EVERY provider dashboard. Currently it only appears in a few such as creator, food, shop. but should also be inside and adapted to sections like Temp stay (showing analytics about the property, room etc), hotels, courier, rentals, everywhere on provider dashboard', 'ui', 'high', 'open', false, 'https://app.strug.ca/provider/host', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #191, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:44:00'::timestamp, now()),
  (192, NULL, NULL, 'Video Search previw', 'Search function preview in the search box is beautiful but the search itself (if you look up a creator or video) should SHOW you some of the videos and not just the profile of the creator. Also i dont think the profile taking up the entire line or space is quite wise in terms of design', 'ui', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #192, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T04:48:00'::timestamp, now()),
  (193, NULL, NULL, 'Web App Notifications', 'Should consider adding a web app notification since users may not always be on the platform. How do we add push notifications to their phones as well for the various categories?', 'other', 'medium', 'open', false, 'https://app.strug.ca/town-hall', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #193, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:02:00'::timestamp, now()),
  (194, NULL, NULL, 'Construction', 'Added a project on developer (preconstruction portal) but it does not appear on the construction vertical for user side', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #194, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:08:00'::timestamp, now()),
  (195, NULL, NULL, 'Construction', 'Added dvelopment project and images. came back the images are broken.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/precon', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #195, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:09:00'::timestamp, now()),
  (196, NULL, NULL, 'Streamer Profile', 'Streamer profile is not the same as user profile. This is the profile a user will see when they click on the steamer’s icon on their stream. This will lead them to a similar structure to the example but for streamer where user will see previous VODS, previous streams etc. So editing THIS PROFILE should edit that section and not the original user side. The wording should be adapted accordingly', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/streamer', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #196, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:14:00'::timestamp, now()),
  (197, NULL, NULL, 'Real Estate And Construction', 'Posted a project in Construction. Image is broken but it is showing up in the real estate vertical and not the Construction vertical', 'bug', 'high', 'open', false, 'https://app.strug.ca/realestate', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #197, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:35:00'::timestamp, now()),
  (198, NULL, NULL, 'Connected dashboards', 'Please UNLINK EVERY single provider dashboard from bleeding from one another. Attached is the preconstruction project which is broken in the construction vertical and construction developer dashboard but shows up PERFECTLY in the real estate Agent dashboard', 'bug', 'critical', 'open', false, 'https://app.strug.ca/provider/realestate', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #198, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:39:00'::timestamp, now()),
  (199, NULL, NULL, 'Real Estate Profile', 'Real estate agent profile is not the same as user profile. This is the profile a user will see when they click on the agent''s icon (see attachedd which should have the name and not just say real estate agent) property listing. This will lead them to a similar structure to the example but for streamer where user will see all the listing that agent or ageny has. So editing THIS PROFILE should edit that section and not the original user side.', 'ui', 'high', 'open', false, 'https://app.strug.ca/provider/realestate', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #199, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:41:00'::timestamp, now()),
  (200, NULL, NULL, 'Developer Profile', 'Preconstruction developer profile is not the same as user profile. This is the profile a user will see when they click on the developer’s icon on a listed property (which should say the developer name or agency name not just say real estate developer). This will lead them to a similar structure to the example (attached) but for developers where user will see OTHER developments and project that developer has ,. So editing THIS PROFILE should edit that section and not the original user side. Information here should be relevant to real estate development and reflect on the user side accordingly', 'bug', 'critical', 'open', false, 'https://app.strug.ca/preconstruct', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #200, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:44:00'::timestamp, now()),
  (201, NULL, NULL, 'Booking/reservation sign up location', 'While setting up the reservation or booking section, it asks for location, this should suggest the locations as you type like the other sections', 'performance', 'high', 'open', false, 'https://app.strug.ca/reservations', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #201, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:47:00'::timestamp, now()),
  (202, NULL, NULL, 'Reservation fee', 'It should be up to the owner if they want a reservation fee. We are not charging on strug for this regardless', 'bug', 'medium', 'open', false, 'https://app.strug.ca/reservations', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #202, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:48:00'::timestamp, now()),
  (203, NULL, NULL, 'Bookings presentation', 'Bookings presentation user side needs to be improved
2. Image upload does not show or reflect on the user side', 'ui', 'high', 'open', false, 'https://app.strug.ca/reservations', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #203, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:50:00'::timestamp, now()),
  (204, NULL, NULL, 'Booking preview', 'Booking preview images not working. Same with banner of the restaurant. How to change this? Try copying the airbnb strcuture if needed', 'ui', 'medium', 'open', false, 'https://app.strug.ca/reservations', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #204, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:51:00'::timestamp, now()),
  (205, NULL, NULL, 'Bookings VS restaurant bookings', 'Bookings category on user side seems different which is fine. But when you try to edit the booking, it takes you to restaurant provider dasbboard but there is no way to see the information, edit it or even delete that booking page that is set up.', 'bug', 'critical', 'open', false, 'https://app.strug.ca/provider/restbookings', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #205, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:53:00'::timestamp, now()),
  (206, NULL, NULL, 'Venue (BOOKING)', 'Listed in the booking a restaurant. There is no way to modify in restaurant provider dashboard or venue provider dashboard
2. Add analytics to venue provider and resutarnt provider dashboards', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/venue', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #206, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T05:54:00'::timestamp, now()),
  (207, NULL, NULL, 'Login', 'if you log out and go directly to app.strug.ca , it takes you to a profile previously logged into', 'bug', 'high', 'open', false, 'https://app.strug.ca/@strug', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #207, reported by @strug. Status reset to open pending regression re-verification.', '2026-06-27T08:10:00'::timestamp, now()),
  (208, NULL, NULL, 'Celebrity/Influencer Profile', 'Celebrity/influencer profile is not the same as the regular profile. It is a unique profile for this category. When the user clicks on the celebrity on the user dasboard section, it should let them see something like this which shows the celebrities past work https://www.cameo.com/ buxtagram?aaQueryId= 200ed1efa957885d6b3b34f1252f50 a5 and information filled out or even this https://collabstr.com/tubii structure works. This means information should REFLECT this section''s profile instead of Business name"', 'bug', 'high', 'open', false, 'https://app.strug.ca/provider/celebrity', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #208, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:20:00'::timestamp, now()),
  (209, NULL, NULL, 'Analytics (Celebrity and influencer)', 'Adapt the analytics page to the celebrity/talent section', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/celebrity', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #209, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:21:00'::timestamp, now()),
  (210, NULL, NULL, 'Influencer Portal', 'Adapt analytics dashboard from creator studio to the influencer portal', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/influencer', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #210, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:24:00'::timestamp, now()),
  (211, NULL, NULL, 'Influencer Profile', 'Influencer profile is not the same as the regular profile. When the user clicks on this profile from the influencer category, they see this https://collabstr.com/tubii which shows the influencers rates, their previous work and their profile photo information, etc So the wording needs to be for influencers. Not "Business name"', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/influencer', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #211, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:27:00'::timestamp, now()),
  (212, NULL, NULL, 'Starving artist analytics', 'Adapt analytics dashboard to starving artist accordingly', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/artist', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #212, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:30:00'::timestamp, now()),
  (213, NULL, NULL, 'Starving artist', 'The starving artist profile is not the same as the normal profile. It is more of a portfolio for the artist to display their work, their pricing etc. So if the artist posts something for sale, when the user clicks on the profile, they see all the other stuff that the artist has for sale and for commission or can be contacted etc', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/artist', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #213, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:32:00'::timestamp, now()),
  (214, NULL, NULL, 'Starving artist (functionality)', 'Category is not yet functional. Current dashboard looks like it is for a different category. if you try to add anything, it says home repair, home repair, home repair', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/artist', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #214, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:34:00'::timestamp, now()),
  (215, NULL, NULL, 'Author Profile', 'Author profile is NOT the same as other profiles or connected to other profiles in any way or the normal profile. Currently it is taking information from other profiles. The author profile is unique profile for the author and THEIR WORK/Books. Meaning when a user goes to buy books and clicks on the Author''s profile, they will see EDITED profile that shows all the OTHER books the author has for sale. information that is edited to the author section. It should not have data from other categories or even say "Business name" EACH profile is UNIQUE to the SPECIFIC category WITHOUT connection', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/authors', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #215, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:39:00'::timestamp, now()),
  (216, NULL, NULL, 'Grocery Store', 'Grocery store dashboard and profile is NOT The same as regular profile or CONNECTED to the other dashboards other than the rideshare and courier. RIght now information from FOOD delivery is being shown and reflected on the grocery side. Things being done in food is impacting groceries, floral, catering and vice versa. They are ALL separate even though the have similar logic. If i sign up for groceries, and go to my dashboard, i should not be seeing information from food or other categories other than the information i set. This means when the user clicks on MY store, what they see is MY grocery store and not what is set on other categories.', 'bug', 'high', 'open', false, 'https://app.strug.ca/provider/groceries', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #216, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:46:00'::timestamp, now()),
  (217, NULL, NULL, 'Groceries (reservation)', 'There is a reservation section on the groceries why? We can reserve a table at a grocery store. It seems that it is taking all the logic from the other categories and bleedng it straight to groceries', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/groceries', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #217, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:48:00'::timestamp, now()),
  (218, NULL, NULL, 'Groceries', 'Created a store, created a listing.. it goes no where. Went to the groceries user dashboard it still says no store available in your area. Checked other categories, it is not there. Listing is oranges', 'bug', 'critical', 'open', false, 'https://app.strug.ca/groceries', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #218, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:51:00'::timestamp, now()),
  (219, NULL, NULL, 'Events and occassions', 'There are two buttons for hosting/listing an event. Are these the exact same function?', 'ui', 'medium', 'open', false, 'https://app.strug.ca/events', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #219, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:55:00'::timestamp, now()),
  (220, NULL, NULL, 'Analytics (Eevnts and occassion)', 'Add and adapt analytics dashboard t events and occassions', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/events', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #220, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:56:00'::timestamp, now()),
  (221, NULL, NULL, 'Events and occassions profile', 'Events and occassions profile is a unique profile created for this category specifically. It is NOT connected or attached to other profiles at all. This is the profile the user creates for this category specifically so when someone clicks on their events, they will see other events that they have happening, the events details cost, etc So it should really be adapted accordingly (aka no business name). It should NOT be bleeding from other categories or INTO other categories', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/events', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #221, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T08:59:00'::timestamp, now()),
  (222, NULL, NULL, 'Events and occasions', 'Created an event listing, it does NOT go to the events and occassions dashboard on the user side. Still empty.
2. Listings should be WITHIN the 20k radius of the user or all them to filter the distance just like the airbnb function by typing in the location.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/events', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #222, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T09:02:00'::timestamp, now()),
  (223, NULL, NULL, 'Videos phone', 'As video is playing on mobile, if you scroll down the video becomes a SMALL part of the screen. It is REALLY hard to interact with the rest of the phone. Maybe use youtube on the phone, scroll down and see how they have it done, copy that. Same thing with moving the video screen down as it is playing, minimizing it to a smaller square so you can interact with the platform again', 'ui', 'medium', 'open', false, 'https://app.strug.ca/v/isqZINbR-is-he-cheating-with-his-ex-girlfriend-udy-loyalty-test', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #223, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T09:07:00'::timestamp, now()),
  (224, NULL, NULL, 'Courier Analytics', 'Add and adapt the analytics page for the courier dashboard', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/courier', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #224, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T09:13:00'::timestamp, now()),
  (225, NULL, NULL, 'Profile', 'If you leave the platform and come back directly through app.strug.ca it take syou to another laccount even if it is not logged in', 'bug', 'medium', 'open', false, 'https://app.strug.ca/@strug', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #225, reported by @strug. Status reset to open pending regression re-verification.', '2026-06-27T09:26:00'::timestamp, now()),
  (226, NULL, NULL, 'Floral become provider', 'Adapt the wording for florist.', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/flowers', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #226, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T09:36:00'::timestamp, now()),
  (227, NULL, NULL, 'Florist Resevations', 'There is a researvations section for flowers which makes no sense.', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/flowers', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #227, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T09:42:00'::timestamp, now()),
  (228, NULL, NULL, 'Florist profile editing', 'The FLORAL profile SHOULD not be connected, bleed into or bleed from other categories. This is a unique category. If a user clicks on a flower and clicks on the profile of the store selling, THIS is what they see with their other products, etc NOT personal profiles or other profiles. Only thing that is connected here is the delivery for the users', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/flowers', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #228, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T09:44:00'::timestamp, now()),
  (229, NULL, NULL, 'Flowers', 'Created floral arrangement, store etc. No idea where it is going or being routed to. Cant see it on the front end at all but can delete from provider dashboard', 'bug', 'high', 'open', false, 'https://app.strug.ca/listing/food/11-dominos-pizza', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #229, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-27T09:53:00'::timestamp, now()),
  (230, NULL, NULL, 'Profile (Used products)', 'Used products profile is not the same or connected to any profile. This is a profile that exists on its own like an ecommerce store. When a user goes to buy a product and clicks on the seller''s profile. THIS profile is what they see including all the other products the user has for sale, reviews, etc.
2. Currently creating a listing in the used products does not do anything. It does not go to the used product section with pictures.
3. Can''t place an order currently in the used products section. When order is placed, it is delivered and connected to the rideshare/courier section.
4. Need a location for the products just like food delivery so users see products within the area. This also means that the delivery is within that area (just like food delivery). This also means that the listing only appears within the 20km radius. A person in china shouldnt be able to see the product in Canadda and so on.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/usedproducts', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #230, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T01:16:00'::timestamp, now()),
  (231, NULL, NULL, 'Used product data bleed', 'Currently the data in the leaked products is connected to other categories like food delivery. IF you create a store in the food delivery, it is connected to the leaked products. This should not be the case, the categories are different even though they work the same way.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/digproducts', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #231, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T01:19:00'::timestamp, now()),
  (232, NULL, NULL, 'Profile (Digital prodcuts)', 'Digital products (edit profile) data is currently ocming from other categories such as food delivery. This category is different even though it works the same way. If you edit the digital product category, and profile, it should be just for digital products not for other categories.
2. The profile for digital products is like the seller profile, so when a user goes to this vertical and clicks on the profile of the seller, the user SEEs this unique category profile and all the other digital assets the seller has for sale, bio, etc that are associated with this category.
3. Uploading a product is not currently going to the digital products section. Which means there is no proper checkout flow currently', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #232, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T01:22:00'::timestamp, now()),
  (233, NULL, NULL, 'Meal kit provider', 'Meal kit exists as a provider but not as a category in the user end. should hide this for now but and for some reason it seems to be connected to the food, groceries and all the other categories', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #233, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T01:24:00'::timestamp, now()),
  (234, NULL, NULL, 'Catering Category', 'Current catering account (provider and user) seems to be directly connected to the other categories such as food and groceries. This is a unique category even though it functions a similar way.
2. The profile editing on the catering provider side should be ONLY for the catering provider. Not for food groceries etc. So when a user clicks something in this category and clicks on the profile of the seller (catering) they see the unique catering providers profile with all the stuff they have available for catering
3. Delivery (rideshare and courier) can remain embedded
4. Requires the same location logical (20km) same as food delivery so someone in china does not see catering available in India
5. Image upload should work for this category
6. Uploading in the catering category should show in the user side as well and not in other profiles.
7. Remaining flow such as checkout is required to be kept', 'bug', 'high', 'open', false, 'https://app.strug.ca/provider', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #234, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T01:28:00'::timestamp, now()),
  (235, NULL, NULL, 'List a discount', 'LIsting a discount should not require a new account or new profile.
1. If a restaurant wants to list a discount, they can do this. or whenever they list a discount on their dashboard, it shows up here
2. same thing applies for all the other categories where selling is required. So this applies to temp stay, groceries, etc. it is automatic, not manual
3. User side. clicking on the discount should take you to the section in the category where the discount is listed from which you can continue normally', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #235, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T01:34:00'::timestamp, now()),
  (236, NULL, NULL, 'Courier (Provider dashboard)', '1. Courier provider profile is currently leaking FROM the other categories such as food, ecommerce, etc. This profile is a UNIQUE profile that is specifically for couriers and nothing more. When edited this is the profile that the user sees when their courier comes to pick them up. So it should be adapted accordingly
2. User is unable to currently place a courier order and have it be picked up by the courier driver.
it should function similar to rideshare category but instead of a ride, it is a package. so remaining flow, map, checkout, location and rest is required for the user and for the provider', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/courier', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #236, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T01:38:00'::timestamp, now()),
  (237, NULL, NULL, 'Job Provider', 'There is a job provider section in the provider dashboard but not the frontend for users. this is not yet developed so we can remove it until then', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #237, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T01:44:00'::timestamp, now()),
  (238, NULL, NULL, 'Provider a service Dashboard', 'The provider a service dashboard is a UNIQUE category that is NOT connected to any other category. Currently, information is coming directly from the other categories, including the profile.
This category is like fiverr. So the edited profile is not for the normal profile but for a service provider profile. This way (just like fiver) when a user clicks on the profile, you see what other services the person offers. Additionally, the frontend should be designed just like fiverr to be able to see what the person is providing, order flow, contact flow, checkout flow etc.
3. Allow the image upload for the service being provided as well', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #238, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T01:46:00'::timestamp, now()),
  (239, NULL, NULL, 'Professional Portal and freelancer', 'These are DIFFERENT categories but they work the same way. Currently, information seems to be leaking into them from other categories. The profiles for these are different because they are like fiverr profiles. They function the same way as fiverr, literally the same way. Changes should show up in the frontend for this category and not other categories', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #239, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T01:48:00'::timestamp, now()),
  (240, NULL, NULL, 'Automotive Provider', '1. Automotive provider PROFILE and dashboard should be UNIQUE for this category speficailly. All current information seems to be leaking FROM other categories such as food.
2. The automotive provider has a few subcategories such as mechanic, dealership and roadside assistance in addition to the set your price (mechanics) currently on the provider side, there is no way to DISTINGUISH these different roles. There is no way to upload or make changes according to the different roles. Example. if i am a mechanic, i dont need the dealership role. I need a way to be able to upload my services, my prices, a checkout flow, etc. This also means that the entire thing should have a radius. I someone is in china, i dont need them seeing my work if i am in toronto. So we can use the same radius setting or location logic as rideshare.
This applies to the dealership as well. If i am a dealership, i need somethign that is unique to me so that i can upload my cars for sale, lease or rent with the remaining flow that is unique to ME
For set your own price, it is the same logic as the on demand work. So that includes the location radius, the unique information for the work, a checkout flow but the only difference is once the mechanic accepts the work, they are not coming to me, i am going to them instead.', 'bug', 'critical', 'open', false, 'https://app.strug.ca/provider/automotive', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #240, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T01:54:00'::timestamp, now()),
  (241, NULL, NULL, 'Doctor Portal', 'Doctor portal: profile is for the doctor or their practice. Current profile informaiton is leaking from other categories. If i as a user go to the doctor side and click on the their profile, i should be able to see their professional medical profile and not their personal profile.
2 The location booking should also have a radius similar to the rideshare category. I shouldnt see a doctor located in China when i am in Canada.
3. Current booking flow is not working. I booked on one device, and did not receive it on my other device to confirm the booking
4. Trying to list as a provider is not showing up on the doctor user side at all so far', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #241, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T01:56:00'::timestamp, now()),
  (242, NULL, NULL, 'Hotel, HOST, Venue, equipment, vehicle rental,', 'All these categories work the same way and should have the same design .HOWEVER, they are DIFFERENT. meaning the profile from the hotel should not be coming from the food delivery, the profile for venue is for venue provider ONLY and the equipment profile is for equipment profile only, same with vehicle.
2. Changing information on these sections should only AFFECT THESE sections not other categories. The remaining flows: Book, checkout messaging should be UNIQUE to THESE categories even though the work the same way.
3. A hotel listing a property should SHOW up on the hotel userside section. A vehicle rental uploading a car should show up on the vehicle rental category for the user, so on and so forth. Right now listing for a hotel goes to the wrong place. Only the temp stay (seems to work properly)
4. Should also be able to upload pictures for each of these categories.', 'bug', 'high', 'open', false, 'https://app.strug.ca/provider', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #242, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T02:00:00'::timestamp, now()),
  (243, NULL, NULL, 'Instructor provider', 'There is a instructor provider in the provider side but not the user frontend, this should be hidden for now', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #243, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T02:01:00'::timestamp, now()),
  (244, NULL, NULL, 'Experience Provider', 'Experience provider works the same way as the Temp stay. but for experiences.
1. Current profile is leaking from other cateogires instead of it being unique for this category.
2. Current flow is not working. Listing an experience does nothing. No way to upload an image like the temp stay. No way to book currently
3.Provider not receiving any bookings either
4. Remaining flow also required, from checkout to order notification', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #244, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T02:04:00'::timestamp, now()),
  (245, NULL, NULL, 'Insurance', '1. Center the insurance provider and the mortgage provider dashboard', 'ui', 'medium', 'open', false, 'https://app.strug.ca/provider/insurance', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #245, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T02:05:00'::timestamp, now()),
  (246, NULL, NULL, 'Insurance and mortgage', 'Center all insurance and mortgage pages for presentation', 'ui', 'high', 'open', false, 'https://app.strug.ca/provider/insurance', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #246, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T02:06:00'::timestamp, now()),
  (247, NULL, NULL, 'Page Loading', 'Logging in to the platform for the first time on any device takes a very long time to load the content and the page overall', 'performance', 'high', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #247, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T02:10:00'::timestamp, now()),
  (248, NULL, NULL, 'Deleting Bug', 'Deleting something does not seem to delete at all, it just comes back. shop, food, etc. coming back over and over again.', 'bug', 'critical', 'open', false, 'https://app.strug.ca/shop', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #248, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-28T02:18:00'::timestamp, now()),
  (249, NULL, NULL, 'Loading', 'Switching between pages takes over 2 minutes to load and sometimes does not load at all', 'performance', 'critical', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #249, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T02:25:00'::timestamp, now()),
  (250, NULL, NULL, 'Temp stay Map', 'Map is inaccurate for product display in temp stay for showing on map view', 'ui', 'medium', 'open', false, 'https://app.strug.ca/tempstay', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #250, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T02:53:00'::timestamp, now()),
  (251, NULL, NULL, 'Favourites', 'Faouriting something in some categories does not go to the favourite section. Eg. temp stay liking the location', 'bug', 'medium', 'open', false, 'https://app.strug.ca/saved', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #251, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T03:00:00'::timestamp, now()),
  (252, NULL, NULL, 'Profile Interaction', 'Profile requires some work.
1. Clicking on the posts should take you to that post or allow you to interact with it the same way as the original post. from replying, to liking
2. Likes and subscriptions require design upgrade.', 'ui', 'low', 'open', false, 'https://app.strug.ca/@struguploads', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #252, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T03:13:00'::timestamp, now()),
  (253, NULL, NULL, 'Streaming (live) VIEWER', 'ADD the following features:
Viewing experience
Theater mode — full-width view hiding sidebar
Picture-in-picture — float stream while browsing
VOD playback — past streams with scrubbing
Clip creation — capture & share recent moments
Stream quality selector — auto or manual 1080p/720p/etc.
Low-latency mode — toggle for faster chat sync
Rewind buffer — rewind live stream up to X minutes
Personalization
Watch history — resume VODs, track streams seen
Homepage layout — pin categories, hide channels
Autoplay next — continue to related content
Night / day mode — theme preference
Chat font size & color — accessibility settings
Keyboard shortcuts — power user controls', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #253, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T03:41:00'::timestamp, now()),
  (254, NULL, NULL, 'Streaming (live) STREAMER SIDE', 'ADD THE Following:
Stream setup
Stream manager dashboard — real-time overlays, alerts, chat
Stream key management — rotate, revoke, create multiple
Custom ingest server — pick closest region
Go live from browser — no OBS needed
Co-streaming / squad stream — multi-channel layout
Schedule & upcoming streams — set a calendar slot
Analytics
Concurrent viewer graph — peak, average, retention
Revenue breakdown — subs, bits, ads, donations
Follower growth — gain/loss per stream
Chat activity heatmap — see what generated engagement
Audience demographics — country, device, age bracket
Clip performance — views, shares on each clip
Channel customization
Panels & info sections — about, schedule, links
Custom emotes — sub-only or channel-wide
Custom badges — tier, loyalty, special events
Channel point rewards — define what viewers can unlock
Offline screen — custom artwork + countdown
Video player banner — branding behind the player
Production tools
Clip editor — trim, caption, share to socials
Highlight reel builder — stitch VOD segments
Raid outgoing controls — target, confirm, delay
Guest invite / co-host — add a second camera/audio
Category & title quick-edit — update without leaving stream', 'other', 'high', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #254, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T03:44:00'::timestamp, now()),
  (255, NULL, NULL, 'Streaming (live) CHAT', 'ADD the following:
Chat system
Emotes & third-party emote support — BTTV / FFZ style
Sub-only / follower-only mode — gated participation
Slow mode — rate-limit messages per user
Unique chat mode — no duplicate messages allowed
Pinned messages — highlight announcements
Replies & threads — reply to specific messages
Mention / highlight — @name with highlight ring
Community
Teams — group channels under a shared brand
Community events — tournaments, watch parties
Community posts — text, images, polls off-stream
Discord-style community hub — persistent group chat
Leaderboard — top gifters, chatters, viewers
Following & relationships
Follow / unfollow — basic relationship
Subscribe tiers — T1 / T2 / T3 with perks
Gift subscriptions — bulk gift or targeted
Prime / free sub linking — platform benefit integration
Subscriber anniversary — streak badge, notification
Sharing & clips
Clip browser — top clips per channel / game
Share stream link — with timestamp
Embed player — iframe for external sites
Social card previews — OG tags for rich link previews', 'other', 'high', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #255, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T03:45:00'::timestamp, now()),
  (256, NULL, NULL, 'Streaming (LIVE)', 'Add the following:
Revenue streams
$
Subscription splits — platform vs creator revenue share
Ad revenue — pre-roll, mid-roll, display
Bits / tipping — virtual currency cheers
Direct donations — PayPal / Stripe integration
Super chats / paid messages — pinned for a donation
Merch shelf — integrated storefront below stream
Sponsorship marketplace — brand deal matching
Payouts
Payment threshold setting — minimum before payout
Payout methods — bank, PayPal, check, wire
Payout schedule — monthly or on-demand
Tax form collection — W-9 / W-8BEN flows
Revenue dashboard — real-time earnings tracker
Ad controls
Ad break manager — run ads manually or on schedule
Subscriber ad-free — toggle on/off per sub tier
Ad snooze — viewer delays next ad for X min
Branded content tool — disclose sponsorships', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #256, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T03:47:00'::timestamp, now()),
  (257, NULL, NULL, 'Streaming (LIVE)', 'Add the following if not already there:
Browse & explore
Category / game browser — channels sorted by viewer count
Tag system — filter by language, vibe, content type
Recommended channels — ML-based personalization
Trending clips — cross-platform viral moments
Recently watched feed — quick resume
Live following feed — followed channels now live
Global search — channels, games, clips, VODs
Autocomplete suggestions — as you type
Search filters — live only, language, category
VOD search by title — find past streams', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #257, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T03:48:00'::timestamp, now()),
  (258, NULL, NULL, 'Streaming (LIVE) Safety and Mod', 'ADD the following (may need a saparate dashboard)
Channel moderation
mod
Mod dashboard — dedicated moderation view
Timeout & ban — timed or permanent, with reason
Automod — AI-based message filtering by level
Blocked terms list — custom phrase filter
Clip / VOD delete — remove harmful content
Mod log — audit trail of mod actions
Mod notes on users — internal comments on bad actors
User controls
Block user — prevent interaction globally
Report content / channel — flag for platform review
Restricted mode — filter mature content
Parental controls — account-level content restrictions
Chat message delete — user deletes own messages
Platform-level
DMCA / copyright tools — muted VOD segments, dispute flow
Content classification labels — mature, gambling, political, etc.
Channel suspension system — warnings, strikes, appeals
Trust & safety dashboard — streamer see ban reason history', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #258, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T03:50:00'::timestamp, now()),
  (259, NULL, NULL, 'Streaming (LIVE) Notifications', 'Add the following if not already existing:
Notification types
Live alerts — followed channel goes live
Stream scheduled reminders — calendar event notifications
Sub events — new subs, resubs, gifts
Raid incoming — alert + viewer count
Clip goes trending — your clip picked up traction
Milestone alerts — follower, sub, view counts
Notification controls
Per-channel notification toggle — all, highlights, or off
Quiet hours — no alerts during set times
Push vs email vs in-app — channel-level preference
Digest mode — batch hourly/daily instead of instant
Sound & vibration controls — mobile granularity
Unread badge — persistent indicator on app icon
Streamer-side alerts
On-stream overlay alerts — animated subs, follows, donations
Alert queue — hold, skip, replay alerts
Custom alert sounds — upload per event type
Text-to-speech donations — read donation message aloud
OBS / Streamlabs webhook — push events to third-party tools
Communication
Direct messages — 1:1 between users
DM request filter — approve unknown senders
Platform announcements — in-app changelog / news
Channel newsletters / updates — streamer broadcasts to followers', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #259, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T03:51:00'::timestamp, now()),
  (260, NULL, NULL, 'Invoice', 'In the order history, if you try to download the document it downloads as a json file. It should be converted into a PDF document with the company logo and the order structured like an actual invoice', 'other', 'medium', 'open', false, 'https://app.strug.ca/orders', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #260, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:12:00'::timestamp, now()),
  (261, NULL, NULL, 'Community (', 'Update or add the following to the community:
Create a community (subreddit) — name, description, type
Community types — public, restricted, private, NSFW
Community URL / handle — s/name, unique and permanent (the s/ should be added automatically)
Community avatar & banner — image upload with crop
Community description & sidebar — rich text, links, rules
Community topics / categories — tag for discovery (Gaming, News…)
Community language setting — for filtering and discovery
Age restriction gate — NSFW communities require age verification', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #261, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:18:00'::timestamp, now()),
  (262, NULL, NULL, 'Community (', 'Add the following:
Community customization
Custom theme / colors — header color, card style, accent
Custom CSS / design — for power communities
Pinned posts — up to 2 stickied at top of feed
Community rules builder — numbered rules shown on sidebar & report flow
Welcome message — auto-DM sent to new members
Community widgets — text blocks, link lists, image widgets in sidebar
Custom post flair — create labeled tags for posts
Custom user flair — member-visible role/tag next to username', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #262, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:19:00'::timestamp, now()),
  (263, NULL, NULL, 'Community', 'Add the following
Community settings
Post type restrictions — allow text / links / images / video / polls only
Require post flair — post can''t submit without a tag
Spoiler tags — members can mark posts as spoilers
Suggested sort — default to Best / New / Top for this community
Crowd control — auto-collapse comments from low-karma accounts
Post approval queue — require mod approval before visible
Minimum account age to post — e.g. must be 30 days old
Minimum karma to post — spam prevention threshold
Multi-communities & crossposting
Crosspost to another community — share a post across subs
Disable crossposting — community-level toggle
Multireddits / custom feeds — bundle communities into one feed
Community collections — group related posts into a series
Related communities widget — suggest similar subs in sidebar
Community events — scheduled event posts with RSVP', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #263, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:19:00'::timestamp, now()),
  (264, NULL, NULL, 'Community (Moderation)', 'Add the following:
Mod team
Invite moderators — add by username with permission levels
Mod permission levels — all / manage users / manage posts / manage flair / manage settings / mail / chat / wiki
Mod queue — all reported/flagged content in one view
Mod log — full audit trail of every mod action with timestamp & actor
Mod mail (modmail) — dedicated inbox for member–mod messages
Mod notes on users — private notes visible to all mods
Mod removal reasons — preset reasons sent to users on removal
Content actions
Remove post / comment — with optional removal reason message
Spam mark — flag as spam (feeds classifier)
Approve post / comment — override automod, make visible
Lock post — prevent new comments
Lock comment thread — collapse and disable replies
Distinguish mod comment — green "MOD" label on comment
Sticky a comment — pin mod comment to top of thread
Edit post flair — change or assign flair on any post
Mark as spoiler / NSFW — apply content warnings retroactively
User management
Ban user from community — temporary or permanent, with reason
Mute user in modmail — prevent spamming mod inbox
Approved submitters list — whitelist users in restricted communities
Contributor / trusted user list — special permissions per user
Ban list management — bulk import/export, notes per ban
User ban history — see all bans a user has received in your community
AutoMod
AutoModerator rules (YAML) — rule-based bot for auto-actions
Keyword filters — auto-remove posts/comments containing terms
Domain blocklist — auto-remove links from specific sites
Karma / account age gates — auto-remove from new/low-karma accounts
Auto-flair by keyword — assign flair based on title content
Report threshold trigger — auto-remove after N reports
Regex pattern matching — advanced text-based rules
AutoMod wiki page — version-controlled rule editing', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #264, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:21:00'::timestamp, now()),
  (265, NULL, NULL, 'Community (Feed and discovery)', 'Add the following:
Home feed
Home feed — posts from joined communities, ranked by algorithm
Popular feed — top posts site-wide regardless of membership
All feed — every public post on the platform
Sort modes — Best / Hot / New / Top / Rising / Controversial
Top time filter — Today / This week / Month / Year / All time
Custom feeds (multistrugs) — user-built multi-community feeds
Hide visited posts — collapse already-seen content
Compact / card / classic view — feed density toggle
Search
Full-text post & comment search — across all public content
Search within a community — scoped to one subreddit
Filter by type — posts / comments / communities / users
Sort search results — relevance / new / top / comments
Time-range filter on search
Search autocomplete — community and user suggestions as you type
Flair filter in search — narrow by post flair within a sub', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #265, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:22:00'::timestamp, now()),
  (266, NULL, NULL, 'Community (Messaging)', 'Add the following:
Inbox
Inbox — unified view: replies, mentions, DMs, mod mail
Unread / all / sent tabs — message state filtering
Mark all as read — bulk clear notification badge
Reply notifications — when someone replies to your post or comment
Mention notifications — u/username tags across the platform
Comment reply chains — full thread context shown in inbox
Direct messages
User-to-user DMs — private messaging between accounts
Message composer — subject + body, markdown supported
Block DMs from non-followers — privacy setting
Report a DM — flag for harassment or spam
DM history — conversation thread view
Disable DMs entirely — only mods can message you
Chat
Real-time chat DMs — live messaging distinct from classic DMs
Community chat rooms — sub-level live group chat channels
Chat room creation — mods can create multiple named channels
Reactions in chat — emoji reactions on individual messages
GIF & image sending in chat
Chat moderation — mods can kick / ban from chat rooms
Chat history — scrollback for community chat channels
Notification controls
Per-community notification settings — all / featured / off
Notify on post replies — toggle per post after commenting
Notify on username mentions — global toggle
Push notifications — mobile, with per-type granularity
Email digest — daily / weekly top posts from joined subs
Unsubscribe from a post''s notifications — without removing comment', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #266, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:23:00'::timestamp, now()),
  (267, NULL, NULL, 'Community (Awards and karma)', 'Add the following:
Awards system
Award tiers — Silver / Gold / Platinum (or custom equivalents)
Community-specific awards — mods create custom awards for their sub
Award gifting — give an award to any post or comment
Award display on posts — stacked icons visible to all
Award notifications — notify recipient when awarded
Award history on profile — given and received
Karma
Post karma — score accumulated from post upvotes
Comment karma — score accumulated from comment upvotes
Karma breakdown on profile — total, post, comment split
Per-community karma — karma earned within a specific sub
Karma use as gate — communities require minimum karma to post
Karma farming detection — anti-abuse classifier
Streak / activity badges — earned for posting/commenting consistently', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #267, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:25:00'::timestamp, now()),
  (268, NULL, NULL, 'Community (safety)', 'Add the following:
User controls
Block user — prevent all interaction and visibility
Mute user — hide their posts and comments from your feed
Report post / comment / user — categorized with community rules mapped
Report flow — sub rules shown alongside global rules
Block list management — view and manage all blocked accounts
Safe browsing mode — filter all NSFW/sensitive content
NSFW content gating — age verification / opt-in required
Image hash matching — detect CSAM and known harmful content
Quarantined communities — require explicit opt-in with warning
Banned communities system — platform-level removal with explanation
Post removal appeals — user appeals to mod team
Platform ban appeals — escalate to trust & safety team
Vote manipulation detection — bot rings, coordinated upvoting
Spam classifier — ML-based auto-flag before mod review
Phone verification option — adds trust signal to account
Shadow removal — content removed but user unaware (spam deterrent)
IP & device fingerprinting — detect ban evasion
Transparency report — public data on removals, bans, legal requests', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #268, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:27:00'::timestamp, now()),
  (269, NULL, NULL, 'Community (admin and analytics)', 'Add the following:
Community & platform analytics
Community stats dashboard — members, active users, post volume
Post performance stats — views, upvote rate, comment count over time
Traffic sources — where visitors come from (search, direct, referral)
Peak activity hours — best time to post in this community
Member growth graph — joins / leaves over time
Top contributors report — most active posters and commenters
Mod action stats — removals, bans, approvals per period', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #269, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:28:00'::timestamp, now()),
  (270, NULL, NULL, 'Videos (Player)', 'Add the following if it does not already exist:
Quality selector — 144p to 4K, HDR, AV1 codec support
Playback speed — 0.25x to 2x in 0.25 steps
Custom speed input better — type any value, e.g. 1.7x
Theater mode — expand player, collapse sidebar
Fullscreen & cinematic mode — true fullscreen + ambient lighting effect
Picture-in-picture — float player while browsing
Mini player — persistent small player at bottom of screen
Loop toggle — repeat single video or playlist
Keyboard shortcuts — J/K/L, arrow keys, M, F, C,
Captions & accessibility
Auto-generated captions — AI transcription in 50+ languages
Manual caption upload — SRT, VTT, SBV file support
Caption translation — auto-translate captions to viewer''s language
Caption style editor — font, size, color, background opacity
Sharing & embedding
Share with timestamp — copy link at current position
Share a clip — select start/end and share a segment
Embed player — iframe with custom size, autoplay, color controls
Share to socials — one-click to Twitter, Facebook, WhatsApp, etc.', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #270, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:33:00'::timestamp, now()),
  (271, NULL, NULL, 'Videos (uploads) Creator side', 'Add if not already there:
Upload system
Multi-video upload better — drag & drop up to 10-50 videos at once
Bulk metadata editor better — set title template, tags, category across all uploads
Upload queue manager — reorder, pause, resume, cancel individual uploads
Background uploading — continue upload while navigating elsewhere
Resumable uploads — pick up where you left off after disconnect
Upload from URL better — import video directly from a public link
Import from Google Drive / Dropbox better — cloud source picker
Formats accepted — MP4, MOV, AVI, MKV, WebM, FLV, WMV, 3GPP
Language setting — primary spoken language of the video
Location tag — optional geo-tag shown on video page
Publishing controls
Visibility — Public / Unlisted / Private / Members only
Scheduled publish — pick exact date and time to go live
Publish to premiere — set a countdown, chat opens early
Age restriction — 18+ gate with platform enforcement
Disable comments — per-video toggle
Hold comments for review — approve before visible
Disable likes display — hide count from viewers
License setting — Standard / Creative Commons
Made for kids flag — COPPA compliance toggle
In-platform editor
Trim start / end — without re-uploading
Cut middle sections — remove segments from published video
Blur tool — face blur or custom region blur
Add end screen — subscribe button, video links, channel link
Add info cards — popups linking to videos, playlists, external URLs
Audio replacement — replace audio track without re-uploading
Subtitle editor — edit auto-captions word by word in browser
Chapter editor — add/edit/remove chapter markers post-upload', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #271, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:36:00'::timestamp, now()),
  (272, NULL, NULL, 'Videos (Analytics)', 'Add if not already there:
Core metrics
Views — total, unique, per-day graph
Watch time — total hours and average view duration
Average view percentage — % of video watched on average
Impressions & CTR — how often thumbnail shown vs clicked
Subscriber delta per video — gained / lost from each upload
Revenue per video — RPM, CPM, estimated earnings
Realtime dashboard — last 48 hours, live view count
Retention analytics
better
Audience retention curve — second-by-second drop-off graph
Segment-level retention — compare retention across chapters
Rewatch heatmap — which moments get replayed most
Drop-off spike alerts better — flag timestamps where viewers leave fast
Intro retention score — % still watching at 30s mark
Hook effectiveness score better — AI rates your first 10 seconds vs similar videos
Retention benchmarks better — compare your curve to category average
Audience analytics
better
Demographics — age, gender, country, device, OS breakdown
New vs returning viewers — loyalty segmentation
Subscriber vs non-subscriber views — how much reach comes from outside your base
Viewer overlap better — which other channels your audience also watches
Audience interest map better — topic clusters your viewers care about
Best posting times — heatmap of when your audience is online
Subscriber source breakdown — which video drove each subscriber wave
Audience sentiment better — AI tone analysis of your comment section
Traffic & discovery analytics
Traffic sources — search, suggested, external, direct, playlist
Top search terms — exact queries that brought viewers to your video
Suggested video sources — which videos referred traffic to yours
External referrers — which websites / apps sent traffic
Playlist contribution — how much watch time each playlist drives
Impression funnel better — impressions → clicks → watch time → subs in one view
Thumbnail A/B test results better — which variant won and by how much
Channel-level analytics
Channel dashboard — 28-day summary of all key metrics
Video performance comparison — rank your videos by any metric
Upload cadence tracker — posts per week, consistency score
Growth velocity better — subscriber growth rate vs 30/60/90 day ago
Revenue trend — monthly earnings graph with breakdown
Predicted milestone dates better — "at current pace, you''ll hit 100k in ~6 weeks"
Reporting & export
CSV / Excel export — any metric, any date range
Scheduled email reports better — weekly digest of top metrics to your inbox
Custom date range comparison — period vs period
Per-video PDF report better — shareable one-page summary for brands / sponsors
API access to analytics data — pull into your own dashboards
Competitor benchmarking better — compare growth rate to similar-sized channels (anonymized)', 'other', 'high', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #272, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:37:00'::timestamp, now()),
  (273, NULL, NULL, 'Videos (Channel page)', 'Add if not already there:
Channel page
Channel home tab — featured video, sections, about
Videos tab — all uploads with sort / filter
Shorts tab — short-form content separated
Live tab — past and upcoming live streams
Playlists tab — all public playlists
Community tab — posts, polls, images
Series tab better — dedicated ordered series with episode view
Merch / shop tab — integrated storefront
About tab — bio, links, join date, country, contact email
Channel customization
Channel banner — responsive art for desktop, mobile, TV
Channel avatar / logo — animated avatar support
Featured video or playlist — different for subscribers vs new visitors
Channel sections — custom rows (single playlist, multiple playlists, recent uploads)
Channel trailer — auto-plays for non-subscribers
Custom channel URL — @handle, vanity URL
Channel watermark — subscribe button overlay on all
Playlists
Create playlist — title, description, visibility, thumbnail
Auto-add videos by keyword better — auto-populate playlist from your uploads
Collaborative playlists — invite others to add videos
Playlist ordering — manual drag, date added, popularity
Save video to playlist — from any video page, multi-select
Watch Later — system playlist, private, always available
Liked videos playlist — auto-populated, private
Playlist analytics — views and watch time driven by each playlist
Multi-channel & team
Multiple channels per account better — manage up to N channels under one login
Channel switcher better — quick-switch in header without re-login
Team / brand account — add managers and editors with role-based access
Role permissions — owner / manager / editor / analyst / viewer
Activity log — who on the team did what and when
Channel transfer — hand ownership to another account', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #273, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:44:00'::timestamp, now()),
  (274, NULL, NULL, 'Videos (Safety)', 'Add if missing:
Content moderation
Policy violation strikes — 3-strike system with escalating consequences
Appeal system — human review of AI/policy removal decisions
Age-restricted content gate — signed-in + age-verified only
Misinformation labels — shown on health, election, climate content
Copyright & DMCA
Content ID system — fingerprint matching against rights-holder library
Claim actions — rights holder can block / monetize / track matches
Dispute a claim — uploader challenges with evidence
DMCA takedown flow — standardized request and counter-notice
Music usage report — which songs are in your video, claim status
Licensed music library — free-to-use tracks with no claim risk (dont know where to find this)
Sound effects library — royalty-free SFX for creator (dont know where to find this)
Creator protection
Comment filter — hold potentially harmful comments for review
Blocked words list — auto-hide comments containing terms
Hide user from channel — prevent someone from commenting
Report a comment — categorized flagging flow
Harassment protection mode better — auto-hold comments from new accounts during spikes
Spam comment bulk delete better — select all from one user and remove
Account & privacy
Location-based content restrictions — geo-block specific videos per country
Active session management — see and revoke devices', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #274, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:48:00'::timestamp, now()),
  (275, NULL, NULL, 'Messaging', 'Add if missing:
Core Messaging
1:1 text messaging — real-time delivery
Group chats — multi-user conversations with admin roles
Message status indicators — sent / delivered / read (single, double, blue ticks equivalent)
Typing indicators — "X is typing..."
Online/last seen status
Message reactions — emoji reactions to individual messages
Reply/quote message — reply to a specific message in a thread
Forward messages — to one or multiple chats
Message editing — with edit history/indicator
Delete for me / Delete for everyone
Pin messages — within a chat
Star/Bookmark messages — save important messages for later
Message search — within a chat or globally
Organization
Chat archiving
Chat muting — per-chat notification control
Labels/folders — categorize chats (e.g., Business, Unread, Favorites)
Pinned chats — keep important chats at top
Unread message filter
Quick replies / canned responses
Polls
Calendar/event sharing
Read receipts toggle — let users disable read receipts', 'other', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #275, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T04:53:00'::timestamp, now()),
  (276, NULL, NULL, 'Decor Shop', 'Decor shop should be the same design as the food delivery BUT THE INFORMATION should NOT be leaking from the food delivery. RIght now the decor profile is leaking from that category.
This shop is designed the same as food delivery, meaning location, image, product etc. When user buys, it gets sent to courier for delivery or rideshare integrated. Location is required so you dont see product from china, this is mainly local.
This means on the Provider dashboard, it should be nearly similar as the food BUT NOT Have the information leaking from there or taken from there. When user clicks on profile it leads to the decor provider profile that shows other stuff they have for sale and not their personal or other profiles on the platform.
2. There are a few parts to decor section: seasonal (which is products which is a similar design to food delivery); Services (which is where users upload the services they offer, designed the same same as temp stay) Shop (designed the same as food delivery but for LOCAL products sale that is integrated in the platform).
ISSUE: each of these require unique profiles or if we combine them how do i, as a user post on the shop directly or on the services directly for users to be able to checkout', 'other', 'medium', 'open', false, 'https://app.strug.ca/decor', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #276, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T05:05:00'::timestamp, now()),
  (277, NULL, NULL, 'Pinboard', 'Currently no way to delete a post on pin board', 'ui', 'medium', 'open', false, 'https://app.strug.ca/pinboard', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #277, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T05:15:00'::timestamp, now()),
  (278, NULL, NULL, 'Laptop Functionality', 'Scroll bar required on laptop for ALL pages and for desktop. Not required for mobile
Do not add double scroll bar. Should be pixel perfect if possible at the very far right corners. Each desktop, laptop page requires ONE scroll bar embedded neatly. So if im watching a video on laptop, i need the scroll bar to scroll down, if i change videos on desktop i need the scroll bar. if i am on temp stay on laptop view i need a scroll bar. Each page laptop, and desktop. Even as new pages are being added, new videos and new content, it should be automatically added', 'ui', 'medium', 'open', false, 'https://app.strug.ca/v/MwzIlVm1-match-the-girl-to-her-bedroom', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #278, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T05:19:00'::timestamp, now()),
  (279, NULL, NULL, 'Referral Code', 'Adding a code does not show the code sometimes in the referral section. It then says already added code', 'bug', 'medium', 'open', false, 'https://app.strug.ca/ref', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #279, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T05:37:00'::timestamp, now()),
  (280, NULL, NULL, 'Wallet and earnings', 'Add the following if not already there:
Earnings Dashboard — Overview
Total lifetime earnings
Earnings this period — daily / weekly / monthly / custom range toggle
Earnings trend graph — line/bar chart over time
Net vs. gross earnings — before/after platform fees, taxes, refunds
Pending earnings vs. cleared earnings
Comparison to previous period — % up/down
Top-earning category this period — highlighted callout
Multi-role summary — if a user is e.g. both a rideshare driver AND an ecommerce seller, show consolidated total + per-role split
Earnings Breakdown by Category/Vertical
Per-vertical earnings table — rideshare, courier, ecommerce, professional services, digital services, creator/subscriptions, rentals (equipment/vehicle/venue), Cameo-style bookings, Book-an-Artist, real estate referrals, charity organizer fees (if any), etc.
Per-vertical % of total earnings — pie/donut chart
Per-listing/per-service breakdown — e.g., earnings broken down by individual property (Airbnb-style), individual gig (Fiverr-style), individual vehicle (Turo-style)
Per-transaction-type breakdown — base fare/price vs. tips vs. bonuses vs. surcharges vs. referral cashback earned
Active vs. passive earnings split — e.g., active (rides driven) vs. passive (subscription/royalty-style, content monetization)
Cross-vertical referral earnings — 1% cashback earned from referral code usage, shown separately
Tips received breakdown — by vertical, by date
Deep Analytics
Earnings per hour worked — for active-work verticals (rideshare, courier, roadside assistance)
Earnings per transaction/order average
Acceptance rate vs. earnings correlation — for matched-work verticals
Cancellation/no-show impact on earnings — lost earnings from cancellations
Peak earning times/days heatmap — when this provider earns most
Earnings by location/zone — for location-based work (rideshare, courier, delivery)
Customer repeat-rate impact on earnings — % of earnings from repeat customers
Rating-to-earnings correlation — does rating affect job volume/pricing
Conversion funnel for sellers — views → cart adds → purchases → revenue (ecommerce/digital services)
Listing performance comparison — for users with multiple listings (property, vehicle, equipment, gigs)
Projected earnings — based on current trend/scheduled bookings
Benchmark vs. similar providers — anonymized comparison (e.g., "you''re earning X% above average for your category/area")
Refund/chargeback impact on net earnings
Payouts
Payout history — full log with date, amount, method, status
Per-transaction payout breakdown — which orders/jobs make up a payout batch
Payout schedule management — daily/weekly/monthly, or instant
Multiple payout destinations — different bank accounts for different business entities/verticals
Transactions & Records
Full transaction ledger — date, amount, description, vertical, status (already in your doc — extending it)
Transaction detail drill-down — tap a transaction to see full job/order context
Transaction filtering — by date range, vertical, status, payment method, amount range
Transaction search
Receipt/invoice download (PDF) — per transaction and bulk export
Dispute a transaction / request adjustment
Adjustment & correction log — visibility into any manual corrections support made', 'other', 'medium', 'open', false, 'https://app.strug.ca/wallet', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #280, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T05:49:00'::timestamp, now()),
  (281, NULL, NULL, 'Referral', 'Referral code earnings tracker — ongoing cashback totals, usage breakdown, usage by code, usage by category, date, time, etc
Referral Overview
Total referral earnings (lifetime) — total cashback earned from people using your code
Referral earnings this period — daily/weekly/monthly/custom toggle, matching the main earnings dashboard pattern
Referral earnings trend graph
Active referred users count — how many people have your code attached and are still active
Total uses of your code (lifetime count)
Pending vs. cleared referral earnings — cashback may be pending until the underlying transaction clears/isn''t refunded
Referral Breakdown by Vertical
Earnings by category — since code can be used on a ride, an ecommerce order, a hotel booking, etc., break down which verticals are generating your referral income
Top-earning vertical from referrals — e.g., "Most of your referral income comes from Rideshare"
Per-referred-user breakdown — how much each specific person you referred has generated for you (with their permission/visibility settings considered)
Average cashback per use
Largest single referral payout — biggest transaction someone used your code on
Referred User Insights
Invited friends list — who signed up using your code (already in doc)
Referred user status — active, dormant, churned (haven''t transacted in X days)
Referred user lifetime value to you — total cashback generated by that one person over time
First-use date per referred user
Most recent use date per referred user — helps spot who''s gone quiet
Referral retention rate — % of people who signed up with your code and are still actively transacting
Code Performance & Funnel
Code share count — how many times you''ve shared your code (via copy, link, social share button)
Share-to-signup conversion rate — of the people you shared it with, how many actually signed up
Signup-to-first-use conversion rate — of people who added your code, how many actually completed a checkout with it
Code views vs. uses — if you have a referral landing page, views vs. conversions
Channel breakdown — where signups came from (copied link, shared code text, social post, QR code if applicable)
Transaction-Level Detail
Referral transaction log — every individual transaction where your code was applied: date, vertical, transaction amount, your cashback amount
Filter referral transactions — by date range, vertical, referred user
Export referral earnings report — CSV/PDF for personal tracking
Anti-Abuse / Integrity Tracking
Self-referral detection — flag/block same-device or same-payment-method signups using your own code
Suspicious pattern alerts — e.g., sudden spike in low-value transactions using your code (potential fraud ring)
One-code-per-checkout enforcement log — visibility into blocked attempts to stack codes
Notifications
New referral signup notification
Cashback earned notification — "You earned $0.42 — your friend just booked a ride"
Referred user inactivity nudge — optional prompt to re-engage someone who used your code once and stopped', 'other', 'medium', 'open', false, 'https://app.strug.ca/wallet', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #281, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T05:51:00'::timestamp, now()),
  (282, NULL, NULL, 'Dashboard, Wallet, Earnings and ref code', 'Add if missing:
Multi-listing portfolio view — for users with properties/vehicles/equipment across categories, a single "portfolio" performance view (like an investment dashboard) showing ROI per asset
Multi-entity consolidated reporting — for a user running a store AND a rental fleet AND freelancing, one combined P&L-style report
Referral — Advanced Analytics
Multi-tier/network referral visualization — if you ever support tiered referrals (your referrals'' referrals), a visual network/tree graph of your downstream network
Viral coefficient (K-factor) — how many new users each of your referred users goes on to refer themselves — measures whether your network is self-propagating
Geographic referral heatmap — where your referred users are concentrated, useful if you''re doing local/in-person sharing
Referral network health score — combines active rate, retention, and growth rate of your referred base into one score
Cross-platform referral funnel decomposition — break the full funnel (impression → click → signup → first use → repeat use) and show drop-off at each stage', 'other', 'medium', 'open', false, 'https://app.strug.ca/wallet', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #282, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T05:57:00'::timestamp, now()),
  (283, NULL, NULL, 'Food Delivery', 'Order and cart tabs in Food are overlapping and blocking each other', 'ui', 'medium', 'open', false, 'https://app.strug.ca/food', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #283, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T08:25:00'::timestamp, now()),
  (284, NULL, NULL, 'Links', 'Can''t open links in new window, new tab due to lack of deep links. Eg. if i am watching a video i cant open that specific video in a new window, tab. Same thing with temp stay and other categoires', 'other', 'medium', 'open', false, 'https://app.strug.ca/v/9d837f6b5e49-one-hour-upload-finalized-test', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #284, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T09:08:00'::timestamp, now()),
  (285, NULL, NULL, 'Food (Analytics)', 'Add if it does not already exist:
Here''s a comprehensive breakdown of everything that belongs in both dashboards, organized by section.
Analytics dashboard
Overview / at-a-glance panel
Total orders today vs yesterday, this week, this month
Revenue today vs same day last week (with % change)
Average order value (AOV) — trended over time
Acceptance rate (orders accepted / orders received)
Cancellation rate, with reasons broken down (customer cancelled, restaurant cancelled, out of stock, etc.)
Preparation time average vs your target
Live order ticker (active orders in real time)
Sales performance
Revenue by hour of day (heatmap or bar) — helps identify peak windows
Revenue by day of week
Revenue by week / month / quarter / year with comparison periods
Top-selling items by revenue and by volume
Item-level trend (rising vs declining sellers)
Category-level breakdown (e.g. mains, drinks, desserts)
Bundle/upsell performance if applicable
Menu item availability rate (how often something was marked unavailable)
Order analytics
Order volume over time (selectable granularity: hourly, daily, weekly)
Orders by channel (in-app, web, etc.) if multiple
New vs returning customer orders
Average items per order
Order funnel: received → accepted → prepared → picked up → delivered (drop-off at each stage)
Failed/rejected order analysis
Repeat order rate per item
Customer insights
New customers vs returning customers ratio
Customer frequency distribution (ordered once, 2-5x, 5x+)
Top customers by order count and by spend
Geographic heatmap of order origins
Average customer rating given to your restaurant
Rating distribution (1–5 star breakdown)
Review volume over time and recent reviews with sentiment
Operational performance
Prep time by order, by hour, by day — with variance
Prep time vs platform target (are you in the green zone?)
Orders where prep time caused delay
Peak hour staffing correlation (if manually entered)
Item-level prep time (which items slow you down)
Order accuracy rate (based on refund/complaint data)
em conversion rate from views to orders (if platform provides impression data)
Items with high views but low conversion (menu optimization signal)
Out-of-stock events per item and frequency', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #285, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T09:26:00'::timestamp, now()),
  (286, NULL, NULL, 'Food Earnings dashboard', 'Earnings summary
Gross sales (before platform fees)
Delivery fee component (if any passes through to you)
Refunds and adjustments deducted
Net earnings = what you actually receive
Pending earnings (orders completed but not yet settled)
Payout history
Full payout ledger: date, period covered, gross, deductions, net
Status per payout: paid, pending, processing, failed
Downloadable payout statements (PDF / CSV) per period
Yearly earnings summary for accounting
Adjustments & disputes
Refunds issued (customer-initiated vs platform-initiated)
Disputed refunds and their resolution status
Error charges (e.g. wrong item, missing item)
Projections & trends
Rolling 30-day earnings trend
This month vs last month vs 3-month average
Earnings by day of week (which days are most profitable)
Projected monthly earnings based on current pace
Scheduled payout date and amount', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #286, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T09:31:00'::timestamp, now()),
  (287, NULL, NULL, 'Temp stay (user side)', 'Add if not already there:
Discovery & search
Search history and saved searches with alert toggle (notify me when new listings match)
Recently viewed listings
Wishlist / saved listings organized into named collections
Personalized recommendations based on past trips and browsing
Map view with price pins and filter overlays
Flexible date search ("I''m flexible" style — show me weekends in July, etc.)
Compare listings side-by-side (up to 3–4 at a time)
Price trend indicator per listing (cheaper / more expensive than usual for these dates)
Booking & reservations
Active bookings with countdown timer to check-in
Upcoming, past, and cancelled trip timeline
Booking request status tracker (pending → approved → confirmed)
Instant book vs request-to-book clarity per listing
Trip itinerary view: check-in instructions, address, host contact, house rules in one place
Add-ons at booking: early check-in, late check-out, parking, luggage storage requests
Modify booking (dates, guest count) with price difference shown before confirming
Cancellation flow with policy shown upfront and refund amount confirmed before proceeding', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #287, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T09:33:00'::timestamp, now()),
  (288, NULL, NULL, 'Temp Stay (Host side)', 'Add if not already there:
Listing management
All listings overview with quick-glance status: live, paused, under review, incomplete
Listing builder / editor: photos (drag to reorder), title, description, amenities checklist, house rules, check-in instructions
Photo manager with cover photo selector and quality tips
Listing preview (see exactly what guests see before publishing
Duplicate listing to create similar properties faster
Pause / deactivate listing with reason (renovation, personal use, seasonal)
Availability & calendar
Calendar view with availability, bookings, and blocked dates
Bulk block dates (personal use, maintenance windows)
Multi-calendar sync (import from Google/Apple/iCal, sync to avoid double-booking across platforms)
Minimum and maximum stay settings (per season, per date range)
Advance notice required before a booking (e.g. 24 hours)
Preparation time between bookings (auto-block 1 day after each stay)
Instant book toggle with guest requirements (verified ID, no negative reviews, etc.)
Pricing & revenue
Base price per night
Weekend pricing override
Seasonal pricing rules (e.g. Dec–Jan premium, off-peak discount)
Smart pricing toggle (platform suggests dynamic pricing based on demand)
Last-minute discount (auto-reduce price X% if still available 2 days before)
Early-bird discount (reduce price if booked 60+ days in advance)
Long-stay discount tiers (7 nights: 10%, 28 nights: 20%)
Custom pricing per individual date
Cleaning fee, extra guest fee, pet fee, security deposit settings
Price comparison vs similar listings in area (benchmarking tool)
Revenue calendar: see projected income by month based on current bookings + open availability
Bookings & reservations
Incoming booking requests with accept / decline + response timer
Active reservations with guest profiles and message threads
Check-in / check-out schedule (today''s arrivals and departures at a glance)
Guest details: verified status, past reviews, number of previous trips
Special requests log per booking (late check-out, crib needed, etc.)
Cancellation management: policy shown, refund to guest calculated, host penalty if applicable
Modify reservation (dates, price adjustment) with guest approval flow', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #288, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T09:35:00'::timestamp, now()),
  (289, NULL, NULL, 'Temp Stay (Analytics)', 'Host analytics — complete sectionOverview scorecard (the first thing they see)
Occupancy rate this period vs last period vs platform average for your area
Revenue this period vs last period (gross and net after fees)
Average daily rate (ADR) vs your own historical baseline and local comp set
RevPAR (revenue per available room/night) — the single most important metric for any accommodation business
Total nights booked vs total nights available
Nights blocked by host (personal use, maintenance) — so they''re excluded from true occupancy calc
Active listings count, with any flagged for low performance
Booking performance
Booking volume over time (selectable: daily, weekly, monthly)
Booking lead time distribution — how many days in advance guests book (histogram: same-day, 1–7 days, 8–30 days, 31–90 days, 90+ days). This directly informs when to apply last-minute discounts
Booking window heatmap — which months get booked earliest vs latest
Length of stay distribution (1 night, 2–3, 4–7, 7–14, 14–28, 28+)
Average length of stay trend over time
Repeat guest rate — percentage of bookings from guests who''ve stayed before
Booking source breakdown (organic search, wishlist save, direct link, platform promotion)
Instant book vs request-to-book ratio, and approval rate on requests
Decline rate with reasons (too short notice, dates blocked, guest unverified, etc.)
Booking gap analysis — how often are there 1–2 night orphan gaps between bookings that are hard to fill? (Suggests adjusting min-stay rules)
Revenue & pricing
Revenue calendar — a full 12-month grid showing actual earned and projected revenue per month, color-coded by performance vs target
ADR by day of week (Monday through Sunday — most hosts underprice weekdays vs weekends relative to demand)
ADR by month (seasonal pattern visualization)
Revenue contribution breakdown per booking: base rate, cleaning fee, extra guest fee, platform adjustments
Discount impact tracker — how much revenue was reduced by early-bird, last-minute, long-stay discounts, and whether those discounts demonstrably increased bookings
Platform promotion participation history — when you joined a promotion, what it cost in rate reduction, and what it returned in bookings
Price sensitivity analysis — did dropping price X% produce more than X% more bookings? (Elasticity view)
Missed revenue calculator — nights that were available but went unbooked, at your listed price. What''s the dollar value of vacancy?
Pacing view — at this point last month / last year, how many nights were already booked for the upcoming 30/60/90 days vs where you are today? (Am I ahead or behind pace?)
Demand & market intelligence
Local demand index — how does search volume and booking demand in your area compare to the same period last year? (Aggregated, anonymized platform data)
Competitor benchmarking — your ADR, occupancy, and review score vs anonymized similar listings (same property type, similar size, same neighborhood, same amenities tier)
Your price rank among comparable listings (are you in the top 25%, middle 50%, bottom 25% of prices for your comp set?)
Peak demand dates — upcoming local events, holidays, and high-demand weekends flagged on the calendar so you can price accordingly
Search impression share — how often does your listing appear in relevant guest searches?
Wishlist save rate — what percentage of listing views result in a save? High saves + low bookings = a pricing or availability problem
Click-through rate from search results to listing page', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #289, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T09:38:00'::timestamp, now()),
  (290, NULL, NULL, 'Temp Stay analytics', 'Add if missing:
Review analytics
Overall rating trend over time (rolling 3-month average, so you can see improvement or decline smoothly)
Rating by category over time: accuracy, cleanliness, communication, location, check-in, value — each as its own trend line
Review sentiment analysis — NLP-extracted positive and negative themes from written reviews (guests repeatedly mention "comfortable bed" as positive, "noisy street" as negative)
Review volume over time (are guests leaving reviews at a consistent rate?)
Review response rate and average time to respond
Superhost / Premier status tracker: live view of your current metrics vs the thresholds, with a "days remaining in assessment period" countdown
Star distribution (1–5 breakdown as a histogram, with % change vs prior period)
Reviews mentioning specific amenities (guests who mention the pool, the coffee machine, the fast WiFi — reveals what''s driving satisfaction)
Comparative review score vs comp set', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #290, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T09:38:00'::timestamp, now()),
  (291, NULL, NULL, 'Temp stay (analytics 3)', 'Add if missing:
Cancellation & reliability
Cancellation rate (host-initiated and guest-initiated) over time
Host-initiated cancellations with reason log and penalty impact record
Guest cancellation rate per listing (high guest cancellations may signal a mismatch in listing description)
Cancellation timing distribution — how far before check-in do cancellations happen? (Last-minute cancellations hit revenue hardest)
Revenue lost to cancellations per period, with recovered vs unrecovered nights
Rebooking success rate — when a cancellation creates an opening, what percentage gets rebooked?
Operational performance
Response rate and average first-response time (both affect search ranking)
Response time distribution: under 1 hour, 1–6 hours, 6–24 hours, 24+ hours
Check-in issue rate — how often do guests report check-in problems (wrong code, lockbox issue, etc.)
Maintenance request frequency — if the platform tracks this, how often are issues flagged per property
Cleaning score (if cleaners are rated or inspections occur)
Early check-in / late check-out request rate and approval rate
Multi-property view (for hosts with 2+ listings)
Portfolio overview: all listings ranked by revenue, occupancy, and review score
Side-by-side comparison of any two listings on any metric
Combined portfolio revenue and occupancy
Underperformer flag — which listing is pulling the portfolio average down?
Pricing consistency check — are comparable listings in your portfolio priced consistently relative to their demand signals?
Calendar conflict detection across properties (if sharing resources like a shared cleaner)', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #291, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T09:39:00'::timestamp, now()),
  (292, NULL, NULL, 'Hotel', 'APPLY all recent document changes from temp stay to hotel as well (from analytics to user side) adapt it specifically for the hotel', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #292, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T09:40:00'::timestamp, now()),
  (293, NULL, NULL, 'Groceries (Analytics)', 'Add if missing::
Analytics — Basic
Overview metrics: total orders, revenue, active users, average order value
Orders over time (daily/weekly/monthly line chart)
Top selling products and categories
Customer acquisition (new vs returning)
Delivery success rate
Peak ordering hours heatmap
Geographic order distribution by zone/neighborhood
Analytics — Advanced
Cohort retention analysis
Customer lifetime value (CLV) segmentation
Funnel analysis (browse → add to cart → checkout → delivered)
Basket analysis / product affinity (frequently bought together)
Churn prediction score by customer segment
Demand forecasting by SKU and category
Pricing elasticity insights
Refund and cancellation root cause breakdown
Real-time order heatmap with live delivery tracking overlay
Marketing attribution (promo codes, referrals, paid channels)
Supply vs demand gap analysis by zone', 'other', 'medium', 'open', false, 'https://app.strug.ca/listing/food/11-dominos-pizza', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #293, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T09:50:00'::timestamp, now()),
  (294, NULL, NULL, 'Groceries (Earnings and wallet)', 'Add if missing:
Earnings and wallet
Total earnings (today / week / month / year / custom range)
Earnings breakdown: delivery fees, tips, surge pay, bonuses, incentives
Per-order earnings detail (tap into any order)
Completed vs cancelled orders and revenue impact
Average earnings per order, per hour, per zone
Payout history with status (paid, pending, failed)
Next payout date and estimated amount
Hours active vs hours earning (utilization rate)
Earnings by day of week and time of day
Weekly earnings comparison (this week vs last week)
Zone-by-zone earnings heatmap (which areas pay more)
Earnings vs platform average benchmarking by tier
Earnings forecast based on historical patterns and upcoming demand signals
Goal setting: daily/weekly targets with live progress
Lifetime earnings milestones
Earnings stability score (variance, consistency rating)
Side-by-side comparison: earnings across multiple weeks or months
Impact of cancellations and low ratings on earnings potential', 'other', 'medium', 'open', false, 'https://app.strug.ca/listing/food/11-dominos-pizza', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #294, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T09:53:00'::timestamp, now()),
  (295, NULL, NULL, 'Strug Drive (Driver side)', 'Add if missing:
Earnings
Real-time earnings ticker (updates as each order completes)
Earnings per trip broken down: base pay, distance pay, time pay, tip, surge, bonus — not just a total
Peak hour earnings overlay on a calendar so drivers know when to go online
Acceptance rate impact on earnings (how declining orders affects bonuses and tier)
Cancellation rate and its direct cost (lost bonuses, tier demotion risk)
Tip rate over time (which order types, zones, and times get tipped more)', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/drive', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #295, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T10:01:00'::timestamp, now()),
  (296, NULL, NULL, 'Strug Drive (Driver side)', 'Add if missing:
Performance
Acceptance rate, completion rate, cancellation rate — all with thresholds and what''s at risk if they drop
On-time delivery rate (picked up on time, delivered on time, separately)
Customer rating: overall score, trend over last 30/90 days, breakdown by category (communication, speed, accuracy)
Rating history per order with customer comment snippets
Low rating alerts with context (which order, what went wrong)
Order accuracy rate (wrong items, missing items flagged by customers)
Response time to new order requests (affects algorithm ranking)
Platform tier or level status (e.g. Gold, Platinum) with exact criteria to maintain or upgrade
Comparative performance: how you rank against other drivers in your zone', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/drive', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #296, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T10:01:00'::timestamp, now()),
  (297, NULL, NULL, 'Strug drive (Driver dashboard)', 'Add if missing:
Trips and Activity
Full trip history with every order detail (pickup, dropoff, distance, time, earnings, tip, customer rating given)
Filter trips by date, zone, order type, earnings, rating
Total distance driven lifetime and per period
Total time online, time on a trip, time idle — broken down clearly
Orders by category (grocery, alcohol, pharmacy, etc.) and which pays better for this driver specifically
Busiest zones map based on the driver''s own history
Average trip duration and distance trends
Longest and highest earning trips logged', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/drive', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #297, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T10:02:00'::timestamp, now()),
  (298, NULL, NULL, 'On demand (worker side)', 'Add UNDER the last square:
Job History and Activity
Full job history with every engagement detail (client, location, job type, duration, pay, rating)
Filter by job type, client, date range, earnings, rating, zone
Jobs accepted vs declined ratio and impact on ranking
Cancellation history with reason codes and client vs worker fault classification
No-show history (worker or client) and resolution outcomes
Repeat client history: how many times you''ve worked for the same client
Job categories worked across and which pay best for this specific worker
Total hours worked lifetime and per period by job type
Scheduling and Availability
Availability calendar: set recurring availability by day and time block
Blackout dates: block days off without affecting standing
Advance job booking: accept jobs days or weeks ahead
Shift preferences: preferred job types, preferred zones, preferred duration
Last-minute availability toggle (signals to the platform you can take urgent jobs)
Demand forecast: when and where jobs are expected in your area
Schedule conflict detection: prevents double-booking
Overtime and hour cap tracking (relevant where labor law limits apply)
Earnings and Compensation
Pay rate visibility by job type before accepting
Earnings breakdown per job: base pay, time pay, complexity bonus, tip, platform bonus
Guaranteed minimums tracker (if platform offers pay floors)
Milestone bonuses: earnings unlocked at job count thresholds
Tip history by job type and client segment
Net earnings after platform fee, with fee rate transparency
Earnings per hour by job category (true efficiency view)
Weekly and monthly earnings comparison
Lifetime earnings milestones', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/work', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #298, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T10:07:00'::timestamp, now()),
  (299, NULL, NULL, 'On demand (worker side) Analytics', 'Add if missing:
ANALYTICS DASHBOARD (deep dive)A. Reliability & Trust Metrics
Acceptance rate — with sub-breakdowns:
By shift type (rush, opening, closing, double, holiday)
By notice period (same-day vs. 1wk+ advance)
By venue (some workers accept Venue A consistently, ghost Venue B)
Trend over rolling 30/60/90 days
Completion rate — shifts started vs. shifts fully completed
Early-leave rate (left before scheduled end, with reason codes)
Late-clock-in rate (with minutes-late distribution, not just binary)
No-show rate, separated from "cancelled with notice"
Cancellation analytics
Cancelled by worker >24h, <24h, <2h (different severity weighting)
Cancelled by venue (shouldn''t count against worker — important to isolate)
Reason code breakdown (sick, scheduling conflict, transportation, etc.)
On-time performance
Average minutes early/late
Clock-in vs. scheduled start delta histogram
Clock-out vs. scheduled end delta (overstaying could indicate unpaid time issues)
Dispute/incident log
Customer complaint count + category (attitude, accuracy, hygiene, theft allegation)
Resolution outcome (dismissed, warning, suspended)
Worker-initiated disputes against venue (unpaid wages, unsafe conditions)', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/work', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #299, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T10:17:00'::timestamp, now()),
  (300, NULL, NULL, 'On demand (worker side) Analytics', 'Add if missing:
Rating & Quality Metrics
Overall average rating + rolling vs. lifetime (rolling shows recent performance, lifetime can mask recent decline)
Rating distribution histogram (5-star %, 4-star %, etc. — not just average, since average hides bimodal patterns)
Category sub-ratings (if you collect them): punctuality, skill/competence, attitude/professionalism, appearance/uniform compliance, communication
Rating velocity (how fast rating is trending — early warning system before it tanks)
Rater segmentation: rating from venue managers vs. rating from customers (if both exist) — these often diverge and both matter
Compliment/tag system (if venues can tag "great with difficult customers," "fast," "team player") — frequency count per tag
Written review sentiment (manual or NLP-based positive/neutral/negative classification)
Outlier flagging — a single 1-star review shouldn''t tank someone with 200 perfect shifts; show statistical context
C. Activity & Utilization
Hours worked: daily / weekly / monthly / YoY comparison
Utilization rate = hours worked ÷ hours available (critical metric — shows if the worker is being under-scheduled relative to their stated availability)
Shift-type mix (% breakfast/lunch/dinner/late- night, % weekday/weekend)
Heatmap: hour-of-day × day-of-week density of shifts worked
Idle gap analysis — average days between shifts, longest gap, gap trend
Geographic spread — how many distinct venues/zones worked, average travel distance per shift
Multi-platform overlap indicator (if you allow it) — shifts declined due to conflicting commitments elsewhere
Claim speed for open-shift marketplace — seconds/minutes from posting to claim (competitive metric in gig markets)
Shift-swap activity (shifts given away vs. picked up from others)', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/work', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #300, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T10:18:00'::timestamp, now()),
  (301, NULL, NULL, 'On demand (worker side analytics)', 'Add if missing:
Skill & Role-Specific Analytics (since "waitress" implies role variety)
Performance broken out per role if the worker is qualified for multiple (server, bartender, host, busser, banquet)---HOW DO WE CALCULATE OR COLLECT THIS
Demand Intelligence (worker-facing, helps them earn more)
Heatmap of high-demand hours/zones in their area
Forecasted shift volume next 7/14 days based on historical venue posting patterns
"Shifts you missed out on" — count + estimated lost earnings from offers expired/declined
Personalized suggestion: "You earn 18% more per hour on weekend dinner shifts — consider shifting availability"
Filtering/Segmentation Controls (applies across the whole dashboard)
Date range picker (custom, presets: 7/30/90/365 days, lifetime)
Filter by venue, role, shift type
Compare two periods side-by-side (this month vs. last month)
Export any chart/table to CSV/PDF', 'other', 'critical', 'open', false, 'https://app.strug.ca/provider/work', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #301, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T10:20:00'::timestamp, now()),
  (302, NULL, NULL, 'On Demand (earnings and wallet)', 'Add if missing (currently connected elsewhere but would be good for this category as well)
EARNINGS / WALLET DASHBOARD (deep dive)
A. Balance States (this needs to be precise — gig wallets often get this wrong)
Available balance (cleared, withdrawable now)
Pending balance (earned but in clearing window — show countdown to availability)
In-dispute balance (earnings frozen due to chargeback/complaint investigation) — separate bucket, clearly labeled, with status/reason
Scheduled balance (estimated earnings from upcoming confirmed shifts, not yet worked — projection, clearly marked as estimate)
Per-Shift Earnings Breakdown (drill-down from any shift)
Base pay (hourly rate × hours, or flat shift rate)
Tips (cash-app tips if pooled through platform, card tips if processed by venue/platform)
Tip-out paid (if worker tips out bussers/bartenders — show as deduction with recipient if tracked)
Aggregate Earnings Views
Daily / weekly / biweekly / monthly / quarterly / annual rollups
Earnings by source type: base pay vs. tips vs. bonuses vs. surge (stacked bar — shows what % of income depends on tips, which is volatile)
Earnings by employer (which employer actually pay well vs. just offer lots of shifts)
Earnings by role (if multi-role)
Effective hourly rate (total earnings ÷ total hours — often more meaningful than base rate alone, since it includes tips)
Earnings volatility indicator (standard deviation week-to-week — helps worker understand income stability)
Year-over-year comparison', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/work', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #302, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-28T10:23:00'::timestamp, now()),
  (303, NULL, NULL, 'Temp Stay', 'Clicking on temp stay (sidebar) takes you to bella floral studio instead of the main temp stay page', 'bug', 'medium', 'open', false, 'https://app.strug.ca/tempstay', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #303, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-29T06:00:00'::timestamp, now()),
  (304, NULL, NULL, 'Temp Stay host side', '1. No image preview on the host side
2. Refreshing the page and trying to edit, all the information disappears and you have to start again', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/host', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #304, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-29T06:55:00'::timestamp, now()),
  (305, NULL, NULL, 'Temp stay', 'It shouldnt be possible to upload a property without an address. The address is NOT shown on the frontend user side and is provided by the host after booking or is provided automatically by platform.
2. Host can replicate a room and edit it for other rooms they may have in the same location', 'other', 'medium', 'open', false, 'https://app.strug.ca/listing/host/77-home-downtown', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #305, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-29T07:00:00'::timestamp, now()),
  (306, NULL, NULL, 'Temp Stay', 'Made 2 listings in temp stay. came back, the listings disappeared. Asked me to register again. The listings still exist on the user frontend side', 'bug', 'high', 'open', false, 'https://app.strug.ca/provider/host', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #306, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-29T07:32:00'::timestamp, now()),
  (307, NULL, NULL, 'Hotels', '1. No property images preview in the hotel when user clicks on the property
2. When creating the property listing on the hotel provider dashboard, it gives you the option to create on listing or one room. But when you go to the user side frontend, and click on the property, it gives you three options Standard. delue and junior suite all at the price you set for one listing.
3. Each property (hotel) should be able to list MULTIPLE rooms under the same property. So if a user clicks on the property, eg. Ritze carlton downtown toronto, they see the rooms available. These rooms when you click on them have their images, own pricing, etc. This means that hotel provider would need a way to modify these parts as well.
checkout flow and everything else should follow from each room', 'other', 'high', 'open', false, 'https://app.strug.ca/hotel', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #307, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-29T07:42:00'::timestamp, now()),
  (308, NULL, NULL, 'Celebrity/talent', 'adding a package does not work. which means on user side, they cant currently order. which means talent is not currently receiving the orders', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/celebrity', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #308, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-29T08:55:00'::timestamp, now()),
  (309, NULL, NULL, 'Provide a service', 'Dashboard conflict: provide a service and become worker seem to both be for on demand
remove provide a service because worker is completely wired', 'bug', 'high', 'open', false, 'https://app.strug.ca/provider', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #309, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-29T09:27:00'::timestamp, now()),
  (310, NULL, NULL, 'Order', 'Received an order from Strug shop. I dont have a strug shop. The order was for $400 but no details regarding it.
2. the app.strug.ca should have the live stripe code so orders cant be placed with the demo 4242424242 card', 'bug', 'high', 'open', false, 'https://app.strug.ca/@seraking', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #310, reported by @Seraphine. Status reset to open pending regression re-verification.', '2026-06-29T20:08:00'::timestamp, now()),
  (311, NULL, NULL, 'Register a restaurant', 'Unable to register a restaurant. All other data previously deleted?', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/food', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #311, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-29T20:59:00'::timestamp, now()),
  (312, NULL, NULL, 'Messages', 'Crashing (something went wrong)', 'bug', 'medium', 'open', false, 'https://app.strug.ca/ref', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #312, reported by @struginc. Status reset to open pending regression re-verification.', '2026-06-29T21:00:00'::timestamp, now()),
  (313, NULL, NULL, 'video cards resize', 'Desktop YouTube video card
Width: ~360px – 400px
Height (thumbnail): ~200px – 225px
Ratio: 16:9
YouTube homepage cards (grid view)
360 × 202 px (approx)
480 × 270 px (approx)
Mobile YouTube cards
Width: screen (~320px – 390px)
Height: ~180px – 220px
Thumbnail standard:
1280 × 720 px (YouTube recommended)
Ratio: 16:9', 'bug', 'critical', 'open', false, 'https://app.strug.ca/videos', 'Chrome 148 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #313, reported by @dev1289s. Status reset to open pending regression re-verification.', '2026-06-29T23:10:00'::timestamp, now()),
  (314, NULL, NULL, 'Community', 'No way to delete community as someone who set it up', 'other', 'medium', 'open', false, 'https://app.strug.ca/community', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #314, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-30T01:02:00'::timestamp, now()),
  (315, NULL, NULL, 'Video card ratio', 'Change video card ratio to 16:9 ratio.
This is standard for every thumbnail so it shows properly', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #315, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-30T03:02:00'::timestamp, now()),
  (316, NULL, NULL, 'Crash (videos creator dashboard)', 'Click content in creator dashboard= crassh', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #316, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-30T03:02:00'::timestamp, now()),
  (317, NULL, NULL, 'Video channels (creators)', '1. ALL videos creator channels currently leading to this page MYTS. With various other videos in here from different channels
2. videos appearing on user side that are still processing instead of after completion', 'bug', 'critical', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #317, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-30T03:15:00'::timestamp, now()),
  (318, NULL, NULL, 'Previous bugs returned', 'Videos
1. Clciking video cuts the video short or stops playing. Eg. a 30 minute video becomes 2:01 when you click to skip to a certain point instead of buffering
2. Right hand "play next limited and repetitit)
3. previous upgrades gone', 'bug', 'high', 'open', false, 'https://app.strug.ca/v/1607', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #318, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-30T03:19:00'::timestamp, now()),
  (319, NULL, NULL, 'Cover Photos', 'Food, groceries, catering, and many catergories have no way to add a cover photo for the store or provider at all', 'other', 'medium', 'open', false, 'https://app.strug.ca/food', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #319, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-30T03:23:00'::timestamp, now()),
  (320, NULL, NULL, 'Classifiers', 'Some categories have classifiers (eg. food delivery) which is fine but there should be a way to see all the products in the store then the classifiers as well (eg. Desserts, main etc)', 'other', 'medium', 'open', false, 'https://app.strug.ca/food', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #320, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-30T03:31:00'::timestamp, now()),
  (321, NULL, NULL, 'Ratings', 'Created a new store and a new food restaurant. My rating was automatically preset to 4.7 stars. This is not reflective of anything', 'other', 'medium', 'open', false, 'https://app.strug.ca/provider/food', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #321, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-06-30T03:36:00'::timestamp, now()),
  (322, NULL, NULL, '[probe] feature category live check', 'Verifying the feature category is accepted on prod after deploy.', 'feature', 'low', 'open', false, NULL, 'Unknown browser · Unknown OS', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #322, reported by @testuser_prod. Status reset to open pending regression re-verification.', '2026-06-30T14:12:00'::timestamp, now()),
  (323, NULL, NULL, 'On Demand worker (Analytics)', 'Dashboard cuts off at the bottom (job by category, top categories) cant be seen', 'feature', 'medium', 'open', false, 'https://app.strug.ca/provider/work', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #323, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-01T02:01:00'::timestamp, now()),
  (324, NULL, NULL, 'Videos', 'Clicking some videos just end the video (eg. Kang video) goes straight to the end', 'bug', 'medium', 'open', false, 'https://app.strug.ca/v/152', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #324, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-01T02:16:00'::timestamp, now()),
  (325, NULL, NULL, 'Insurance and Mortgage', '1. Create a map (have an overlay saying coming soon. This map will show user heat in the area for users who have applied for insurance or are actively looking for insurance/mortgages but have yet to decide. That is the profiles on the left (2).
Profiles on the right (2) will show user''s who have insurance and it is coming to a end soon.
Clicking on these profiles will show how much the user is currently providing, allowing the provider to directly offer a more competitive rate. (no idea how we will structure this)
Same applies for mortgages', 'feature', 'medium', 'open', false, 'https://app.strug.ca/provider/insurance', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #325, reported by @struginc. Status reset to open pending regression re-verification.', '2026-07-01T03:15:00'::timestamp, now()),
  (326, NULL, NULL, 'Opportunities Section', 'Create an opportunities page section for PROVIDERS in categories such as food, groceries, ecommerce, flowers, automotive, real estate, pre construction
1. This will be the map (showing users within the range=just circles not actual addresses) that are actively interacting with certain aspect of the platform. Eg. If a user is looking for food, whether the user has ordered food in the past. This should lead to an indepth analytics that shows you customers who have purchesed from you in the past (no information about them personally) just what they bought, when, new customers, potential customers, customers who have not purchaed from you in a long time, etc From here you should be able to promote your product to them by targeted discounts (just build for now we will clean this up after)', 'feature', 'medium', 'open', false, 'https://app.strug.ca/provider/insurance', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #326, reported by @struginc. Status reset to open pending regression re-verification.', '2026-07-01T03:27:00'::timestamp, now()),
  (327, NULL, NULL, 'Analytics upgrade', 'Upgrade anywhere (provider) where selling is possible:
Customer Analytics (the core of what you asked)
1. Customer segmentation
New customers — first order ever from this restaurant on the platform
Returning customers — 2+ orders
Lapsed/at-risk customers — ordered before but not in X days (define threshold per cuisine/order frequency norms, e.g. 30/60/90 days)
Churned customers — haven''t ordered in 90+ days, statistically unlikely to return without intervention
VIP/power customers — top 10% by order frequency or spend
One-and-done customers — ordered once, never returned (a critical, often-ignored segment — tells you about first-experience failure)
2. Cohort retention analysis
Cohort customers by their first-order month/week, track what % reorder in week 1, month 1, month 3, month 6
Reveals whether retention is improving or decaying over time (e.g. "May cohort retains worse than March cohort — did something change? Menu, price, quality?")
3. Order frequency & recency
Average orders per customer per month
Days between orders (reorder cycle) — lets you time win-back campaigns precisely (e.g. if average gap is 18 days, trigger a nudge at day 21)
RFM scoring (Recency, Frequency, Monetary) — classic but very effective for prioritizing who to target
4. New customer acquisition
New customers over time (daily/weekly trend)
Source of new customers: organic platform search, promoted listing, platform-wide promo, referral
First-order conversion funnel: viewed menu → added to cart → completed order (where are people dropping off?)
First-order item — which dish acts as the best "gateway" dish driving repeat behavior?
5. Win-back & promotion targeting (this is the "promote to" part)
Auto-generated audience lists ready for campaigns:
"Order again" — lapsed customers, suggest a discount/free delivery push
"Try something new" — repeat customers who always order the same 1-2 items (upsell opportunity)
"Almost VIP" — customers one order away from a loyalty threshold
"High value at risk" — high spenders who haven''t ordered recently (highest priority win-back)
Suggested promo type per segment (e.g. new customers respond to % off; lapsed respond to free delivery; loyal respond to early access to new menu items)
Campaign performance tracking: sent → redeemed → resulting order value
6. Customer lifetime value (LTV)
Average LTV per customer, segment, and acquisition source
LTV trend — is it increasing as the restaurant matures on the platform?
CAC vs LTV if restaurant runs paid promotions (is the promo spend worth it?)
7. Geographic/customer distribution
Heatmap of where repeat customers live/work (office lunch crowd vs residential dinner crowd — totally different patterns)
Delivery radius performance — are far-edge customers retaining worse (maybe due to food arriving cold)?
Beyond customers — full operational depth
8. Menu performance
Best sellers vs worst sellers (by volume and by margin if cost data available)
Items that drive repeat orders vs items that are one-off curiosity orders
Items frequently removed from cart (friction signal — price? description? photo?)
Combo/bundle attach rate (do people add drinks/sides when prompted?)
Photo presence/quality correlation with item order rate
9. Pricing & promotions
Average order value (AOV) trend
Discount/promo ROI — incremental orders generated vs margin given up
Price elasticity signals (did a price change affect order volume?)
10. Operational performance
Order accuracy rate (missing/wrong items — huge driver of churn)
Prep time vs platform estimate (consistently late = lower future ranking/visibility, like Uber''s driver score)
Order acceptance rate / rejected orders
Peak hours vs capacity strain (are you losing orders during rush due to auto-pause or long wait times?)
11. Ratings & reviews
Rating trend over time
Review sentiment breakdown (delivery issue vs food quality vs packaging vs price complaints — categorize so it''s actionable, not just a star average)
Correlation between low ratings and reduced reorder rate (quantify the cost of a bad week)
12. Competitive & marketplace position
Search ranking/visibility trend on the platform
Share of category orders in their area (e.g. "you captured 12% of all Thai food orders within 2 miles this month")
Click-through rate from search/browse to menu view', 'feature', 'medium', 'open', false, 'https://app.strug.ca/provider/insurance', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #327, reported by @struginc. Status reset to open pending regression re-verification.', '2026-07-01T03:31:00'::timestamp, now()),
  (328, NULL, NULL, 'Channel Disappeared', 'Channel completely gone from the front end. When i click any video channel, it takes me to a MYTB which has random videos from other channels. Search and other stuff on video section just seem broken.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #328, reported by @iknowayrel. Status reset to open pending regression re-verification.', '2026-07-01T23:35:00'::timestamp, now()),
  (329, NULL, NULL, 'Profile handle', 'Went to edit profile bio. Pressed save changes and got a message saying ""handle already taken" The handle was not being changed. It was just the bio', 'bug', 'high', 'open', false, 'https://app.strug.ca/@struginc', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #329, reported by @struginc. Status reset to open pending regression re-verification.', '2026-07-02T00:20:00'::timestamp, now()),
  (330, NULL, NULL, 'Cover Page (store front food and other categories)', 'Adding cover page in some provider (eg. food, groceries, etc) is not being reflected on the user frontend', 'bug', 'medium', 'open', false, 'https://app.strug.ca/food', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #330, reported by @struginc. Status reset to open pending regression re-verification.', '2026-07-02T00:45:00'::timestamp, now()),
  (331, NULL, NULL, 'Application Errir', 'Some regions are receiving this message for both the website and platform. The security seems to be an issue as well. Could be a domain issue since it ends with .ca but maybe not', 'bug', 'medium', 'open', false, 'https://app.strug.ca/food', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #331, reported by @struginc. Status reset to open pending regression re-verification.', '2026-07-02T02:37:00'::timestamp, now()),
  (332, NULL, NULL, 'Food, groceries, flowers, shop', 'Storefront photo, store banner photo are should not be the same. Perhaps add a "Banner Photo" similar to twitter size or youtube style for these sections', 'feature', 'medium', 'open', false, 'https://app.strug.ca/provider/food', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #332, reported by @struginc. Status reset to open pending regression re-verification.', '2026-07-02T02:59:00'::timestamp, now()),
  (333, NULL, NULL, 'Platform Preview', 'Should allow for platform preview like before. Then when they click anywhere, they are redirected to sign in page. This way new users see what the platform is about just like Leonardo ai approach. 2. Pasting a platform link should let you see what that link is without needing you to sign in. Eg. if i post app.strug.ca/@codezero (i should be able to view the profile) then if i try again, i am redirected to sign in or sign up', 'feature', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #333, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-02T03:09:00'::timestamp, now()),
  (334, NULL, NULL, 'Community (Spaces)', 'https://joebuddencommunity. com/register 
This is a replica of twitter spaces where a group audio discussion is possible. Create an account using a temp mail to see how it works. Ad the feature to the community (reddit replica) section', 'feature', 'medium', 'open', false, 'https://app.strug.ca/v/1280', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #334, reported by @struginc. Status reset to open pending regression re-verification.', '2026-07-02T20:32:00'::timestamp, now()),
  (335, NULL, NULL, 'Search', 'As you are searching in videos or categories, it should show a preview or suggestions of the search like previously. On right hand if video then the videos and on the left hand, creators', 'feature', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #335, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-03T09:07:00'::timestamp, now()),
  (336, NULL, NULL, 'Videos', 'Previously finished videos now show as still processing. All previous banners disappeard. Most previous functions are also gone from video section', 'bug', 'medium', 'open', false, 'https://app.strug.ca/c/10', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #336, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-03T09:08:00'::timestamp, now()),
  (337, NULL, NULL, 'auto minimize missing bug', 'can''t minimize popup window clicking out of popup box (point of UX)', 'bug', 'high', 'open', false, 'https://app.strug.ca/townhall', 'Chrome 148 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #337, reported by @dev1289s. Status reset to open pending regression re-verification.', '2026-07-04T06:18:00'::timestamp, now()),
  (338, NULL, NULL, 'add search bar for tawnhall section', 'add search bar for townhall section for find accounts , posts .', 'other', 'high', 'open', false, 'https://app.strug.ca/townhall', 'Chrome 148 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #338, reported by @dev1289s. Status reset to open pending regression re-verification.', '2026-07-04T15:20:00'::timestamp, now()),
  (339, NULL, NULL, 'Spaces', 'Spaces should show profile of members within that space. Should allow the creator of the space to delete the space. And should have previous discussion saved for replay which can be removed by the creator', 'feature', 'medium', 'open', false, 'https://app.strug.ca/community', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #339, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-05T01:16:00'::timestamp, now()),
  (340, NULL, NULL, 'Video (still processing)', 'A lot of videos display a still processing. If you click on them from creator dashboard, they do not play at all.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/c/10', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #340, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-05T01:17:00'::timestamp, now()),
  (341, NULL, NULL, 'Town Hall (Desktop)', 'Town hall desktop ratio (RATIO image one) is terrible. Desktop ratio 2 (when you click on the post is fine', 'feature', 'medium', 'open', false, 'https://app.strug.ca/townhall/492', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #341, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-05T01:49:00'::timestamp, now()),
  (342, NULL, NULL, 'Video Upload Fail', 'Not possible to upload videos from creator dashboard', 'bug', 'critical', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #342, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-05T01:58:00'::timestamp, now()),
  (343, NULL, NULL, 'Videos', 'Request failed with status code 400
Status when uploading videos. All previous videos not functional', 'bug', 'critical', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #343, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-05T01:59:00'::timestamp, now()),
  (344, NULL, NULL, 'Videos (playing)', 'If a video is playing (mobile) on user leaves the screen, it should continue to play in the background.', 'feature', 'medium', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #344, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-05T04:55:00'::timestamp, now()),
  (345, NULL, NULL, 'Videos (playing)', 'If a video is playing and the user goes to a different category, it should continue playing as a small square until the user clicks off on it', 'feature', 'medium', 'open', false, 'https://app.strug.ca/v/150', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #345, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-05T04:56:00'::timestamp, now()),
  (346, NULL, NULL, 'Town hall', 'Videos in town hall should stop playing if the user scrolls passed them,', 'feature', 'medium', 'open', false, 'https://app.strug.ca/v/150', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #346, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-05T04:56:00'::timestamp, now()),
  (347, NULL, NULL, 'Videos', 'As videos are playing, the recommended seem to be the same ones over and over and it seems to be limited to 5, Should have more commended videos (right side for desktop and laptop) and mobile as the user scrolls', 'feature', 'medium', 'open', false, 'https://app.strug.ca/v/150', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #347, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-05T04:58:00'::timestamp, now()),
  (348, NULL, NULL, 'Shop', 'Delete existing stores, they are bugs that keep reappearing in the shop category', 'feature', 'medium', 'open', false, 'https://app.strug.ca/provider/ecommerce', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #348, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-05T05:04:00'::timestamp, now()),
  (349, NULL, NULL, 'Videos Search', 'When searching the videos section it comes out as <strong>keyword</strong>', 'feature', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #349, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-05T05:07:00'::timestamp, now()),
  (350, NULL, NULL, 'Videos (Up Next)', 'Currently if you click on ANY video, the up next is exactly the same and the number of up next is too small. Need a variety and more up next videos in the videos section', 'feature', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #350, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-05T05:11:00'::timestamp, now()),
  (351, NULL, NULL, 'Videos (playing)', 'Videos stop playing mid way. Skipping to a spot in a video stops playing the video. Videos uploading also fails Some videos display a black screen.', 'bug', 'high', 'open', false, 'https://app.strug.ca/', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #351, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-05T05:15:00'::timestamp, now()),
  (352, NULL, NULL, 'Videos', 'Searching a video and clicking it, video does not play. It shows still processing but these are videos that finished weeks ago
75% of all previously uploaded videos cannot be found, are not accessible or do not play at all', 'bug', 'medium', 'open', false, 'https://app.strug.ca/', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #352, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T05:18:00'::timestamp, now()),
  (353, NULL, NULL, 'Video shorts', 'Shorts are being mixed with main videos. And they don''t play. Videos on home page are showing up as just either most viewed or uploaded time. There should be some assortment probably based. On user', 'feature', 'medium', 'open', false, 'https://app.strug.ca/', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #353, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T05:27:00'::timestamp, now()),
  (354, NULL, NULL, 'Pop up notifications', 'Right now if someone has an order (food, shop freelance work), the receive emails which may take long, maybe a popup notification for these categories that have transactions is required. Clicking on it takes you to that order or category.', 'feature', 'medium', 'open', false, 'https://app.strug.ca/', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #354, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T05:45:00'::timestamp, now()),
  (355, NULL, NULL, 'Shorts full screen', 'Playing shorts (videos) social feed videos and town hall videos should enable full screen on mobile with navigation at the bottom and a way to exit', 'feature', 'medium', 'open', false, 'https://app.strug.ca/', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #355, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T06:03:00'::timestamp, now()),
  (356, NULL, NULL, 'Page loading', 'If you leave the page (eg. Videos) on the phone and go to a different tab website. Coming back, the page does not load anymore', 'feature', 'medium', 'open', false, 'https://app.strug.ca/', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #356, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T06:10:00'::timestamp, now()),
  (357, NULL, NULL, 'Social Feed', 'There is currently no way to record and post a video (story or regular post) on mobile in social feed. Like how on tik tok you can record a clip', 'feature', 'medium', 'open', false, 'https://app.strug.ca/feed', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #357, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T06:15:00'::timestamp, now()),
  (358, NULL, NULL, 'Town hall videos', 'More than one video can be played at the same time. Right now if you play a video in town hall and go to another post that has a video, both videos play', 'bug', 'medium', 'open', false, 'https://app.strug.ca/town-hall', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #358, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T06:33:00'::timestamp, now()),
  (359, NULL, NULL, 'Walkthroigh', 'If walkthrough is skipped it is creating a category called earn. On mobile this category looks odd. So it just be replaced with Seller portal (have to demand this to something better because right now it sounds like just for selling', 'feature', 'medium', 'open', false, 'https://app.strug.ca/provider', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #359, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T06:41:00'::timestamp, now()),
  (360, NULL, NULL, 'Live (streaming) dashboard', 'If you try to set up channel for streamer, it is saying handle ready taken, even if it is your own handle (main profile). It should allow for a unique handle and for you to use your main profile handle as well', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/streamer', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #360, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T07:34:00'::timestamp, now()),
  (361, NULL, NULL, 'Town hall replying', 'replying with an image currently requires you type something, this should not be the case.
also replying with an image does not work', 'feature', 'medium', 'open', false, 'https://app.strug.ca/townhall/1613', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #361, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T10:07:00'::timestamp, now()),
  (362, NULL, NULL, 'Town hall replies', 'unable to delete posted replies', 'feature', 'low', 'open', false, 'https://app.strug.ca/townhall/1613', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #362, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T10:08:00'::timestamp, now()),
  (363, NULL, NULL, 'Videos', 'It says i have 12 videos uploaded but i cant see any of them in the content section of my creator dashboard. when user''s click my profile in video section, they cant see videos and the one they see does not play', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #363, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-05T10:30:00'::timestamp, now()),
  (364, NULL, NULL, 'Stream vs Video dashboard', 'Videos from creator dashboard are leaking into the streamer dashboard. I dont know if this should be kept', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/streamer', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #364, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-05T18:42:00'::timestamp, now()),
  (365, NULL, NULL, 'Crash', 'Constant crash after a few minutes of activity in mobile and full screen', 'bug', 'high', 'open', false, 'https://app.strug.ca/ride', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #365, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T19:00:00'::timestamp, now()),
  (366, NULL, NULL, 'Feed (social)', 'Social feed is coming to an end when scrolling. Even if there are other posts on the feed.
2. Scrolling is currently laggy on mobile version and it blinks each time you scroll down', 'feature', 'medium', 'open', false, 'https://app.strug.ca/feed', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #366, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T19:09:00'::timestamp, now()),
  (367, NULL, NULL, 'Order history', 'Clicking on a previous order should open a section that provides details about that order', 'feature', 'medium', 'open', false, 'https://app.strug.ca/orders', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #367, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T19:22:00'::timestamp, now()),
  (368, NULL, NULL, 'Videos views', 'Views are not being reflected properly on videos. Stuck at either zero or a random number', 'bug', 'medium', 'open', false, 'https://app.strug.ca/v/152', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #368, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T19:25:00'::timestamp, now()),
  (369, NULL, NULL, 'Townhall', 'Clicking on profiles of suggested for you should take you to those profiles', 'feature', 'medium', 'open', false, 'https://app.strug.ca/town-hall', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #369, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T21:10:00'::timestamp, now()),
  (370, NULL, NULL, 'Town hall videos', 'Videos currently play and buffer but can''t skip ahead in the video as it plays', 'feature', 'medium', 'open', false, 'https://app.strug.ca/town-hall', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #370, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T21:26:00'::timestamp, now()),
  (371, NULL, NULL, 'Popup notifications', 'If user not on the platform (using a different app) or is doing something else on the platform, a popup notification is required. Eg. For rideshare drivers, workers, food delivery etc so they can go to it and accept or decline', 'feature', 'medium', 'open', false, 'https://app.strug.ca/', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #371, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T21:35:00'::timestamp, now()),
  (372, NULL, NULL, 'Provider phone', 'Provider portal not aligned on phone', 'feature', 'medium', 'open', false, 'https://app.strug.ca/become', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #372, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T21:46:00'::timestamp, now()),
  (373, NULL, NULL, 'Town hall profile (mobile)', 'Mobile view town hall top left hand corner is the icon Y. It should be replaced with your clickable Profile (and photo)', 'feature', 'medium', 'open', false, 'https://app.strug.ca/town-hall', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #373, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T21:58:00'::timestamp, now()),
  (374, NULL, NULL, 'Mobile. Top right hand', 'Top right hand corner icon should be replaced with a clickable icon of your profile and photo', 'feature', 'medium', 'open', false, 'https://app.strug.ca/', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #374, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-05T22:00:00'::timestamp, now()),
  (375, NULL, NULL, 'Opportunies section', 'Under the opportunities section (anywhere it shows on the platform) there should be a section that shows you the profiles (no location or personal information, such as home address, age etc) of the users who have 1. bought from you before (divided by dates, days, etc), users who have interacted with your products (by day, weeks, etc,), users who interact but have not bought anything, VIP customers( recurring purchases), so on and so forth. This way the provider can directly market to these users by offering them discounts (spefiically for them)', 'feature', 'medium', 'open', false, 'https://app.strug.ca/provider/food', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #375, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-06T01:26:00'::timestamp, now()),
  (376, NULL, NULL, 'Videos', 'Search function not working', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #376, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-06T01:28:00'::timestamp, now()),
  (377, NULL, NULL, 'Something went wrong', 'Constant crash while using on different devices', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #377, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-06T01:28:00'::timestamp, now()),
  (378, NULL, NULL, 'Something went wrong', 'Clicking anything on the platform crashes, including vidoes', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #378, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-06T01:52:00'::timestamp, now()),
  (379, NULL, NULL, 'Townhall (hovering a profile)', 'Hovering a mouse over a profile icon should show the profile (preview) but right now it is only flashing and disappearing', 'feature', 'medium', 'open', false, 'https://app.strug.ca/townhall', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #379, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-06T02:47:00'::timestamp, now()),
  (380, NULL, NULL, 'Videos', 'Can see videos from creators but when you search them up, they dont exist eg. Aninews) the videos for them, the moment you click on it as it is playing, the video stops playing and ends completely', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #380, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-06T03:06:00'::timestamp, now()),
  (381, NULL, NULL, 'Town hall search', 'Add search function at the top or somewhere convenient. It already exist in explore but also connect router to new search', 'feature', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #381, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-06T03:53:00'::timestamp, now()),
  (382, NULL, NULL, 'Video Upload speed', 'Video uploads speed Is VERY VERY slow
-Video should be able to upload quickly and processed in the background. Currently cant leave screen', 'feature', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #382, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-06T07:10:00'::timestamp, now()),
  (383, NULL, NULL, 'Videos', 'Took 20 minutes to upload one video. Upload and processing speed needs to be increased for videos category at all cost', 'feature', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Edge 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #383, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-06T07:24:00'::timestamp, now()),
  (384, NULL, NULL, 'Something went wrong mobile', 'App constant crash', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #384, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-06T07:52:00'::timestamp, now()),
  (385, NULL, NULL, 'Views videos', 'View count not working on any videos.', 'bug', 'medium', 'open', false, 'https://app.strug.ca/v/1593', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #385, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-06T10:05:00'::timestamp, now()),
  (386, NULL, NULL, 'Videos (Creator dashboard content)', 'I have uploaded 40 videos on my creator dashboard but i can only see about 10 of them. I have to delete one to see another one. Also not all my videos are reflected on userside for viewing when my profile is looked up', 'bug', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #386, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-06T20:04:00'::timestamp, now()),
  (387, NULL, NULL, 'Videos', 'Videos still say processing but can be played to a certain extent. If you play them, they automatically cut of after a few minutes (2 minutes) regardless of duration. These videos were working fine before the ACA changes so either the pipeline is broken or they need to be reuploaded', 'bug', 'high', 'open', false, 'https://app.strug.ca/c/10', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #387, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-06T20:33:00'::timestamp, now()),
  (388, NULL, NULL, 'Delete user', 'Please delete this user and their videos 
 Open the feature board →', 'feature', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #388, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-07T02:14:00'::timestamp, now()),
  (389, NULL, NULL, 'Videos', 'Skipping in a video to a certain point before buffering breaks the video and it completely ends to video then starts the play the next video', 'bug', 'critical', 'open', false, 'https://app.strug.ca/v/sHbA3301-a-us-senator-helped-break-this-marine-s-arm-now-he-s-speaking-out', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #389, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-07T02:15:00'::timestamp, now()),
  (390, NULL, NULL, 'Videos (banner)', 'Profile banners not appearing on video creators page 
 Open the feature board →', 'feature', 'medium', 'open', false, 'https://app.strug.ca/c/udy', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #390, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-07T02:17:00'::timestamp, now()),
  (391, NULL, NULL, 'Town hall search', 'Change search router bar tp
GET/search?q= 
 Open the feature board →', 'feature', 'medium', 'open', false, 'https://app.strug.ca/', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #391, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-07T03:21:00'::timestamp, now()),
  (392, NULL, NULL, 'Videos', 'Uploading (processing). If you search creator, and click on their videos (they are still processing) but the videos play in the frontend', 'bug', 'critical', 'open', false, 'https://app.strug.ca/v/crFFUM79-will-her-high-school-sweetheart-cheat-on-her-udy-loyalty-test', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #392, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-07T04:44:00'::timestamp, now()),
  (393, NULL, NULL, 'Video (Buffering and skipping)', 'Trying to skip to a point in any video cuts the video play time and ends the video automatically. Don''t know if this is for all videos', 'bug', 'critical', 'open', false, 'https://app.strug.ca/v/crFFUM79-will-her-high-school-sweetheart-cheat-on-her-udy-loyalty-test', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #393, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-07T04:45:00'::timestamp, now()),
  (394, NULL, NULL, 'Temp Stay (hosted by)', 'Hosted by should show name of the host and the profile photo (temp stay user side) 
 Open the feature board →', 'feature', 'medium', 'open', false, 'https://app.strug.ca/tempstay', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #394, reported by @struguploads. Status reset to open pending regression re-verification.', '2026-07-07T19:15:00'::timestamp, now()),
  (395, NULL, NULL, 'Deleting the account', 'There is currently no way to completely delete my account 
 Open the feature board →', 'feature', 'medium', 'open', false, 'https://app.strug.ca/provider/creator', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #395, reported by @udy. Status reset to open pending regression re-verification.', '2026-07-07T19:28:00'::timestamp, now()),
  (396, NULL, NULL, 'Videos (freezing)', 'Videos keep freezing as they play even though they are buffered', 'bug', 'high', 'open', false, 'https://app.strug.ca/v/ktFX40x1-all-hoes-go-to-heaven-daegen-asfaha-stand-up-comedy', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #396, reported by @tommyg. Status reset to open pending regression re-verification.', '2026-07-08T00:17:00'::timestamp, now()),
  (397, NULL, NULL, 'Featured Videos', 'Featured videos on user frontend does not play', 'bug', 'medium', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #397, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-07-08T03:51:00'::timestamp, now()),
  (398, NULL, NULL, 'User Profile Stats', 'User profile Stats are inaccurate after upgrades. Followers, following and posts all show 0 which is not true', 'bug', 'medium', 'open', false, 'https://app.strug.ca/@codezero', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #398, reported by @ferntv. Status reset to open pending regression re-verification.', '2026-07-08T04:15:00'::timestamp, now()),
  (399, NULL, NULL, 'Social scrolling', 'As you scroll, the stuff on top should disappear to give a full view in mobile 
 Open the feature board →', 'feature', 'medium', 'open', false, 'https://app.strug.ca/feed', 'Chrome 149 · Android', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #399, reported by @codezero. Status reset to open pending regression re-verification.', '2026-07-08T05:04:00'::timestamp, now()),
  (400, NULL, NULL, 'Video Play', 'videos take a long time to play or don''t play at all. including in mobile', 'bug', 'high', 'open', false, 'https://app.strug.ca/videos', 'Chrome 149 · Windows', 'Restored from email archive after the 2026-07-11 factory reset. Original ticket #400, reported by @stgupload. Status reset to open pending regression re-verification.', '2026-07-08T05:05:00'::timestamp, now());

-- 3) point the sequence past everything so new submissions don't collide
SELECT setval(pg_get_serial_sequence('bug_report','bug_report_id'), (SELECT max(bug_report_id) FROM bug_report));

-- verify
SELECT count(*) AS total,
       count(*) FILTER (WHERE bug_report_id BETWEEN 1 AND 400)   AS restored,
       count(*) FILTER (WHERE bug_report_id BETWEEN 401 AND 411) AS renumbered,
       count(*) FILTER (WHERE status = 'open')                   AS open_now
  FROM bug_report;

COMMIT;