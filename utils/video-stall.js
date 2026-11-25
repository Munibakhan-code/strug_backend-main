// utils/video-stall.js
//
// ONE definition of "this video should have transcoded by now, and hasn't".
//
// The reconciliation sweep (which RE-QUEUES these) and the pipeline monitor (which PAGES about
// them) must agree on it. They didn't, and the gap is what produced the 2026-07-14 page:
//
//   monitor:  a video is stuck once it is 30m old with no hls_url.
//   sweep:    re-queue if last_attempt_at IS NULL, or is older than 3h, or the video is 4h+ old.
//
// So a video whose last_attempt_at sat between 30m and 3h ago, created less than 4h ago, matched
// NONE of the sweep's branches — but the monitor counted it from 30m. We paged, hourly, about
// videos the sweep was structurally forbidden from touching, for up to three and a half hours.
// That alert told you something was broken while nothing was even trying to fix it. (The page that
// prompted this said "15 videos" while only 2 were actually in the queue — the other 13 were in
// exactly this hole.)
//
// Sharing the predicate makes the alert honest by construction: the monitor can only ever count
// videos the sweep is actively re-queueing. If one is STILL here an hour later, it is genuinely
// wedged and worth waking someone for.
//
// The predicate is also TOTAL over last_attempt_at — every value falls into exactly one bucket:
//   NULL                      → never attempted; the enqueue was lost      → re-queue
//   older than RETRY_AFTER_MS → an attempt that went quiet; worker is gone → re-queue
//   in the FUTURE             → corrupt stamp; can never be "older than X" → re-queue
//   newer than RETRY_AFTER_MS → legitimately mid-transcode                → LEAVE IT ALONE
// There is no fifth case, so a dead-zone cannot reappear.
//
// ⚠️ Totality is the whole point, and it is fragile: it holds ONLY while every branch keys off
// last_attempt_at. A branch that keys off `created_at` instead is not a fourth bucket, it is a
// SHORT-CIRCUIT — it fires regardless of the heartbeat, so the "leave it alone" case stops being
// reachable and every sufficiently old row becomes permanently stalled by definition.
//
// That is not hypothetical. The backstop was written as `created_at < now - HARD_STUCK_MS`, and on
// 2026-07-14 it meant every town hall post older than four hours was re-queued on every 15-minute
// sweep run, forever, no matter how healthily it was transcoding — ~68 duplicate messages an hour,
// ~680 in the bulk lane against 17 real posts, and a Pipeline Live panel reporting 0 in-flight while
// a post sat mid-encode with a 3-minute-old heartbeat (the sweep kept resetting its status).
//
// Age is not evidence of a stall. It is evidence of age. Do not reintroduce a created_at branch here.

// The worker gives up after this many lifetime attempts and marks the video 'error'. Those are
// surfaced to the creator, not churned here — so both the sweep and the monitor exclude them, and
// we alert only on RECOVERABLE stalls.
export const MAX_ATTEMPTS = 5;

// A video younger than this may legitimately still be transcoding for the first time. Nothing is
// "stuck" before it.
export const GRACE_MS = 30 * 60 * 1000;             // 30 minutes

// An attempt that has gone quiet this long is dead, not slow.
//
// This used to be 3h, chosen to sit beyond the worker's 2h queue visibility timeout so the sweep
// could not enqueue a duplicate while the original message was merely slow. That reasoning is
// obsolete: the worker now dedups by work-unit (inFlightKeys), so a duplicate for a video already
// in flight is DEFERRED rather than processed, and burns no attempt. A duplicate is now cheap, and
// a 3h recovery floor is not — it was the whole dead-zone. 45m matches the worker's own stall
// watchdog (STALL_TIMEOUT_MS): past that, a live worker would have finished or self-terminated.
export const RETRY_AFTER_MS = 45 * 60 * 1000;       // 45 minutes

// Backstop for a corrupt/FUTURE last_attempt_at, which can never be "older than" anything and would
// otherwise hide from the sweep forever.
//
// ⚠️ This used to be expressed as `created_at < now - HARD_STUCK_MS`, which is NOT the same thing and
// cost us the town hall lane (prod, 2026-07-14/15).
//
// The OR below is meant to be TOTAL over last_attempt_at: null → re-queue, stale → re-queue, FRESH →
// leave it alone, it is alive. But `created_at` is not last_attempt_at. As an OR branch it fired for
// EVERY row older than four hours no matter how fresh its heartbeat was — so any post more than 4h
// old was permanently "stalled" by definition, and the "leave a live transcode alone" case could
// never be reached. The sweep re-queued all 17 pending posts on every 15-minute run (~68 messages an
// hour, forever) and reset each one's processing_status to 'pending' — which is why prod's bulk lane
// held ~680 messages against 17 real posts, and why Pipeline Live reported 0 in-flight while post
// 5983 was demonstrably mid-encode with a 3-minute-old heartbeat.
//
// The only value that genuinely cannot satisfy "older than X" is one in the FUTURE. Test for exactly
// that, and nothing else. Age alone is not evidence of a stall — it is evidence of age.
export const HARD_STUCK_MS = 4 * 60 * 60 * 1000;    // 4 hours — retained for callers/tests that report it

/**
 * The recovery branches, shared by both entities so they cannot drift apart.
 *
 * TOTAL over last_attempt_at — every value lands in exactly one bucket, and "fresh" means LEAVE IT
 * ALONE. Nothing here may key off created_at: an old row that is heartbeating is working, not wedged.
 *
 * @param {number} now epoch ms
 */
function recoverableWhere(now) {
    return [
        { last_attempt_at: null },                                   // never attempted; the enqueue was lost
        { last_attempt_at: { lt: new Date(now - RETRY_AFTER_MS) } }, // an attempt that went quiet; worker is gone
        { last_attempt_at: { gt: new Date(now) } },                  // corrupt/future stamp — can never be "older than"
    ];
}

/**
 * Prisma `where` for videos that are recoverably stalled — the sweep re-queues exactly these, and
 * the monitor counts exactly these.
 *
 * NOTE on `processing_status: { not: 'error' }`: processing_status is a NON-nullable column
 * (@default("pending")), so `not` is safe here. Do NOT reach for `notIn` on a NULLABLE column —
 * Prisma compiles it to a bare SQL `NOT IN (...)`, and `NULL NOT IN (...)` is NULL in Postgres, so
 * every NULL row is silently dropped from the result.
 *
 * @param {number} now epoch ms — injected so callers (and tests) control the clock.
 */
export function stalledVideoWhere(now) {
    return {
        hls_url: null,                              // not yet streamable
        status: { not: 'banned' },                  // banned videos shouldn't transcode
        raw_video_url: { not: 'pending_upload' },   // the raw upload actually completed
        processing_status: { not: 'error' },        // terminal failures are the creator's to see
        processing_attempts: { lt: MAX_ATTEMPTS },
        created_at: { lt: new Date(now - GRACE_MS) },
        OR: recoverableWhere(now),
    };
}

/**
 * All Videos-vertical work that still wants an HLS rendition — no age/attempt/heartbeat gate.
 * Pair with getQueueDepths().interactive to separate "normal backlog" from "duplicate flood"
 * (same role as pendingTownHallPostWhere for the bulk lane).
 */
export function pendingVideoWhere() {
    return {
        hls_url: null,
        status: { not: 'banned' },
        raw_video_url: { not: 'pending_upload' },
        processing_status: { notIn: ['done', 'error'] },
    };
}

/**
 * Town hall posts that WANT an HLS rendition and do not have one yet — regardless of how long they
 * have been waiting or how many attempts they have burned. This is the honest denominator: the total
 * outstanding transcode work for town hall.
 *
 * It exists to answer one question the panel could not answer on 2026-07-14: the bulk queue sat flat
 * at ~490 messages while only ~20 posts were stalled, and there was no way to tell whether that was
 * 490 real posts or 20 posts plus 470 duplicate re-queues from the sweep — which need opposite fixes
 * (debounce the sweep vs. raise throughput). Compare `bulk` queue depth against this count: the gap
 * between them IS the duplicate load.
 *
 * DELIBERATELY has no age, attempt, or heartbeat gate — those turn it into "stalled", which is a
 * strict subset (see stalledTownHallPostWhere below, which builds on this). A post created 10
 * seconds ago is real pending work and has a real message sitting in the queue; excluding it would
 * understate the denominator and manufacture a phantom duplicate gap.
 *
 * ⚠️ `processing_status: { notIn: ['done','error'] }` is DELIBERATE, load-bearing, and NOT the Prisma
 * NULL bug it looks like — see the long note on stalledTownHallPostWhere. It is the single reason
 * this predicate does not drag the entire historical town hall catalogue in. Keep it here, in ONE
 * place, and let every caller inherit it.
 */
export function pendingTownHallPostWhere() {
    return {
        media_type: 'video',
        media_url: { not: null },                        // something was actually uploaded
        hls_url: null,                                   // no rendition yet
        is_banned: false,                                // moderated posts shouldn't transcode
        processing_status: { notIn: ['done', 'error'] }, // NULL-excluding ON PURPOSE — see below
    };
}

/**
 * The same predicate for TOWN HALL posts, which ride the same transcode pipeline (#415).
 *
 * "Stalled" = PENDING (above) + old enough to have finished + still has attempts left + its last
 * attempt has gone quiet. It is a strict subset of pendingTownHallPostWhere by construction, which
 * is what lets the panel subtract one from the other and mean something.
 *
 * The town hall sweep carried all the same defects the video sweep did, plus one of its own:
 *
 *   1. NO backstop for a corrupt/future last_attempt_at. `lt: staleCutoff` is never true for a
 *      future timestamp, so such a post was invisible to the sweep FOREVER.
 *   2. The same obsolete 3h recovery floor (see RETRY_AFTER_MS — the worker dedups now, so a
 *      duplicate is deferred rather than processed, and waiting 3h buys nothing).
 *   3. NO grace window. The create path enqueues the post and sets processing_status='pending' but
 *      never stamps last_attempt_at — so a brand-new post has last_attempt_at NULL, and the very
 *      next sweep re-enqueued it on top of the enqueue that had just happened. Every single town
 *      hall video was double-queued as a matter of course, which is precisely the kind of churn
 *      that buried the video lane on 2026-07-14. The GRACE_MS gate below closes it: the sweep is a
 *      safety net for a LOST enqueue, and it cannot tell the difference in the first 30 minutes.
 *
 * ⚠️ `processing_status: { notIn: ['done','error'] }` here is DELIBERATE and load-bearing, and it is
 * NOT the Prisma NULL bug it looks like. town_hall_post.processing_status is NULLABLE, and Prisma
 * compiles notIn to a bare `NOT IN (...)` — so `NULL NOT IN (...)` is NULL in Postgres and every
 * NULL-status row is silently EXCLUDED. That is exactly what we want: a post predating #415 has a
 * NULL status and plays its raw media_url perfectly well. Including them would drag the entire
 * historical town hall catalogue into the transcode queue as an unrequested backfill. Do not
 * "fix" this into an `OR: [{ processing_status: null }, ...]` — see [reference] the 2026-07-14
 * incident, where the flood was blamed on exactly that misreading.
 *
 * @param {number} now epoch ms
 */
export function stalledTownHallPostWhere(now) {
    return {
        ...pendingTownHallPostWhere(),               // wants a rendition, hasn't got one
        processing_attempts: { lt: MAX_ATTEMPTS },
        created_at: { lt: new Date(now - GRACE_MS) },
        OR: recoverableWhere(now),
    };
}
