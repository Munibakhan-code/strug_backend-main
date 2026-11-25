-- Read-only. Prod content + video-pipeline state.
\pset pager off
SELECT 'user'                AS table, count(*) FROM "user"
UNION ALL SELECT 'video',              count(*) FROM video
UNION ALL SELECT '  video: playable',  count(*) FROM video WHERE hls_url IS NOT NULL
UNION ALL SELECT '  video: processing',count(*) FROM video WHERE hls_url IS NULL
UNION ALL SELECT 'channel',            count(*) FROM channel
-- social_feed holds real user posts. `social_post` is an unrelated campaign/marketing table
-- (title / account_id / campaign_id) — counting it reports 0 posts on a platform that has them.
UNION ALL SELECT 'social_feed (posts)', count(*) FROM social_feed
UNION ALL SELECT 'community_post',     count(*) FROM community_post
UNION ALL SELECT 'product_listing',    count(*) FROM product_listing
UNION ALL SELECT 'rental_listing',     count(*) FROM rental_listing
UNION ALL SELECT 'work_category',      count(*) FROM work_category
UNION ALL SELECT 'service_category',   count(*) FROM service_category
UNION ALL SELECT 'bug_report',         count(*) FROM bug_report
ORDER BY 1;

-- Why is nothing playable? Show every video row's pipeline state.
\echo '--- video rows (pipeline state) ---'
SELECT video_id,
       left(coalesce(title,'(null)'), 24)            AS title,
       processing_status,
       processing_attempts                            AS tries,
       status,
       CASE WHEN raw_video_url IS NULL      THEN 'NULL'
            WHEN raw_video_url = ''         THEN '(empty)'
            WHEN raw_video_url = 'pending_upload' THEN 'pending_upload'
            ELSE 'blob-url' END                       AS raw_video_url,
       CASE WHEN hls_url IS NULL THEN 'NULL' ELSE 'set' END AS hls_url,
       created_at
  FROM video
 ORDER BY video_id;

-- Rows the requeue script would refuse to touch, and why.
\echo '--- requeue eligibility ---'
SELECT count(*) FILTER (WHERE hls_url IS NULL)                                    AS not_streamable,
       count(*) FILTER (WHERE hls_url IS NULL AND raw_video_url = 'pending_upload') AS blocked_pending_upload,
       count(*) FILTER (WHERE hls_url IS NULL AND raw_video_url IS NULL)            AS blocked_null_raw,
       count(*) FILTER (WHERE hls_url IS NULL AND status = 'banned')                AS blocked_banned,
       count(*) FILTER (WHERE hls_url IS NULL AND raw_video_url NOT IN ('pending_upload','')
                              AND raw_video_url IS NOT NULL AND status <> 'banned') AS requeueable
  FROM video;
