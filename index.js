import 'dotenv/config';
// Crash reporting must come up before any other module can throw. No-op without SENTRY_DSN.
import { initObservability, captureError, flushObservability } from './utils/observability.js';
initObservability();

// Route the ~1,900 existing console.* calls through Winston, so they carry a level, a timestamp
// and the request's correlation id instead of going to raw stdout. One bridge instead of 1,900
// rewritten call sites. Installed before any module can log.
import { installConsoleBridge } from './utils/console-bridge.js';
installConsoleBridge();
//import libraries
import { Server } from 'socket.io';
import http from 'http';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import { BlobServiceClient } from '@azure/storage-blob';
import prisma from './utils/prisma-client.js';
import redis, { isRedisReady } from './utils/redis-client.js';
import { app, corsOptions, PORT } from './app.js';
import { buildTripLocationPayload, isTripPartyUser, publishDriverTripLocation } from './utils/trip-socket.js';
import { publishDeliveryLocation } from './utils/delivery-location.js';
import { logMailStartupStatus } from './services/email-service.js';
import { logCriticalSecrets } from './utils/startup-secrets.js';
import { initGhostDriverCron } from './utils/cron-jobs.js';
import { logCronInventory } from './utils/cron-inventory.js';
import { notifyVideoTerminal, startVideoNotifyCron } from './services/video-notify.js';
import { logEmailTemplateInventory } from './scripts/email-template-registry.js';
import { logCronError } from './utils/cron-email.js';
import { initRecommendationCron } from './utils/recommendation-cron.js';
import { startMediaCleanupCron } from './workers/townhall-media-cleanup.js';
import { startRideTimeoutCron } from './utils/ride-timeout-cron.js';
import { startRideDispatchCron } from './utils/ride-dispatch.js';
import { startDeliveryDispatchCron } from './utils/delivery-dispatch.js';
import { startRideNoShowCron } from './utils/ride-noshow-cron.js';
import { startRideScheduleCron } from './utils/ride-schedule-cron.js';
import { startScheduledChatCron } from './utils/scheduled-chat-cron.js';
import { startWorkDispatchCron } from './utils/work-dispatch.js';
import { startQuoteExpiryCron } from './utils/quote-dispatch.js';
import { startPropertySavedSearchCron } from './utils/property-saved-search-cron.js';
import { startJobSavedSearchCron } from './utils/job-saved-search-cron.js';
import { startMailOutboxCron } from './utils/mail-outbox-cron.js';
import { startVideoReconciliationCron } from './workers/video-reconciliation.js';
import { startVideoSyntheticProbeCron } from './workers/video-synthetic-probe.js';
import { startVideoCategoryClassifierCron } from './workers/video-category-classifier.js';
import { startVideoPipelineMonitorCron } from './utils/video-pipeline-monitor.js';
import { startLiveSessionSweep } from './workers/live-session-sweep.js';
import { dbRedisConsistencyHeartbeat, resetDailyBudgetCron } from './utils/ads-delivery-engine.js';
import { registerChatSocketHandlers } from './sockets/chat-socket.js';
import { registerSpaceSocketHandlers } from './sockets/space-socket.js';
import { registerStaffChatHandlers } from './sockets/staff-chat-socket.js';
import { classifySocketToken, assertSocketUserAllowed } from './sockets/socket-auth.js';
import { staffOnline, staffOffline } from './sockets/staff-presence.js';
import { markOnline, markOffline, filterOnline } from './utils/presence.js';
import { getChatPeerIds } from './services/chat-service.js';
import { getChatPolicy, chatRejectDetail } from './services/live-chat-policy.js';
import { isSubscribed } from './services/live-subscription.js';
import { viewerCount } from './services/live-presence.js';
import { resolveCourierDriverForUser } from './utils/driver-identity.js';
import { startSocialModerationPurgeCron } from './workers/social-moderation-purge-cron.js';


const server = http.createServer(app);

const io = new Server(server, {
  cors: corsOptions
});

// Cross-replica fan-out capability (dormant by default). Socket.IO holds each connection in
// one process's memory, so with >1 backend replica a message only reaches clients on the same
// replica. A Redis adapter relays room emits across replicas. Prod runs a single replica today
// and has no managed Redis — so this stays IN-MEMORY unless REDIS_URL is set, at which point it
// attaches with zero code change. Failures fall open to in-memory (never block boot).
async function maybeAttachRedisAdapter(ioServer) {
  const url = process.env.REDIS_URL;
  if (!url) return; // single-replica default
  try {
    const [{ createAdapter }, RedisMod] = await Promise.all([
      import('@socket.io/redis-adapter'),
      import('ioredis'),
    ]);
    const Redis = RedisMod.default;
    const pubClient = new Redis(url, { maxRetriesPerRequest: null });
    const subClient = pubClient.duplicate();
    pubClient.on('error', () => {});
    subClient.on('error', () => {});
    ioServer.adapter(createAdapter(pubClient, subClient));
    console.log('[socket] Redis adapter attached — cross-replica fan-out enabled');
  } catch (err) {
    console.warn(`[socket] Redis adapter unavailable, staying in-memory: ${err.message}`);
  }
}
maybeAttachRedisAdapter(io);

app.set('io', io);
initGhostDriverCron(io);

startSocialModerationPurgeCron();
initRecommendationCron();
startRideTimeoutCron(io);
startRideDispatchCron(io);
startDeliveryDispatchCron(io);
startRideNoShowCron(io);
startRideScheduleCron(io);
startScheduledChatCron(io);
startWorkDispatchCron(io);
startQuoteExpiryCron();
startPropertySavedSearchCron(io);
startJobSavedSearchCron(io);
startMailOutboxCron();
// NOTE: the former in-process video-moderation-worker was REMOVED. It consumed the
// same `video-tasks` queue as the standalone strug_worker (the transcoder) and deleted
// messages after a no-op thumbnail scan, racing the transcoder and orphaning videos
// (no hls_url → filtered out of every feed). Moderation is now owned solely by the
// transcode worker (Azure Content Safety over sampled frames). This cron only re-queues
// videos whose transcode was lost/stalled — it never consumes the queue.
startVideoReconciliationCron();
// Tells a creator their upload finished (or failed). Separate from the sweep above on purpose:
// that one is gated on Azure creds and ticks every 15m, and the worker→API Redis bridge is
// INACTIVE in prod. This is a plain DB poll, so it is the only path that actually notifies
// production creators — who otherwise sit on "processing" with no signal, ever.
startVideoNotifyCron(io);
// Daily 2 AM sweep that deletes orphaned Town Hall media blobs (uploads with no surviving
// post) so activated town-hall media doesn't accumulate storage cost.
startMediaCleanupCron();

// Synthetic canary: pushes a tiny test clip through the real upload→transcode→HLS path on an
// interval and asserts HLS comes back, covering the blind spot where signals 1–2 see nothing
// because no real video was uploaded. OFF unless VIDEO_SYNTHETIC_PROBE_ENABLED=true +
// VIDEO_PROBE_CHANNEL_ID set; cleans up its own test videos. Its result feeds the monitor below.
startVideoSyntheticProbeCron();


// Fills a content-based category (Music/Gaming/Sports/…) on videos the creator left on "Auto"
// (category=NULL). Layered: a no-LLM keyword heuristic by default, plus a multimodal Gemini pass
// (thumbnail frame + title/description) on ambiguous cases when GOOGLE_API_KEY is set. Runs after
// HLS is ready so any LLM pass classifies on a real frame.
startVideoCategoryClassifierCron();

// Watches the independent signals that the last outages failed silently on — the sweep heartbeat,
// the stuck-video backlog, and the synthetic probe — and emails VIDEO_ALERT_EMAIL when any goes
// bad (and when it recovers). Read-only; never touches the queue. Turns silent transcode
// degradation into a page before users notice.
startVideoPipelineMonitorCron();

// Safety net: clean up orphaned live sessions (never-published STARTING rows, and LIVE
// sessions whose MediaMTX notReady hook was lost) so discovery stays accurate.
startLiveSessionSweep(io);

// Ensure the raw video and thumbnail containers allow public blob read so browsers can stream and view assets directly.
// This is a one-time idempotent operation; safe to call on every startup.
// Initialize Azure Blob Storage containers with public read access
if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
    const bsc = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);

    const targetContainers = [
        process.env.AZURE_RAW_VIDEO_CONTAINER,
        process.env.AZURE_THUMBNAIL_CONTAINER,
        process.env.AZURE_LIVE_VOD_CONTAINER,
        process.env.AZURE_SOCIAL_POSTS_CONTAINER,
        process.env.AZURE_TOWNHALL_POSTS_CONTAINER || 'townhall-posts',
    ].filter(Boolean);

    for (const containerName of targetContainers) {
        const containerClient = bsc.getContainerClient(containerName);
        containerClient.createIfNotExists({ access: 'blob' })
            .then(() => containerClient.setAccessPolicy('blob').catch(() => {}))
            .catch((err) => console.error(`[azure-init] Container setup failed (${containerName}):`, err.message));
    }
}


setInterval(() => {
  dbRedisConsistencyHeartbeat().catch((err) => logCronError('ads-redis-heartbeat', err));
}, 60000);

cron.schedule('0 0 * * *', () => {
  resetDailyBudgetCron(io).catch((err) => logCronError('ads-daily-budget-reset', err));
});



logCronInventory();
logEmailTemplateInventory();

io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
        const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_KEY);
        // Keep the two identity systems strictly separate: a board (staff) token becomes
        // socket.member ONLY (never socket.user), an app-user token becomes socket.user ONLY.
        // A board token therefore can never join a user-<id> room, and vice-versa.
        // App-user connections also pass the same account/session gate as HTTP auth so
        // deleted/suspended/force-logged-out users cannot stay on realtime channels.
        const gate = await assertSocketUserAllowed(decoded);
        if (!gate.ok) return next(new Error(gate.error || 'Invalid token'));
        const cls = gate.classification || classifySocketToken(decoded);
        if (cls.kind === 'board') socket.member = decoded;
        else socket.user = decoded;
        next();
    } catch {
        next(new Error('Invalid token'));
    }
});

const VIEWER_SET_TTL_SEC = 12 * 60 * 60;

// H4: unconditional minimum interval between chat messages from a single socket, independent
// of the streamer's (optional) slow-mode. Caps the per-socket DB amplification of stream-chat.
const CHAT_MIN_INTERVAL_MS = 500;

// Slow-mode state for the Redis-less path, keyed `${session_id}:${user_id}` so it survives a
// user having several tabs open (a per-socket Map would let each tab post at full speed).
// Module scope on purpose: prod is a single Socket.IO replica, so this map IS the whole
// platform's view. Swept lazily to keep it from growing without bound.
const slowModeUntil = new Map();
const SLOW_MODE_SWEEP_EVERY = 500;
let slowModeWrites = 0;
function slowModeBlocked(sessionId, userId, windowMs) {
    const key = `${sessionId}:${userId}`;
    const now = Date.now();
    if (++slowModeWrites % SLOW_MODE_SWEEP_EVERY === 0) {
        for (const [k, until] of slowModeUntil) if (until <= now) slowModeUntil.delete(k);
    }
    if ((slowModeUntil.get(key) ?? 0) > now) return true;
    slowModeUntil.set(key, now + windowMs);
    return false;
}

// M11: chat text never passes through the Express sanitizeInput middleware (sockets bypass it).
// Neutralise markup and strip control characters server-side as defense-in-depth before the
// text is persisted and re-broadcast to the room.
const sanitizeChatText = (s) =>
    String(s).replace(/[<>]/g, '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();

io.on('connection', (socket) => {
    // Board (staff) socket — a disjoint identity. Its own room + handlers, and it returns
    // before ANY user-side logic so a staff session never joins a user room or runs user
    // chat/presence handlers.
    if (socket.member?.member_id) {
        const mid = socket.member.member_id;
        socket.join(`board-member-${mid}`);
        staffOnline(mid);
        registerStaffChatHandlers(io, socket);
        socket.on('disconnect', () => staffOffline(mid));
        return;
    }

    const uid = socket.user?.user_id;
    if (uid) {
        socket.join(`user-${uid}`);
    }

    registerChatSocketHandlers(io, socket);
    registerSpaceSocketHandlers(io, socket);

    // #275 online presence. Ref-count this user's live sockets in memory. Presence is only
    // ever exposed via an authenticated, peer-scoped query (below) and pushed only to a
    // user's own chat peers — never broadcast platform-wide — so it can't be used to probe
    // arbitrary accounts. On the online/offline edge, notify just this user's chat peers on
    // their private `user-<id>` rooms.
    async function emitPresenceToPeers(online) {
        if (!uid) return;
        try {
            const peerIds = await getChatPeerIds(uid);
            for (const peerId of peerIds) {
                io.to(`user-${peerId}`).emit('presence-changed', { user_id: uid, online });
            }
        } catch (err) { console.debug('[presence] peer fan-out failed:', err?.message); }
    }
    if (markOnline(uid)) emitPresenceToPeers(true);
    // Snapshot query: authenticated only, input-bounded, and intersected with the caller's
    // actual chat peers so it can never enumerate arbitrary users' online status.
    socket.on('presence_query', async (data, ack) => {
        const respond = (payload) => { if (typeof ack === 'function') ack(payload); else socket.emit('presence-snapshot', payload); };
        if (!uid) { respond({ ok: false, online: [] }); return; }
        const requested = Array.isArray(data?.user_ids) ? data.user_ids.slice(0, 300).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
        if (!requested.length) { respond({ ok: true, online: [] }); return; }
        try {
            const peers = new Set(await getChatPeerIds(uid));
            const allowed = requested.filter((id) => peers.has(id));
            respond({ ok: true, online: filterOnline(allowed) });
        } catch (err) {
            console.debug('[presence] query failed:', err?.message);
            respond({ ok: false, online: [] });
        }
    });
    socket.on('disconnect', () => {
        if (markOffline(uid)) emitPresenceToPeers(false);
    });

    // Couriers join a shared `couriers` room while online so new unassigned orders
    // can be pushed to registered couriers only (not broadcast to every client).
    socket.on('courier-online', async () => {
        if (!uid) return;
        try {
            const provider = await resolveCourierDriverForUser(uid);
            if (provider?.accepts_courier) socket.join('couriers');
        } catch (err) { console.debug('[courier-online] provider check failed:', err?.message); }
    });
    socket.on('courier-offline', () => socket.leave('couriers'));

    socket.on('join-stream', async (data) => {
        const { session_id } = data || {};
        if (!session_id) return;
        const user_id = socket.user?.user_id;

        let session;
        try {
            const sid = Number(session_id);
            if (!sid || Number.isNaN(sid)) return;
            session = await prisma.live_session.findUnique({
                where: { session_id: sid },
                select: { status: true, streamer: { select: { user_id: true } } },
            });
            if (!session || !['STARTING', 'LIVE'].includes(session.status)) return;
        } catch (err) {
            console.debug('[join-stream] session liveness check failed:', err?.message);
            return;
        }

        const roomName = `stream_${session_id}`;
        const sidStr = String(session_id);
        socket.join(roomName);
        socket.currentStream = session_id;
        socket.userId = user_id;
        socket.liveHostUserId = session.streamer?.user_id ?? null;
        if (!socket.joinedStreams) socket.joinedStreams = new Set();
        socket.joinedStreams.add(sidStr);

        try {
            const viewersKey = `stream:${session_id}:viewers`;
            const hostUserId = session.streamer?.user_id ?? null;
            const isHost = user_id && hostUserId === user_id;
            // Keep feeding the Redis set while it is genuinely up — it is what a
            // multi-replica deployment will read. When it is not, viewerCount() falls
            // back to this replica's socket room, which is exact today.
            if (user_id && !isHost) {
                await redis.sadd(viewersKey, user_id);
            }
            // Anonymous presence_id counting removed: io.use requires a token, so the
            // anon branch never ran for real viewers; client-chosen ids also never left the set.
            await redis.expire(viewersKey, VIEWER_SET_TTL_SEC);
            const count = await viewerCount(io, session_id, hostUserId);
            io.to(roomName).emit('viewer-count-updated', { session_id, count });
        } catch (err) {
            console.debug('[join-stream] viewer-count broadcast failed:', err?.message);
        }
    });

    // Remove the socket's user from one stream's viewer set and broadcast the new count.
    const leaveStreamRoom = async (session_id, userId) => {
        if (!session_id || !userId) return;
        socket.joinedStreams?.delete(String(session_id));
        // Leave the room BEFORE counting: viewerCount() reads room membership when
        // Redis is absent, so counting first would still include this socket.
        socket.leave(`stream_${session_id}`);
        try {
            await redis.srem(`stream:${session_id}:viewers`, userId);
            const count = await viewerCount(io, session_id, socket.liveHostUserId ?? null);
            io.to(`stream_${session_id}`).emit('viewer-count-updated', { session_id, count });
        } catch (err) { console.debug('[leave-stream] viewer-count broadcast failed:', err?.message); }
    };

    socket.on('leave-stream', async (data) => {
        const session_id = data?.session_id ?? socket.currentStream;
        await leaveStreamRoom(session_id, socket.userId);
    });

    socket.on('join-trip', async (tripId) => {
        try {
            const uid = socket.user?.user_id;
            if (!uid) return;
            const tid = Number(tripId);
            if (!tid || Number.isNaN(tid)) return;
            const allowed = await isTripPartyUser(tid, uid);
            if (!allowed) return;
            socket.join(`trip_${tid}`);
            const trip = await prisma.active_trip.findFirst({
                where: { trip_id: tid, ended_at: null },
                select: {
                    driver_profile: { select: { current_lat: true, current_long: true } },
                },
            });
            const lat = trip?.driver_profile?.current_lat;
            const lng = trip?.driver_profile?.current_long;
            if (lat != null && lng != null) {
                socket.emit('driver-location-updated', buildTripLocationPayload(tid, lat, lng));
            }
        } catch { }
    });

    socket.on('leave-trip', (tripId) => {
        const tid = Number(tripId);
        if (tid && !Number.isNaN(tid)) socket.leave(`trip_${tid}`);
    });

    socket.on('join-work-room', ({ buyer_id }) => {
        if (buyer_id && Number(buyer_id) === socket.user.user_id) {
            socket.join(`work-customer-${buyer_id}`);
        }
    });

    socket.on('work-location', async (data) => {
        try {
            const jobId = Number(data?.work_job_id);
            const lat = Number(data?.lat);
            const lng = Number(data?.lng);
            if (!jobId || Number.isNaN(lat) || Number.isNaN(lng)) return;
            const job = await prisma.work_job.findUnique({
                where: { work_job_id: jobId },
                select: { hirer_id: true, assigned_worker_id: true, status: true },
            });
            if (!job || !['worker_en_route', 'in_progress'].includes(job.status) || !job.assigned_worker_id) return;
            const profile = await prisma.worker_profile.findUnique({
                where: { worker_profile_id: job.assigned_worker_id },
                select: { user_id: true },
            });
            if (!profile || profile.user_id !== socket.user.user_id) return;
            await prisma.worker_profile
                .update({ where: { worker_profile_id: job.assigned_worker_id }, data: { current_lat: lat, current_long: lng, last_ping: new Date() } })
                .catch(() => {});
            if (job.hirer_id) io.to(`user-${job.hirer_id}`).emit(`work-location-${jobId}`, { work_job_id: jobId, lat, lng });
        } catch { }
    });

    socket.on('register-social-profile', async (profileId) => {
        try {
            const profile = await prisma.social_profile.findFirst({
                where: { profile_id: Number(profileId), user_id: socket.user.user_id },
                select: { profile_id: true },
            });
            if (profile) {
                socket.join(`profile_${profileId}`);
            }
        } catch { }
    });

    socket.on('update-driver-location', async (data) => {
        try {
            const uid = socket.user?.user_id;
            const trip_id = Number(data?.trip_id);
            const lat = Number(data?.lat);
            const lng = Number(data?.lng ?? data?.long);
            if (!uid || !trip_id || Number.isNaN(lat) || Number.isNaN(lng)) return;

            const trip = await prisma.active_trip.findFirst({
                where: {
                    trip_id,
                    ended_at: null,
                    driver_profile: { user_id: uid },
                },
                select: { trip_id: true },
            });
            if (!trip) return;

            await publishDriverTripLocation(io, trip_id, lat, lng);
        } catch { }
    });

    socket.on('driver-location', async (data) => {
        const uid = socket.user?.user_id;
        const driver_id = Number(data?.driver_id);
        const lat = Number(data?.lat);
        const lng = Number(data?.lng);
        if (!uid || !driver_id || driver_id !== uid || Number.isNaN(lat) || Number.isNaN(lng)) return;
        try {
            await prisma.driver_profile.updateMany({
                where: { user_id: driver_id },
                data: { current_lat: lat, current_long: lng, last_ping: new Date() },
            });

            const openTrip = await prisma.active_trip.findFirst({
                where: {
                    ended_at: null,
                    driver_profile: { user_id: driver_id },
                    ride_request: { status: { in: ['accepted', 'ongoing'] } },
                },
                orderBy: { trip_id: 'desc' },
                select: { trip_id: true },
            });
            if (openTrip?.trip_id) {
                await publishDriverTripLocation(io, openTrip.trip_id, lat, lng);
            }
        } catch { }
    });

    // Courier's counterpart to `update-driver-location`. A courier has no active_trip row, so the
    // order id is the tracking key and the ping is relayed to the owning customer's `user-<id>`
    // room. publishCourierLocation re-checks that this socket's user really is the assigned courier
    // on a live order, so a client cannot push a fake position into someone else's delivery.
    socket.on('update-courier-location', async (data) => {
        try {
            const uid = socket.user?.user_id;
            const courier_order_id = Number(data?.courier_order_id);
            const lat = Number(data?.lat);
            const lng = Number(data?.lng ?? data?.long);
            if (!uid || !courier_order_id || Number.isNaN(lat) || Number.isNaN(lng)) return;
            await publishDeliveryLocation('courier', io, courier_order_id, uid, lat, lng);
        } catch { }
    });

    // Food/grocery/restaurant courier GPS — same customer-room pattern as courier packages.
    socket.on('update-food-order-location', async (data) => {
        try {
            const uid = socket.user?.user_id;
            const food_order_id = Number(data?.food_order_id);
            const lat = Number(data?.lat);
            const lng = Number(data?.lng ?? data?.long);
            if (!uid || !food_order_id || Number.isNaN(lat) || Number.isNaN(lng)) return;
            await publishDeliveryLocation('food', io, food_order_id, uid, lat, lng);
        } catch { }
    });

    socket.on('update-food-delivery-location', async (data) => {
        try {
            const uid = socket.user?.user_id;
            const food_order_id = Number(data?.food_order_id ?? data?.order_id);
            const lat = Number(data?.lat);
            const lng = Number(data?.lng ?? data?.long);
            if (!uid || !food_order_id || Number.isNaN(lat) || Number.isNaN(lng)) return;

            const driver = await prisma.driver_profile.findFirst({
                where: { user_id: uid },
                select: { driver_profile_id: true },
            });
            if (!driver) return;

            const order = await prisma.food_order.findUnique({
                where: { food_order_id },
                select: {
                    user_id: true,
                    driver_id: true,
                    order_status: true,
                    order_flow: true,
                    vendor_type: { select: { vendor_type: true } },
                    food_vendor: { include: { vendor_type: { select: { vendor_type: true } } } },
                },
            });
            const flow = String(order?.order_flow || order?.vendor_type?.vendor_type || order?.food_vendor?.vendor_type?.vendor_type || '').toLowerCase();
            const isGrocery = flow.includes('grocery');
            const relayable = ['dispatched', 'picked_up', 'ready_for_pickup'].includes(order?.order_status);
            if (!order || !isGrocery || order.driver_id !== driver.driver_profile_id || !relayable) return;

            await prisma.driver_profile.updateMany({
                where: { driver_profile_id: driver.driver_profile_id },
                data: { current_lat: lat, current_long: lng, last_ping: new Date() },
            });

            io.to(`user-${order.user_id}`).emit(`food-driver-location-${food_order_id}`, {
                order_id: food_order_id,
                lat,
                lng,
                updated_at: new Date().toISOString(),
            });
        } catch { }
    });

    socket.on('update-provider-location', async (data) => {
        const { provider_id, lat, long } = data || {};
        const uid = socket.user?.user_id;
        if (!provider_id || !uid) return;
        try {
            // M7: ownership — only move the pin for a provider this socket's user owns. Using
            // updateMany with a user_id filter makes a non-owned provider_id a no-op (0 rows)
            // instead of letting any authed user overwrite an arbitrary provider's GPS.
            await prisma.user_service_provider.updateMany({
                where: { provider_id: Number(provider_id), user_id: uid },
                data: { current_lat: lat, current_long: long, last_ping: new Date() },
            });
        } catch { }
    });

    // L7: relay live chat. Validates, enforces the streamer chat policy (S7: ban / banned-words /
    // chat-mode / slow-mode), persists best-effort, then broadcasts to the room.
    socket.on('stream-chat', async (data) => {
        const { session_id, text } = data || {};
        const user_id = socket.user?.user_id;
        if (!session_id || !user_id || !text || !String(text).trim()) return;

        // H5: the socket must have joined this room (via join-stream, which verifies the session
        // is live) before it can post. Stops chat being injected into arbitrary or ended sessions.
        if (!socket.joinedStreams?.has(String(session_id))) return;

        // H4: unconditional per-socket flood floor, independent of the streamer's slow-mode.
        // Each message costs ~4-5 DB round-trips (policy + ban + sub + persist), so an
        // unthrottled socket is a DB-amplification DoS. Reject (don't queue) when too fast.
        const now = Date.now();
        if (socket.lastChatAt && now - socket.lastChatAt < CHAT_MIN_INTERVAL_MS) {
            return socket.emit('stream-chat-rejected', {
                reason: 'Too_Fast', retry_after_ms: CHAT_MIN_INTERVAL_MS,
            });
        }
        socket.lastChatAt = now;

        const clean = sanitizeChatText(text).slice(0, 500);   // M11: neutralise markup/control chars
        if (!clean) return;
        const username = socket.user?.name ?? `User ${user_id}`;
        const roomName = `stream_${session_id}`;

        // Ban checks fail closed; soft mode gates fail open.
        let policy;
        try {
            policy = await getChatPolicy(session_id);
            const { reason } = await chatRejectDetail(policy, user_id, clean);
            if (reason) return socket.emit('stream-chat-rejected', { reason });
        } catch (err) {
            console.error('[stream-chat] policy check hard-failed:', err?.message);
            return socket.emit('stream-chat-rejected', { reason: 'Moderation_Unavailable' });
        }

        // S7: slow mode — per-user, per-session throttle backed by redis (best-effort: if redis
        // is down the throttle is skipped rather than blocking chat).
        // S7: slow mode — per-user, per-session throttle.
        //
        // This used to read `redis.set(..., 'NX') === null` as "already posted recently". With
        // no Redis the client Proxy resolves null for EVERY command, so that test was true for
        // every message and turning slow mode on rejected the entire chat. isRedisReady() is
        // what separates "the NX genuinely lost" from "the command was a silent no-op" —
        // exactly the distinction utils/redis-client.js exports it for.
        if (policy?.slow_mode_ms > 0) {
            let blocked = false;
            try {
                if (isRedisReady()) {
                    const slowKey = `stream:${session_id}:slow:${user_id}`;
                    const ok = await redis.set(slowKey, '1', 'PX', policy.slow_mode_ms, 'NX');
                    blocked = ok === null;
                } else {
                    blocked = slowModeBlocked(session_id, user_id, policy.slow_mode_ms);
                }
            } catch (err) {
                // Throttling is a nicety; never let it take chat down.
                console.debug('[stream-chat] slow-mode check failed, allowing:', err?.message);
            }
            if (blocked) {
                return socket.emit('stream-chat-rejected', {
                    reason: 'Slow_Mode', retry_after_ms: policy.slow_mode_ms,
                });
            }
        }

        let saved;
        try {
            saved = await prisma.live_chat_message.create({
                data: { session_id: Number(session_id), user_id, username, text: clean },
            });
        } catch { /* best-effort persist — still broadcast */ }

        // Tag the message with badge flags so the FE can show streamer / mod / sub.
        // Best-effort: a lookup failure just omits the badge (never blocks chat).
        let is_subscriber = false;
        let is_moderator = false;
        let is_streamer = false;
        if (policy?.streamer_id) {
            try { is_subscriber = await isSubscribed(user_id, policy.streamer_id); }
            catch (err) { console.debug('[stream-chat] sub-badge lookup failed:', err?.message); }
            try {
                is_streamer = policy.owner_user_id != null && Number(policy.owner_user_id) === Number(user_id);
                if (!is_streamer) {
                    const mod = await prisma.live_chat_moderator.findUnique({
                        where: {
                            streamer_id_user_id: {
                                streamer_id: policy.streamer_id,
                                user_id: Number(user_id),
                            },
                        },
                        select: { mod_id: true },
                    });
                    is_moderator = !!mod;
                }
            } catch (err) { console.debug('[stream-chat] mod-badge lookup failed:', err?.message); }
        }

        io.to(roomName).emit('stream-chat', {
            id: saved?.message_id,
            user_id,
            username,
            text: clean,
            is_subscriber,
            is_moderator,
            is_streamer,
        });
    });

    socket.on('disconnect', async () => {
        // M4: clean the user out of EVERY stream viewer set it joined (not just the last one),
        // so counts don't stay inflated until the 12h TTL when a socket joined multiple rooms.
        if (!socket.userId) return;
        const rooms = socket.joinedStreams ? [...socket.joinedStreams] : (socket.currentStream ? [String(socket.currentStream)] : []);
        for (const session_id of rooms) {
            try {
                await redis.srem(`stream:${session_id}:viewers`, socket.userId);
                const count = await viewerCount(io, session_id, socket.liveHostUserId ?? null);
                io.to(`stream_${session_id}`).emit('viewer-count-updated', { session_id, count });
            } catch (err) { console.debug('[disconnect] viewer-count broadcast failed:', err?.message); }
        }
    });
});

server.timeout = 600000; // 10 min — needed for large video uploads
await logMailStartupStatus();
logCriticalSecrets();

import Redis from 'ioredis';

// Dedicated subscriber for the worker→API "VIDEO_READY" pub/sub bridge. Redis is an OPTIONAL
// accelerator and prod has NO managed Redis, so this client MUST degrade quietly. A raw ioredis
// client with no 'error' listener throws on the unhandled connection 'error' event and
// crash-loops the entire API — it did: every Redis touch hit ECONNREFUSED 127.0.0.1:6379 →
// MaxRetriesPerRequestError → process exit → ACA marked the revision Unhealthy. Mirror the
// resilience of utils/redis-client.js: cap reconnects, never throw on a missing request, and
// always have an 'error' handler so the event can't crash the process.
const pubSubSubscriptionClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: null,
  retryStrategy: (times) => (times <= 5 ? 1000 : null),
});

let pubSubWarned = false;
pubSubSubscriptionClient.on('error', (err) => {
  if (!pubSubWarned) {
    pubSubWarned = true;
    console.warn(`[pubsub] Redis unavailable — worker→API VIDEO_READY socket bridge inactive: ${err.message}. Suppressing further errors.`);
  }
});

// Connect + subscribe lazily; if Redis isn't there the catch keeps the bridge inactive
// (the 'error' handler above absorbs the connection failures) instead of crashing boot.
pubSubSubscriptionClient.connect()
  .then(() => pubSubSubscriptionClient.subscribe('system:events'))
  .catch(() => { /* no Redis: bridge stays inactive, app keeps running */ });


pubSubSubscriptionClient.on('message', async (channel, message) => {
  if (channel === 'system:events') {
    try {
      const data = JSON.parse(message);
      if (data.event === 'VIDEO_READY') {
        
        // 🌟 NEW: Social Feed Video Live Hot-Swap Handler
        if (data.type === 'social') {
          const att = await prisma.social_media_attachments.findUnique({
            where: { attachment_id: Number(data.video_id) },
            select: { attachment_id: true, social_post_id: true, media_url: true }
          });

          if (att) {
            // Broadcast live HLS ready event so client player hot-swaps MP4 -> HLS seamlessly
            io.emit('social-video-ready', {
              attachment_id: att.attachment_id,
              social_post_id: att.social_post_id,
              hls_url: att.media_url,
            });
            console.log(`📡 [PubSub Bridge] Broadcasted 'social-video-ready' for Attachment #${att.attachment_id}`);
          }
        } 
        // Existing Main Video Platform Handler
        else {
          const video = await prisma.video.findUnique({
            where: { video_id: Number(data.video_id) },
            include: { channel: true }
          });
          if (video?.channel?.user_id) {
            io.to(`user-${video.channel.user_id}`).emit('video-processed', {
              video_id: video.video_id,
              title: video.title,
              status: video.status,
              thumbnail_url: video.thumbnail_url
            });
            await notifyVideoTerminal(io, video);
          }
        }
      }
    } catch (err) {
      console.error('PubSub Bridge Error:', err.message);
    }
  }
});

// Nothing was listening for these before, so a rejected promise anywhere in 2,098 route
// handlers or 18 cron jobs terminated the process with no record of why. Report, flush, then
// exit non-zero and let the platform restart a clean replica — staying up after an uncaught
// exception leaves the process in an undefined state.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  captureError(err, { fatal: true, kind: 'uncaughtException' });
  flushObservability(2000).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
  captureError(reason, { fatal: true, kind: 'unhandledRejection' });
  flushObservability(2000).finally(() => process.exit(1));
});

// Azure Container Apps sends SIGTERM before replacing a revision. Without a handler the
// process is killed mid-request; draining first is what makes a deploy zero-downtime.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — draining connections`);
  const forceExit = setTimeout(() => {
    console.error('[shutdown] drain timed out — forcing exit');
    process.exit(1);
  }, Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000));
  forceExit.unref?.();
  server.close(async () => {
    try { await prisma.$disconnect(); } catch { /* already closed */ }
    try { redis?.disconnect?.(); } catch { /* already closed */ }
    await flushObservability(2000);
    console.log('[shutdown] clean exit');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => console.log(`Server listening on ${PORT}`));
