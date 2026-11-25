import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { generateUserToken } from '../utils/azure-acs.js';
import { resolveLiveCategoryId } from '../services/live-category-resolver.js';
import { getBrowseCategories, getRecommendedCategories } from '../services/live-category-browse.js';
import { notifyFollowersLive } from '../services/live-notify.js';
import { viewerCount, viewerCounts } from '../services/live-presence.js';
import { countSocialFollowersForUserId } from '../utils/social-follow-counts.js';
import { handleLiveThumbUpload, storeLiveThumbnail } from '../utils/live-thumbnail-upload.js';
import { finalizeLiveSession } from '../services/live-session-finalize.js';
import {
    LIVE_RTMP_URL,
    LIVE_HLS_BASE,
    VOD_AUTH_ENFORCE,
    mediaEgressEnabled,
    mintStreamKey,
    mintPlaybackId,
    resolvePlaybackUrl,
    hookSecretValid,
    findSessionByPlaybackPath,
    sanitizeHlsAssetParam,
    LIVE_WHIP_INTERNAL,
    whipPublishUrl,
    resolveWhipResourceUrl,
} from '../services/live-playback.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';


const router = express.Router();

/** WHIP resource URLs keyed by session_id (MediaMTX Location). In-process is enough for a
 *  single API instance; DELETE on end-stream / client hangup tears the publisher down. */
const whipResources = new Map();

const whipOfferSchema = z.object({
    sdp: z.string().min(20).max(64_000),
});

async function dropWhipResource(sessionId) {
    const resource = whipResources.get(sessionId);
    whipResources.delete(sessionId);
    if (!resource) return;
    try {
        await fetch(resource, { method: 'DELETE', signal: AbortSignal.timeout(4000) });
    } catch { /* already gone */ }
}

function apiOriginFromReq(req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get('x-forwarded-host') || req.get('host');
    return host ? `${proto}://${host}` : undefined;
}

function playbackFor(session, req) {
    return resolvePlaybackUrl(session, { apiOrigin: apiOriginFromReq(req) });
}

// Browse categories with live viewer aggregates + box art.
router.get('/categories/browse', async (req, res) => {
    try {
        const featuredOnly = req.query.featured === 'true';
        const categories = featuredOnly
            ? await getRecommendedCategories(Number(req.query.limit) || 5, req.app.get('io'))
            : await getBrowseCategories({ io: req.app.get('io') });
        return res.json({ successful: true, data: categories });
    } catch (err) {
        console.error('[live-session/categories/browse] failed:', err);
        return res.json({ successful: true, data: [] });
    }
});

// Public list of currently-live streams for the viewer browse page.
// Unifies discovery on the modern live_session system (replaces legacy /stream/status/live).
router.get('/live', async (req, res) => {
    // Discovery endpoint: must never hard-fail. On any error, log it and return an empty
    // list so the viewer page shows "no live streams" rather than an error banner.
    try {
        const categoryId = req.query.category_id != null ? Number(req.query.category_id) : null;
        const streamerWhere = { is_active: true };
        if (categoryId != null && !Number.isNaN(categoryId)) {
            streamerWhere.category_id = categoryId;
        }

        const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 48, 1), 100);

        // Plain `include` (no deep nested select) — more robust across Postgres/engine setups.
        const sessions = await prisma.live_session.findMany({
            // Only surface sessions that are actually publishing. `STARTING` means the streamer
            // created a session/key but OBS hasn't connected yet — its HLS URL 404s, so a viewer
            // clicking it gets an empty player. `/rtmp/auth` flips the session to `LIVE` the moment
            // OBS publishes (and the sweep keeps it truthful), so `LIVE` is the right discovery gate.
            // Deactivated streamers are hidden from public discovery.
            where: { status: 'LIVE', streamer: streamerWhere },
            orderBy: { created_at: 'desc' },
            take,
            include: { streamer: { include: { category: true } } },
        });

        const counts = await viewerCounts(req.app.get('io'), sessions.map((s) => ({
            session_id: s.session_id,
            hostUserId: s.streamer?.user_id ?? null,
        })));

        const data = sessions.map((s) => ({
            session_id: s.session_id,
            title: s.title,
            description: s.description,
            thumbnail_url: s.thumbnail_url ?? null,
            playback_url: playbackFor(s, req),
            status: s.status,
            started_at: s.started_at,
            streamer_id: s.streamer?.streamer_id ?? null,
            streamer_user_id: s.streamer?.user_id ?? null,
            handle: s.streamer?.handle ?? null,
            display_name: s.streamer?.display_name ?? 'Streamer',
            profile_pic_url: s.streamer?.profile_pic_url ?? null,
            verified: s.streamer?.is_verified ?? false,
            category: s.streamer?.category?.category_name ?? 'General',
            category_id: s.streamer?.category?.category_id ?? null,
            category_icon_url: s.streamer?.category?.icon_url ?? null,
            viewer_count: counts.get(s.session_id) ?? 0,
        }));

        return res.json({ successful: true, data });
    } catch (err) {
        console.error('[live-session/live] failed:', err);
        return res.json({ successful: true, data: [] });
    }
});

//======================================================================================================
//===================== MediaMTX egress hooks (server-to-server, no JWT) ===============================
//======================================================================================================

// External-auth endpoint for the media server. MediaMTX POSTs { action, path, ... } before
// allowing an RTMP publish or an HLS read. 2xx = allow, 401 = deny.
//   - publish: allowed only if `path` (the stream key) maps to a session that isn't ended.
//   - playback: gated when LIVE_VOD_AUTH_ENFORCE is on (PUBLIC VODs only at media layer).
//   - read: live HLS reads stay public at MediaMTX; public viewers use /play/:playback_id proxy.
router.post('/rtmp/auth', async (req, res) => {
    try {
        const { action, path } = req.body || {};
        const allowed = new Set(['publish', 'read', 'playback']);
        if (!allowed.has(action)) return res.sendStatus(401);
        if (action === 'read') return res.sendStatus(200);

        if (action === 'playback') {
            if (!VOD_AUTH_ENFORCE) return res.sendStatus(200);
            try {
                const playbackKey = String(path || '').replace(/^\/+/, '').split('/')[0];
                if (!playbackKey) return res.sendStatus(401);
                const playbackSession = await prisma.live_session.findFirst({
                    where: {
                        OR: [{ stream_key: playbackKey }, { playback_id: playbackKey }],
                    },
                    select: { session_id: true },
                });
                if (!playbackSession) return res.sendStatus(401);
                const vod = await prisma.live_vod.findFirst({
                    where: { session_id: playbackSession.session_id },
                    select: { visibility: true },
                });
                return res.sendStatus(vod && vod.visibility === 'PUBLIC' ? 200 : 401);
            } catch (err) {
                console.error('[rtmp/auth playback] failed:', err);
                return res.sendStatus(401);
            }
        }

        if (action !== 'publish') return res.sendStatus(401);

        const streamKey = String(path || '').replace(/^\/+/, '').split('/')[0];
        if (!streamKey) return res.sendStatus(401);

        const session = await prisma.live_session.findUnique({
            where: { stream_key: streamKey },
            include: { streamer: { select: { is_active: true } } },
        });
        if (!session || ['FINISHED', 'CANCELLED', 'ENDED'].includes(session.status)) {
            return res.sendStatus(401);
        }
        if (!session.streamer?.is_active) {
            return res.sendStatus(401);
        }
        // LIVE flip only when MediaMTX presents the hook secret via header.
        // Query-string secret removed — secrets in URLs leak via logs/referrers.
        const fromMediaServer = hookSecretValid(req.get('x-live-hook-secret'));
        if (fromMediaServer && session.status !== 'LIVE') {
            prisma.live_session.update({
                where: { session_id: session.session_id },
                data: { status: 'LIVE', started_at: session.started_at ?? new Date() },
            }).then(() => notifyFollowersLive(session.streamer_id, req.app.get('io'))).catch(() => {});
        }
        return res.sendStatus(200);
    } catch (err) {
        console.error('[rtmp/auth] failed:', err);
        return res.sendStatus(401);
    }
});

// Lifecycle hook — secret via x-live-hook-secret header only (body.secret ignored).
router.post('/rtmp/event', async (req, res) => {
    try {
        if (!hookSecretValid(req.get('x-live-hook-secret'))) return res.sendStatus(403);

        const { event, path } = req.body || {};
        const streamKey = String(path || '').replace(/^\/+/, '').split('/')[0];
        const session = await prisma.live_session.findUnique({ where: { stream_key: streamKey } });
        if (!session) return res.sendStatus(404);

        if (event === 'ready' && session.status !== 'LIVE') {
            await prisma.live_session.update({
                where: { session_id: session.session_id },
                data: { status: 'LIVE', started_at: session.started_at ?? new Date() },
            });
            notifyFollowersLive(session.streamer_id, req.app.get('io')).catch(() => {});
        } else if (event === 'notReady' && !['FINISHED', 'CANCELLED', 'ENDED'].includes(session.status)) {
            await finalizeLiveSession({
                sessionId: session.session_id,
                session,
                status: 'FINISHED',
                io: req.app.get('io'),
            });
        }
        return res.sendStatus(200);
    } catch (err) {
        console.error('[rtmp/event] failed:', err);
        return res.sendStatus(500);
    }
});

//======================================================================================================
//===================== Public HLS proxy (hides stream_key behind playback_id) ========================
//======================================================================================================

router.get('/play/:playbackId/:asset', async (req, res) => {
    try {
        if (!LIVE_HLS_BASE) return res.status(503).send('HLS egress not configured');
        const session = await findSessionByPlaybackPath(req.params.playbackId);
        if (!session?.stream_key) return res.sendStatus(404);
        // Live proxy only while the session is actually publishing / about to.
        if (!['LIVE', 'STARTING'].includes(session.status)) return res.sendStatus(404);

        const rest = sanitizeHlsAssetParam(req.params.asset);
        if (!rest) return res.sendStatus(400);

        const upstream = `${LIVE_HLS_BASE.replace(/\/$/, '')}/${encodeURIComponent(session.stream_key)}/${rest}`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        let upstreamRes;
        try {
            upstreamRes = await fetch(upstream, {
                method: 'GET',
                headers: { Accept: req.get('Accept') || '*/*' },
                signal: ctrl.signal,
            });
        } finally {
            clearTimeout(t);
        }
        if (!upstreamRes.ok) {
            return res.sendStatus(upstreamRes.status === 404 ? 404 : 502);
        }

        const ct = upstreamRes.headers.get('content-type') || '';
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (ct.includes('mpegurl') || rest.endsWith('.m3u8')) {
            // Playlists must stay uncached so clients pick up new segments quickly.
            res.setHeader('Cache-Control', 'no-store');
            let text = await upstreamRes.text();
            const basePrefix = `/live-session/play/${encodeURIComponent(session.playback_id || req.params.playbackId)}/`;
            text = text.replace(/^(?!#)(?!\w+:\/\/)(.+)$/gm, (line) => {
                const trimmed = line.trim();
                if (!trimmed) return line;
                const seg = sanitizeHlsAssetParam(trimmed.replace(/^\.\//, ''));
                if (!seg) return line;
                return `${basePrefix}${seg}`;
            });
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(text);
        }

        // Stream segments through without buffering the whole body in memory.
        // Short cache is safe for immutable segment filenames; prefer LIVE_CDN_HLS_BASE in prod.
        res.setHeader('Cache-Control', 'public, max-age=10');
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        if (!upstreamRes.body) {
            return res.sendStatus(502);
        }
        await pipeline(Readable.fromWeb(upstreamRes.body), res);
    } catch (err) {
        console.error('[live-session/play] proxy failed:', err?.message || err);
        if (!res.headersSent) return res.sendStatus(502);
    }
});

router.get('/play/:playbackId', (req, res) => {
    res.redirect(302, `/live-session/play/${encodeURIComponent(req.params.playbackId)}/index.m3u8`);
});

const startStreamSchema = z.object({
    title: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
    category_id: z.number().int().positive().optional(),
    category_name: z.string().min(1).max(100).optional(),
});

router.post('/init', authenticateToken, async (req, res, next) => {
    try {
        const validated = startStreamSchema.safeParse(req.body);
        if (!validated.success) {
            return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });
        }

        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id: req.user.user_id }
        });

        if (!profile) {
            return res.status(404).json({ successful: false, message: "Streamer_Profile_Not_Found" });
        }

        if (!profile.is_active) {
            return res.status(403).json({ successful: false, message: "Profile_Deactivated" });
        }

        if (!mediaEgressEnabled()) {
            return res.status(503).json({
                successful: false,
                message: 'Live_Egress_Not_Configured',
                detail: 'Set LIVE_RTMP_URL and LIVE_HLS_BASE (MediaMTX). ACS/Mux demo fallbacks are disabled.',
            });
        }

        // If OBS is already publishing (or a STARTING session is waiting for it), reuse that
        // session instead of minting a new stream key and FINISHing the live one. Reloading the
        // dashboard and clicking Go Live again used to orphan the OBS connection on the old key
        // while the UI showed Offline / a brand-new key.
        const existing = await prisma.live_session.findFirst({
            where: {
                streamer_id: profile.streamer_id,
                status: { in: ['STARTING', 'LIVE'] },
            },
            orderBy: { created_at: 'desc' },
        });
        if (existing?.stream_key) {
            const resolvedCategoryId = await resolveLiveCategoryId({
                category_id: validated.data.category_id,
                category_name: validated.data.category_name,
            });
            const title = validated.data.title || existing.title;
            const description = validated.data.description ?? existing.description;
            const playbackId = existing.playback_id || mintPlaybackId();
            const withIds = { ...existing, playback_id: playbackId };
            const updated = await prisma.live_session.update({
                where: { session_id: existing.session_id },
                data: {
                    title,
                    description,
                    playback_id: playbackId,
                    ingest_url: LIVE_RTMP_URL,
                    playback_url: playbackFor(withIds, req),
                },
            });
            if (resolvedCategoryId) {
                await prisma.live_streamer_profile.update({
                    where: { streamer_id: profile.streamer_id },
                    data: { category_id: resolvedCategoryId },
                });
            }
            return res.status(200).json({
                successful: true,
                reused: true,
                stream_config: {
                    server_url: LIVE_RTMP_URL,
                    stream_key: existing.stream_key,
                    acs_room_id: existing.acs_room_id,
                    playback_url: playbackFor(updated, req),
                    session_id: existing.session_id,
                    status: updated.status,
                },
            });
        }

        const uniqueKey = mintStreamKey();
        const playbackId = mintPlaybackId();

        // OBS publishes with stream_key (MediaMTX path); viewers use public playback_id proxy.
        const baseIngestUrl = LIVE_RTMP_URL;
        const playbackUrl = playbackFor({ playback_id: playbackId }, req);

        const session = await prisma.$transaction(async (tx) => {
            const resolvedCategoryId = await resolveLiveCategoryId({
                category_id: validated.data.category_id,
                category_name: validated.data.category_name,
            }, tx);
            if (resolvedCategoryId) {
                await tx.live_streamer_profile.update({
                    where: { streamer_id: profile.streamer_id },
                    data: { category_id: resolvedCategoryId },
                });
            }

            return tx.live_session.create({
                data: {
                    streamer_id: profile.streamer_id,
                    stream_key: uniqueKey,
                    playback_id: playbackId,
                    ingest_url: baseIngestUrl,
                    acs_room_id: null,
                    playback_url: playbackUrl,
                    title: validated.data.title,
                    description: validated.data.description,
                    status: 'STARTING'
                }
            });
        });

        return res.status(201).json({
            successful: true,
            stream_config: {
                server_url: baseIngestUrl,
                stream_key: uniqueKey,
                acs_room_id: null,
                playback_url: playbackUrl,
                session_id: session.session_id,
                status: 'STARTING',
            }
        });
    } catch (err) {
        next(err);
    }
});

router.get('/active', authenticateToken, async (req, res, next) => {
    try {
        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id: req.user.user_id }
        });

        if (!profile) {
            // Expected for users without a streamer profile — there is simply
            // no active session to report. Empty 200 keeps the dashboard load
            // free of console-error noise.
            return res.json({ successful: true, data: null });
        }

        const session = await prisma.live_session.findFirst({
            where: { 
                streamer_id: profile.streamer_id,
                status: { in: ['STARTING', 'LIVE'] }
            },
            orderBy: { created_at: 'desc' }
        });

        // Always reflect current LIVE_* env on active sessions so a stale ingest_url saved
        // while pointed at production does not strand local OBS on live.strug.ca.
        const data = session && mediaEgressEnabled() && session.stream_key
            ? {
                ...session,
                ingest_url: LIVE_RTMP_URL,
                playback_url: playbackFor(session, req),
            }
            : session
                ? { ...session, playback_url: playbackFor(session, req) }
                : session;

        return res.json({ successful: true, data });
    } catch (err) {
        next(err);
    }
});

router.get('/token', authenticateToken, async (req, res, next) => {
    try {
        const tokenData = await generateUserToken();
        return res.json({ successful: true, data: tokenData });
    } catch (err) {
        next(err);
    }
});

// Public channel header + current-live state by handle. Unauthenticated and token-free
// (the ACS viewer token is only minted by the authed /join/:handle below). Powers
// /live/@handle for logged-out visitors, offline channels, and link-preview metadata —
// none of which /join/:handle can serve (it is auth-gated and 404s when offline).
router.get('/public/:handle', async (req, res) => {
    try {
        const handle = String(req.params.handle || '').toLowerCase();
        const streamer = await prisma.live_streamer_profile.findUnique({
            where: { handle },
            select: {
                streamer_id: true, user_id: true, handle: true, display_name: true, description: true,
                profile_pic_url: true, banner_url: true, offline_banner_url: true,
                theme_color: true, is_verified: true, is_active: true,
                category: { select: { category_name: true } },
            },
        });
        if (!streamer || !streamer.is_active) {
            return res.status(404).json({ successful: false, message: 'Channel_Not_Found' });
        }

        const session = await prisma.live_session.findFirst({
            where: { streamer_id: streamer.streamer_id, status: { in: ['STARTING', 'LIVE'] } },
            orderBy: { created_at: 'desc' },
            // Never return stream_key on public routes — it is the RTMP ingest credential.
            select: { session_id: true, title: true, description: true, thumbnail_url: true, status: true, started_at: true, playback_url: true, stream_key: true },
        });

        let viewer_count = 0;
        if (session) {
            viewer_count = await viewerCount(req.app.get('io'), session.session_id, streamer.user_id);
        }

        const follower_count = await countSocialFollowersForUserId(streamer.user_id);

        const publicSession = session
            ? {
                session_id: session.session_id,
                title: session.title,
                description: session.description,
                thumbnail_url: session.thumbnail_url,
                status: session.status,
                started_at: session.started_at,
                playback_url: playbackFor(session, req),
                viewer_count,
            }
            : null;

        return res.json({
            successful: true,
            data: {
                streamer: {
                    streamer_id: streamer.streamer_id,
                    user_id: streamer.user_id,
                    handle: streamer.handle,
                    display_name: streamer.display_name,
                    description: streamer.description,
                    profile_pic_url: streamer.profile_pic_url,
                    banner_url: streamer.banner_url,
                    offline_banner_url: streamer.offline_banner_url,
                    theme_color: streamer.theme_color,
                    is_verified: streamer.is_verified,
                    category: streamer.category?.category_name ?? 'General',
                    follower_count,
                },
                is_live: Boolean(session),
                live_session: publicSession,
            },
        });
    } catch (err) {
        console.error('[live-session/public/:handle] failed:', err);
        return res.status(500).json({ successful: false, message: 'Failed to load channel.' });
    }
});

// A specific session (+ its published VOD if any) by handle — powers /live/@handle/:sessionId
// deep links and VOD previews. Validates the session belongs to the handle.
router.get('/public/:handle/:sessionId', async (req, res) => {
    try {
        const handle = String(req.params.handle || '').toLowerCase();
        const sessionId = Number(req.params.sessionId);
        if (Number.isNaN(sessionId)) return res.status(400).json({ successful: false, message: 'Invalid session id.' });

        const streamer = await prisma.live_streamer_profile.findUnique({
            where: { handle },
            select: {
                streamer_id: true, handle: true, display_name: true, profile_pic_url: true,
                banner_url: true, theme_color: true, is_verified: true, is_active: true,
            },
        });
        if (!streamer || !streamer.is_active) {
            return res.status(404).json({ successful: false, message: 'Channel_Not_Found' });
        }

        const session = await prisma.live_session.findFirst({
            where: { session_id: sessionId, streamer_id: streamer.streamer_id },
            // stream_key fetched only to resolve playback_url — never returned to clients.
            select: { session_id: true, title: true, description: true, thumbnail_url: true, status: true, started_at: true, ended_at: true, playback_url: true, playback_id: true, stream_key: true },
        });
        if (!session) return res.status(404).json({ successful: false, message: 'Session_Not_Found' });

        const is_live = session.status === 'LIVE';
        let viewer_count = 0;
        if (is_live) viewer_count = await viewerCount(req.app.get('io'), session.session_id, streamer.user_id);

        const vod = await prisma.live_vod.findFirst({
            where: { session_id: sessionId, streamer_id: streamer.streamer_id, visibility: 'PUBLIC' },
            orderBy: { created_at: 'desc' },
            select: { vod_id: true, video_url: true, thumbnail_url: true, title: true, description: true, duration_sec: true, is_clip: true, created_at: true },
        });

        const { is_active, ...streamerPublic } = streamer;
        return res.json({
            successful: true,
            data: {
                streamer: streamerPublic,
                is_live,
                live_session: {
                    session_id: session.session_id,
                    title: session.title,
                    description: session.description,
                    thumbnail_url: session.thumbnail_url,
                    status: session.status,
                    started_at: session.started_at,
                    ended_at: session.ended_at,
                    playback_url: playbackFor(session, req),
                    viewer_count,
                },
                vod: vod ?? null,
            },
        });
    } catch (err) {
        console.error('[live-session/public/:handle/:sessionId] failed:', err);
        return res.status(500).json({ successful: false, message: 'Failed to load session.' });
    }
});

router.get('/join/:handle', authenticateToken, async (req, res, next) => {
    try {
        const { handle } = req.params;

        const streamerProfile = await prisma.live_streamer_profile.findUnique({
            where: { handle: handle.toLowerCase() },
            select: {
                streamer_id: true,
                display_name: true,
                is_verified: true,
                is_active: true,
                category: true
            }
        });

        if (!streamerProfile || !streamerProfile.is_active) {
            return res.status(404).json({ successful: false, message: "Channel_Not_Found" });
        }

        const session = await prisma.live_session.findFirst({
            where: { 
                streamer_id: streamerProfile.streamer_id,
                status: { in: ['STARTING', 'LIVE'] }
            },
            orderBy: { created_at: 'desc' }
        });

        if (!session) {
            return res.status(404).json({ successful: false, message: "Stream_Offline" });
        }

        const viewerToken = await generateUserToken();

        return res.json({
            successful: true,
            stream_data: {
                title: session.title,
                description: session.description,
                room_id: session.acs_room_id,
                started_at: session.started_at
            },
            streamer_data: streamerProfile,
            viewer_access: viewerToken
        });
    } catch (err) {
        next(err);
    }
});

//======================================================================================================
//===================== Raids (send viewers to another live channel) ===================================
//======================================================================================================

/** Other currently-live sessions the caller can raid into (excludes own channel). */
router.get('/raid/targets', authenticateToken, async (req, res) => {
    try {
        const me = await prisma.live_streamer_profile.findUnique({
            where: { user_id: req.user.user_id },
            select: { streamer_id: true },
        });

        const sessions = await prisma.live_session.findMany({
            where: {
                status: 'LIVE',
                ...(me ? { streamer_id: { not: me.streamer_id } } : {}),
                streamer: { is_active: true },
            },
            include: {
                streamer: {
                    select: {
                        streamer_id: true,
                        user_id: true,
                        handle: true,
                        display_name: true,
                        profile_pic_url: true,
                        category: { select: { category_name: true } },
                    },
                },
            },
            orderBy: { started_at: 'desc' },
            take: 24,
        });

        const data = await Promise.all(sessions.map(async (s) => {
            const viewer_count = await viewerCount(req.app.get('io'), s.session_id, s.streamer?.user_id ?? null);
            return {
                session_id: s.session_id,
                title: s.title,
                playback_url: playbackFor(s, req),
                streamer_id: s.streamer?.streamer_id ?? null,
                streamer_user_id: s.streamer?.user_id ?? null,
                handle: s.streamer?.handle ?? null,
                display_name: s.streamer?.display_name ?? 'Streamer',
                profile_pic_url: s.streamer?.profile_pic_url ?? null,
                category: s.streamer?.category?.category_name ?? 'General',
                viewer_count,
            };
        }));

        return res.json({ successful: true, data });
    } catch (err) {
        console.error('[live-session/raid/targets] failed:', err);
        return res.json({ successful: true, data: [] });
    }
});

const raidSchema = z.object({
    target_session_id: z.number().int().positive(),
});

/** Raid viewers from this session into another live, then end the source stream. */
router.post('/:session_id/raid', authenticateToken, async (req, res, next) => {
    try {
        const session_id = Number(req.params.session_id);
        if (Number.isNaN(session_id)) {
            return res.status(400).json({ successful: false, message: 'Invalid_Session_Id' });
        }
        const { target_session_id } = raidSchema.parse({
            target_session_id: Number(req.body?.target_session_id),
        });
        if (target_session_id === session_id) {
            return res.status(400).json({ successful: false, message: 'Cannot raid yourself.' });
        }

        const session = await prisma.live_session.findUnique({
            where: { session_id },
            include: { streamer: true },
        });
        if (!session) return res.status(404).json({ successful: false, message: 'Not_Found' });
        if (session.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: 'Forbidden' });
        }
        if (!['LIVE', 'STARTING'].includes(session.status)) {
            return res.status(400).json({ successful: false, message: 'Source stream is not live.' });
        }

        const target = await prisma.live_session.findUnique({
            where: { session_id: target_session_id },
            include: {
                streamer: {
                    select: {
                        streamer_id: true,
                        user_id: true,
                        handle: true,
                        display_name: true,
                        profile_pic_url: true,
                        is_active: true,
                        category: { select: { category_name: true } },
                    },
                },
            },
        });
        if (!target || !target.streamer?.is_active || target.status !== 'LIVE') {
            return res.status(404).json({ successful: false, message: 'Target stream is not live.' });
        }

        const viewer_count = await viewerCount(req.app.get('io'), target.session_id, target.streamer?.user_id ?? null);

        const raidPayload = {
            from_session_id: session_id,
            from_handle: session.streamer.handle,
            from_display_name: session.streamer.display_name,
            target: {
                session_id: target.session_id,
                title: target.title,
                playback_url: playbackFor(target, req),
                streamer_id: target.streamer.streamer_id,
                streamer_user_id: target.streamer.user_id,
                handle: target.streamer.handle,
                display_name: target.streamer.display_name,
                profile_pic_url: target.streamer.profile_pic_url,
                category: target.streamer.category?.category_name ?? 'General',
                viewer_count,
            },
            countdown_sec: 8,
        };

        try {
            const io = req.app.get('io');
            io?.to(`stream_${session_id}`).emit('live:raid', raidPayload);
        } catch { /* optional */ }

        const { updated, session: finalized } = await finalizeLiveSession({
            sessionId: session_id,
            session,
            status: 'FINISHED',
            io: req.app.get('io'),
            emitExtra: { raided: true },
        });

        return res.json({
            successful: true,
            message: 'Raid_Started',
            data: { session: finalized, raid: raidPayload, updated: Boolean(updated) },
        });
    } catch (err) {
        if (err?.name === 'ZodError') {
            return res.status(400).json({ successful: false, message: 'target_session_id is required.' });
        }
        next(err);
    }
});

async function loadOwnedPublishSession(req, session_id) {
    const id = Number(session_id);
    if (!Number.isInteger(id)) return { error: { status: 400, message: 'Invalid session id.' } };
    const profile = await prisma.live_streamer_profile.findUnique({
        where: { user_id: req.user.user_id },
        select: { streamer_id: true },
    });
    if (!profile) return { error: { status: 404, message: 'Streamer_Profile_Not_Found' } };
    const session = await prisma.live_session.findFirst({
        where: {
            session_id: id,
            streamer_id: profile.streamer_id,
            status: { in: ['STARTING', 'LIVE'] },
        },
        select: { session_id: true, stream_key: true, status: true },
    });
    if (!session?.stream_key) return { error: { status: 404, message: 'Session_Not_Found' } };
    return { session };
}

/** Browser / phone go-live: proxy a WHIP SDP offer to MediaMTX so the stream_key never
 *  has to be posted from the client to the media server (JWT stays on the API). */
router.post('/:session_id/whip', authenticateToken, async (req, res, next) => {
    try {
        const parsed = whipOfferSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ successful: false, message: 'SDP offer is required.' });
        }
        const owned = await loadOwnedPublishSession(req, req.params.session_id);
        if (owned.error) {
            return res.status(owned.error.status).json({ successful: false, message: owned.error.message });
        }
        const url = whipPublishUrl(owned.session.stream_key);
        if (!url) {
            return res.status(503).json({ successful: false, message: 'Live_Whip_Not_Configured' });
        }

        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        let upstream;
        try {
            upstream = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
                body: parsed.data.sdp,
                signal: ctrl.signal,
            });
        } catch (err) {
            if (err?.name === 'AbortError') {
                return res.status(504).json({ successful: false, message: 'Media server did not answer in time.' });
            }
            console.error('[live-whip] MediaMTX unreachable:', err?.message);
            return res.status(503).json({
                successful: false,
                message: 'Camera go-live is unavailable. Is MediaMTX running on WHIP port 8889?',
            });
        } finally {
            clearTimeout(t);
        }

        const answer = await upstream.text();
        if (!upstream.ok) {
            return res.status(upstream.status === 401 ? 401 : 502).json({
                successful: false,
                message: 'Media server rejected the camera publish.',
            });
        }

        const resource = resolveWhipResourceUrl(upstream.headers.get('location'), LIVE_WHIP_INTERNAL);
        if (resource) whipResources.set(owned.session.session_id, resource);

        return res.json({ successful: true, sdp: answer });
    } catch (err) {
        next(err);
    }
});

router.delete('/:session_id/whip', authenticateToken, async (req, res, next) => {
    try {
        const owned = await loadOwnedPublishSession(req, req.params.session_id);
        if (owned.error) {
            return res.status(owned.error.status).json({ successful: false, message: owned.error.message });
        }
        await dropWhipResource(owned.session.session_id);
        return res.json({ successful: true });
    } catch (err) {
        next(err);
    }
});

router.post('/:session_id/thumbnail', authenticateToken, handleLiveThumbUpload('image'), async (req, res, next) => {
    try {
        const session_id = Number(req.params.session_id);
        if (!Number.isInteger(session_id)) {
            return res.status(400).json({ successful: false, message: 'Invalid session id.' });
        }

        const session = await prisma.live_session.findUnique({
            where: { session_id },
            include: { streamer: true },
        });
        if (!session || session.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: 'Unauthorized' });
        }
        if (!['STARTING', 'LIVE'].includes(session.status)) {
            return res.status(400).json({ successful: false, message: 'Session is not active.' });
        }

        const thumbnail_url = await storeLiveThumbnail(req, {
            prefix: 'live-session-thumbs',
            streamerId: session.streamer_id,
            entityId: session_id,
        });

        const updated = await prisma.live_session.update({
            where: { session_id },
            data: { thumbnail_url },
        });

        const io = req.app.get('io');
        if (io) {
            io.to(`stream_${session_id}`).emit('metadata-updated', {
                session_id: updated.session_id,
                title: updated.title,
                description: updated.description,
                thumbnail_url: updated.thumbnail_url,
                status: updated.status,
            });
        }

        // Owner HTTP response may include stream_key; socket payload above must not.
        return res.json({ successful: true, data: updated });
    } catch (err) {
        if (err?.code === 'NO_FILE') {
            return res.status(400).json({ successful: false, message: 'Image file is required.' });
        }
        next(err);
    }
});

router.patch('/:session_id/status', authenticateToken, async (req, res, next) => {
    try {
        const session_id = Number(req.params.session_id);
        if (Number.isNaN(session_id)) {
            return res.status(400).json({ successful: false, message: "Invalid_Session_Id" });
        }
        const { status } = req.body;

        if (!['LIVE', 'FINISHED', 'CANCELLED'].includes(status)) {
            return res.status(400).json({ successful: false, message: "Invalid_Status" });
        }

        const session = await prisma.live_session.findUnique({
            where: { session_id },
            include: { streamer: true }
        });
        if (!session) return res.status(404).json({ successful: false, message: "Not_Found" });
        if (session.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: "Forbidden" });
        }

        // FINISHED/CANCELLED must go through finalize so VOD + stream-ended always run.
        if (status === 'FINISHED' || status === 'CANCELLED') {
            const { session: finalized } = await finalizeLiveSession({
                sessionId: session_id,
                session,
                status,
                io: req.app.get('io'),
                archive: status === 'FINISHED',
            });
            return res.json({ successful: true, data: finalized });
        }

        // LIVE without media is discouraged but still allowed for dashboard overrides.
        const updatedSession = await prisma.live_session.update({
            where: { session_id },
            data: { status: 'LIVE', started_at: session.started_at ?? new Date() },
        });

        if (session.status !== 'LIVE') {
            notifyFollowersLive(session.streamer_id, req.app.get('io')).catch(() => {});
        }

        return res.json({ successful: true, data: updatedSession });
    } catch (err) {
        next(err);
    }
});


router.patch('/:session_id/end', authenticateToken, endLiveSessionHandler);
router.post('/:session_id/end', authenticateToken, endLiveSessionHandler);

async function endLiveSessionHandler(req, res, next) {
    try {
        const session_id = Number(req.params.session_id);
        if (Number.isNaN(session_id)) {
            return res.status(400).json({ successful: false, message: "Invalid_Session_Id" });
        }

        const session = await prisma.live_session.findUnique({
            where: { session_id },
            include: { streamer: true }
        });
        if (!session) return res.status(404).json({ successful: false, message: "Not_Found" });
        if (session.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: "Forbidden" });
        }

        await dropWhipResource(session_id);

        const { session: updated } = await finalizeLiveSession({
            sessionId: session_id,
            session,
            status: 'FINISHED',
            io: req.app.get('io'),
        });

        return res.json({ successful: true, message: "Stream_Ended", data: updated });
    } catch (err) {
        next(err);
    }
}

router.delete('/:session_id/reset-key', authenticateToken, async (req, res, next) => {
    try {
        const session_id = Number(req.params.session_id);
        if (Number.isNaN(session_id)) {
            return res.status(400).json({ successful: false, message: "Invalid_Session_Id" });
        }

        // Ownership: only the broadcaster who owns the session may rotate its key.
        const session = await prisma.live_session.findUnique({
            where: { session_id },
            include: { streamer: true }
        });
        if (!session) return res.status(404).json({ successful: false, message: "Not_Found" });
        if (session.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: "Forbidden" });
        }

        // Rotate publish credential only. Keep playback_id stable so viewers' public HLS URL
        // keeps working through the proxy (which remaps to the new stream_key).
        const newKey = mintStreamKey();
        const playbackId = session.playback_id || mintPlaybackId();
        const playback_url = mediaEgressEnabled()
            ? playbackFor({ ...session, playback_id: playbackId, stream_key: newKey }, req)
            : session.playback_url;

        const updated = await prisma.live_session.update({
            where: { session_id },
            data: {
                stream_key: newKey,
                playback_id: playbackId,
                ...(playback_url ? { playback_url } : {}),
            }
        });

        return res.json({ successful: true, new_stream_key: newKey, playback_url: updated.playback_url });
    } catch (err) {
        next(err);
    }
});

export default router;