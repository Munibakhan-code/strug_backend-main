// services/live-presence.js
//
// THE single source of truth for "how many people are watching session N".
//
// Why this exists: the viewer count used to be read straight from the Redis set
// `stream:<id>:viewers` via SCARD. Prod has never had a managed Redis (see
// utils/redis-client.js), and that client is a Proxy that resolves a safe default
// instead of throwing when it is not connected — SCARD comes back `null`. Nothing
// downstream checked, so every stream on the platform reported 0 viewers: the browse
// grid, the category aggregates, the watch-page pill, the streamer dashboard and the
// admin metrics endpoint were all reading a number that could never be non-zero.
//
// Two callers made it worse by gating on `typeof redis.pipeline === 'function'`, which
// is ALWAYS true — the Proxy returns a wrapped function for every function-valued
// property, so `redis.pipeline()` resolves `null` and the next line (`pipe.scard`)
// throws a TypeError that the surrounding try/catch swallowed. That took the `else`
// branch with them, so those endpoints returned no counts at all.
//
// The fix is to stop treating Redis as required. Prod runs a SINGLE Socket.IO replica
// (index.js) with the in-memory adapter, which means the adapter's room membership is
// not an approximation — it is exact, and it self-heals on disconnect instead of
// relying on the old set's 12h TTL. So: prefer Redis when it is genuinely up (it is
// the only option once we go multi-replica), otherwise walk the room.
//
// When multi-replica lands, replace the room walk with the durable
// `live_viewer_presence` table; this module's interface does not change.
import redis, { isRedisReady } from '../utils/redis-client.js';

const roomFor = (sessionId) => `stream_${sessionId}`;

/**
 * Count distinct viewers in a live session's socket room.
 *
 * The host does not count as a viewer of their own stream (matching the old SADD
 * behaviour in join-stream, which skipped the host).
 *
 * @param {import('socket.io').Server} io
 * @param {number|string} sessionId
 * @param {number|null} hostUserId  live_streamer_profile.user_id of the broadcaster
 * @returns {Promise<number>}
 */
export async function viewerCount(io, sessionId, hostUserId = null) {
    if (sessionId == null) return 0;

    // Redis is authoritative when it is actually connected. `isRedisReady()` is what
    // separates "SCARD says the set is empty" from "SCARD was a no-op that returned
    // null" — without it those two are indistinguishable, which is the whole bug.
    if (isRedisReady()) {
        const n = await redis.scard(`stream:${sessionId}:viewers`);
        if (Number.isFinite(n)) return n;
    }

    const room = io?.sockets?.adapter?.rooms?.get(roomFor(sessionId));
    if (!room) return 0;

    // De-dupe by user: one person with the watch page open in three tabs is one viewer.
    const distinctUsers = new Set();
    let anonymous = 0;
    for (const socketId of room) {
        const s = io.sockets.sockets.get(socketId);
        if (!s) continue;
        if (s.userId != null) {
            if (hostUserId != null && Number(s.userId) === Number(hostUserId)) continue;
            distinctUsers.add(String(s.userId));
        } else {
            // No anonymous sockets today (the global io.use rejects tokenless
            // handshakes). Counted anyway so the anonymous-viewer namespace can land
            // without revisiting this.
            anonymous += 1;
        }
    }
    return distinctUsers.size + anonymous;
}

/**
 * Batched form for list endpoints (browse, category aggregates, admin metrics).
 *
 * Replaces the broken `redis.pipeline()` gate at the call sites. With Redis up this
 * is a real pipeline; without it every lookup is an in-memory room read, so the loop
 * costs nothing and there is no reason to special-case the two paths further.
 *
 * @param {import('socket.io').Server} io
 * @param {Array<{session_id:number, hostUserId?:number|null}>|Array<number>} sessions
 * @returns {Promise<Map<number, number>>} session_id -> viewer count
 */
export async function viewerCounts(io, sessions) {
    const out = new Map();
    if (!Array.isArray(sessions) || sessions.length === 0) return out;

    const rows = sessions.map((s) => (
        typeof s === 'object' && s !== null
            ? { sessionId: s.session_id, hostUserId: s.hostUserId ?? null }
            : { sessionId: s, hostUserId: null }
    ));

    if (isRedisReady()) {
        try {
            const pipe = redis.pipeline();
            // Guard properly this time: the Proxy hands back a wrapped function even
            // when Redis is down, so the only safe probe is whether the object it
            // returns can actually queue commands.
            if (pipe && typeof pipe.scard === 'function' && typeof pipe.exec === 'function') {
                for (const { sessionId } of rows) pipe.scard(`stream:${sessionId}:viewers`);
                const results = await pipe.exec();
                if (Array.isArray(results) && results.length === rows.length) {
                    rows.forEach(({ sessionId }, i) => {
                        const n = Number(results[i]?.[1]);
                        out.set(Number(sessionId), Number.isFinite(n) ? n : 0);
                    });
                    return out;
                }
            }
        } catch (err) {
            console.debug('[live-presence] pipeline unavailable, falling back:', err?.message);
        }
    }

    for (const { sessionId, hostUserId } of rows) {
        out.set(Number(sessionId), await viewerCount(io, sessionId, hostUserId));
    }
    return out;
}
