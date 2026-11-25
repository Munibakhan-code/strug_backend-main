-- Read-only. Why is the town hall bulk lane holding hundreds of messages against a handful of
-- posts that actually want a rendition?
--
-- The Pipeline Live panel can tell us there are N pending posts, but not WHICH they are or what
-- state they are wedged in — and the two candidate explanations (the heartbeat never reaches the
-- DB vs. the sweep keeps resetting the row) look identical from outside. This prints the rows.
--
-- ⚠️ `processing_status NOT IN ('done','error')` is the NULL-EXCLUDING predicate ON PURPOSE — a post
-- predating #415 has a NULL status and plays its raw media_url perfectly well. Widening this to
-- include NULLs would list the entire historical catalogue as "pending" and invite a backfill that
-- would flood the queue. Same predicate as pendingTownHallPostWhere() in utils/video-stall.js.

\echo '===== 1. THE PENDING POSTS — one row each, newest attempt first ====='
SELECT
  post_id,
  processing_status,
  processing_attempts                                             AS attempts,
  round(extract(epoch FROM (now() - created_at))      / 60)::int  AS age_min,
  round(extract(epoch FROM (now() - last_attempt_at)) / 60)::int  AS heartbeat_age_min,
  last_attempt_at,
  left(coalesce(processing_error, ''), 60)                        AS err,
  left(coalesce(media_url, ''), 55)                               AS media
FROM town_hall_post
WHERE media_type = 'video'
  AND media_url IS NOT NULL
  AND hls_url IS NULL
  AND is_banned = false
  AND processing_status NOT IN ('done', 'error')
ORDER BY last_attempt_at DESC NULLS LAST;

\echo ''
\echo '===== 2. GROUPED BY STATUS — is anything actually claimed by a worker? ====='
-- 'processing' with a FRESH heartbeat = a worker owns it and the heartbeat is landing (the fix works).
-- 'processing' with a STALE heartbeat = the worker died, or the heartbeat is not reaching the DB.
-- 'pending'    = enqueued, never started. If these dominate, the sweep is re-minting messages for
--                posts that are merely WAITING in a deep queue — the residual duplicate engine.
SELECT
  coalesce(processing_status, '(null)') AS status,
  count(*)                              AS posts,
  count(*) FILTER (WHERE last_attempt_at IS NULL)                          AS never_attempted,
  count(*) FILTER (WHERE last_attempt_at > now() - interval '15 minutes')  AS heartbeat_fresh,
  count(*) FILTER (WHERE last_attempt_at < now() - interval '45 minutes')  AS heartbeat_stale
FROM town_hall_post
WHERE media_type = 'video'
  AND media_url IS NOT NULL
  AND hls_url IS NULL
  AND is_banned = false
  AND processing_status NOT IN ('done', 'error')
GROUP BY 1
ORDER BY posts DESC;

\echo ''
\echo '===== 3. RECENT COMPLETIONS — is the lane draining at all? ====='
SELECT
  date_trunc('hour', updated_at) AS hour,
  count(*)                       AS completed
FROM town_hall_post
WHERE processing_status = 'done'
  AND hls_url IS NOT NULL
  AND updated_at > now() - interval '12 hours'
GROUP BY 1
ORDER BY 1 DESC;

\echo ''
\echo '===== 4. SANITY — the historical catalogue we must NEVER pull in ====='
-- If a future change "fixes" the NULL exclusion, THIS is the number that would land in the queue.
SELECT
  count(*) FILTER (WHERE processing_status IS NULL)                       AS null_status_legacy_posts,
  count(*) FILTER (WHERE processing_status = 'done')                      AS done_posts,
  count(*) FILTER (WHERE processing_status = 'error')                     AS errored_posts
FROM town_hall_post
WHERE media_type = 'video' AND media_url IS NOT NULL;

\echo ''
\echo '===== 5. DURATION PROFILE — would the ACA cluster path even help? ====='
-- The cluster is gated on DURATION (VIDEO_DISTRIBUTED_MIN_SEC = 600s), not resolution. A high-res but
-- SHORT clip is slow on the 2-vCPU box yet never crosses that gate, so enabling the cluster for town
-- hall would do nothing for it. If would_hit_cluster_10min is ~0, the throughput fix is NOT the
-- cluster — it is preset/resolution/slot policy. Measure before building the big, risky change.
SELECT
  count(*)                                                     AS done_videos,
  count(*) FILTER (WHERE duration_sec >= 600)                  AS would_hit_cluster_10min,
  count(*) FILTER (WHERE duration_sec BETWEEN 120 AND 599)     AS mid_2_to_10min,
  count(*) FILTER (WHERE duration_sec < 120)                   AS short_under_2min,
  round(avg(duration_sec))                                     AS avg_sec,
  max(duration_sec)                                            AS max_sec,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_sec)) AS p95_sec
FROM town_hall_post
WHERE media_type = 'video' AND processing_status = 'done' AND duration_sec IS NOT NULL;

\echo ''
\echo '===== 5b. the longest 10 — is anything genuinely cluster-sized? ====='
SELECT post_id, duration_sec,
       round(extract(epoch FROM (updated_at - created_at)) / 60) AS wall_min_created_to_done
FROM town_hall_post
WHERE media_type = 'video' AND processing_status = 'done' AND duration_sec IS NOT NULL
ORDER BY duration_sec DESC
LIMIT 10;
