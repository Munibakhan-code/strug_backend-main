// routes/playlist-routes.js — user-owned video playlists
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { generateVideoReadSAS } from '../utils/azure-storage.js';
import { visibleVideoWhere } from '../utils/video-visibility.js';

const router = express.Router();

// Video fields the frontend needs to render a playlist item / card.
// raw_video_url is selected only so shapePlaylist can SAS-sign a playable fallback when
// hls_url is missing — never returned to the client, and only for videos that pass the
// visibility / owner gate below (see review on #1152).
const ITEM_VIDEO_SELECT = {
    video_id: true, title: true, thumbnail_url: true, hls_url: true, raw_video_url: true,
    duration_sec: true, views_count: true, video_type: true, status: true,
    processing_status: true, created_at: true, category: true,
    channel: { select: { channel_id: true, user_id: true, display_name: true, handle: true, profile_pic_url: true } },
};

const MIX_NAME = 'Mix';
const MIX_PREFIX = 'Mix · ';
const YOUR_MIX_NAME = 'Your Mix';
const MIX_CAP = 50;

function isMixPlaylistName(name) {
    return name === MIX_NAME || name === YOUR_MIX_NAME || name.startsWith(MIX_PREFIX);
}

// Shape a playlist row (with items->video) into { playlist_id, name, created_at, videos: [...] }
const cleanUrl = (urlStr) => {
    if (!urlStr) return urlStr;
    return urlStr.split('?')[0];
};

const getContainerFromUrl = (urlStr) => {
    try {
        const cleaned = cleanUrl(urlStr);
        const url = new URL(cleaned);
        return url.pathname.split('/')[1] || null;
    } catch {
        return null;
    }
};

/** True when this video may appear in the caller's playlist payload (no private-media leak). */
function videoVisibleInPlaylist(video, viewerUserId) {
    if (!video || video.status === 'banned') return false;
    if (viewerUserId != null && video.channel?.user_id === viewerUserId) return true;
    return video.status === 'safe' && video.processing_status === 'done';
}

const shapePlaylist = (pl, viewerUserId, { allowRawSas = true } = {}) => ({
    playlist_id: pl.playlist_id,
    name: pl.name,
    is_public: !!pl.is_public,
    created_at: pl.created_at,
    videos: (pl.items ?? [])
        .filter(it => videoVisibleInPlaylist(it.video, viewerUserId) && (allowRawSas || !!it.video?.hls_url))
        .map(it => {
            try {
                const rawUrl = it.video.raw_video_url && it.video.raw_video_url !== 'pending_upload' ? it.video.raw_video_url : null;
                const canSignRaw = allowRawSas && viewerUserId != null && it.video.channel?.user_id === viewerUserId;
                const processed_video_url = it.video.hls_url ?? (canSignRaw && rawUrl ? generateVideoReadSAS(process.env.AZURE_RAW_VIDEO_CONTAINER, rawUrl) : null);
                const cleanedThumbUrl = cleanUrl(it.video.thumbnail_url);
                const thumbContainer = cleanedThumbUrl ? (getContainerFromUrl(cleanedThumbUrl) || process.env.AZURE_THUMBNAIL_CONTAINER || 'thumbnails') : 'thumbnails';
                const thumbnail_url = cleanedThumbUrl ? (generateVideoReadSAS(thumbContainer, cleanedThumbUrl) ?? it.video.thumbnail_url) : null;
                const { raw_video_url: _raw, ...videoRest } = it.video;
                return {
                    ...videoRest,
                    processed_video_url,
                    thumbnail_url,
                    added_at: it.added_at
                };
            } catch (err) {
                console.error('[playlist] SAS sign failed', err?.message || err);
                const { raw_video_url: _raw, ...videoRest } = it.video;
                return { ...videoRest, added_at: it.added_at };
            }
        }),
});
const withItems = { items: { orderBy: { added_at: 'asc' }, include: { video: { select: ITEM_VIDEO_SELECT } } } };

/**
 * Resolve a video id/public_id/slug the caller is allowed to attach.
 * Public attach path uses visibleVideoWhere(); owners may still save their own non-banned videos.
 */
async function resolvePlayableVideoId(raw, viewerUserId) {
    if (raw == null || raw === '') return null;
    const token = String(raw).trim();
    const asNum = Number(token);
    const idClause = (Number.isFinite(asNum) && asNum > 0 && String(Math.trunc(asNum)) === token)
        ? { video_id: Math.trunc(asNum) }
        : { OR: [{ public_id: token }, { slug: token }] };

    const accessClause = {
        OR: [
            visibleVideoWhere(),
            ...(viewerUserId != null
                ? [{ status: { not: 'banned' }, channel: { user_id: viewerUserId } }]
                : []),
        ],
    };

    const video = await prisma.video.findFirst({
        where: { AND: [idClause, accessClause] },
        select: { video_id: true },
    });
    return video?.video_id ?? null;
}

async function addVideoItem(playlist_id, video_id) {
    await prisma.playlist_item.upsert({
        where: { playlist_id_video_id: { playlist_id, video_id } },
        create: { playlist_id, video_id },
        update: {},
    });
}

/** GET /playlist — list the authenticated user's playlists with their videos */
router.get('/', authenticateToken, async (req, res, next) => {
    try {
        const playlists = await prisma.playlist.findMany({
            where: { user_id: req.user.user_id },
            orderBy: { created_at: 'desc' },
            include: withItems,
        });
        res.json({ successful: true, data: playlists.map(pl => shapePlaylist(pl, req.user.user_id)) });
    } catch (err) { next(err); }
});

/** GET /playlist/channel/:channel_id — public playlists for a creator channel (no Mix lists). */
router.get('/channel/:channel_id', optionalAuth, async (req, res, next) => {
    try {
        const channel_id = Number(req.params.channel_id);
        if (!Number.isInteger(channel_id) || channel_id < 1) {
            return res.status(400).json({ successful: false, message: 'Invalid channel_id' });
        }
        const ch = await prisma.channel.findUnique({
            where: { channel_id },
            select: { user_id: true },
        });
        if (!ch) return res.status(404).json({ successful: false, message: 'Channel not found' });
        const playlists = await prisma.playlist.findMany({
            where: {
                user_id: ch.user_id,
                is_public: true,
                NOT: {
                    OR: [
                        { name: MIX_NAME },
                        { name: YOUR_MIX_NAME },
                        { name: { startsWith: MIX_PREFIX } },
                    ],
                },
            },
            orderBy: { created_at: 'desc' },
            include: withItems,
        });
        const viewerUserId = req.user?.user_id ?? null;
        res.json({ successful: true, data: playlists.map(pl => shapePlaylist(pl, viewerUserId, { allowRawSas: false })) });
    } catch (err) { next(err); }
});

/** POST /playlist — create a playlist { name, video_id? } */
router.post('/', authenticateToken, async (req, res, next) => {
    try {
        const name = (req.body?.name ?? '').toString().trim() || MIX_NAME;
        if (name.length > 120) return res.status(400).json({ successful: false, message: 'Playlist name too long.' });
        const requestedPublic = req.body?.is_public === true || req.body?.isPublic === true;
        const is_public = !isMixPlaylistName(name) && requestedPublic;
        const requestedId = req.body?.video_id ?? req.body?.videoId ?? null;
        const video_id = requestedId != null ? await resolvePlayableVideoId(requestedId, req.user.user_id) : null;
        if (requestedId != null && video_id == null) {
            return res.status(404).json({ successful: false, message: 'Video not found.' });
        }

        if (isMixPlaylistName(name)) {
            const existing = await prisma.playlist.findFirst({
                where: { user_id: req.user.user_id, name },
            });
            if (existing) {
                if (video_id) await addVideoItem(existing.playlist_id, video_id);
                const full = await prisma.playlist.findUnique({ where: { playlist_id: existing.playlist_id }, include: withItems });
                return res.json({ successful: true, data: shapePlaylist(full, req.user.user_id) });
            }
            const mixCount = await prisma.playlist.count({
                where: {
                    user_id: req.user.user_id,
                    OR: [{ name: MIX_NAME }, { name: { startsWith: MIX_PREFIX } }],
                },
            });
            if (mixCount >= MIX_CAP) {
                return res.status(400).json({ successful: false, message: 'Too many Mix playlists.' });
            }
        }

        const created = await prisma.playlist.create({ data: { user_id: req.user.user_id, name, is_public } });
        if (video_id) {
            await addVideoItem(created.playlist_id, video_id);
        }
        const full = await prisma.playlist.findUnique({ where: { playlist_id: created.playlist_id }, include: withItems });
        res.status(201).json({ successful: true, data: shapePlaylist(full, req.user.user_id) });
    } catch (err) { next(err); }
});

/** PATCH /playlist/:playlist_id — update playlist visibility { is_public } */
router.patch('/:playlist_id', authenticateToken, async (req, res, next) => {
    try {
        const playlist_id = Number(req.params.playlist_id);
        if (!Number.isInteger(playlist_id) || playlist_id < 1) {
            return res.status(400).json({ successful: false, message: 'playlist_id is required.' });
        }
        const pl = await prisma.playlist.findFirst({ where: { playlist_id, user_id: req.user.user_id } });
        if (!pl) return res.status(404).json({ successful: false, message: 'Playlist not found.' });
        if (isMixPlaylistName(pl.name)) {
            return res.status(400).json({ successful: false, message: 'Mix playlists cannot be public.' });
        }
        const nextPublic = req.body?.is_public === true || req.body?.isPublic === true;
        await prisma.playlist.update({ where: { playlist_id }, data: { is_public: nextPublic } });
        const full = await prisma.playlist.findUnique({ where: { playlist_id }, include: withItems });
        res.json({ successful: true, data: shapePlaylist(full, req.user.user_id) });
    } catch (err) { next(err); }
});

/** POST /playlist/:playlist_id/items — add a video { video_id } */
router.post('/:playlist_id/items', authenticateToken, async (req, res, next) => {
    try {
        const playlist_id = Number(req.params.playlist_id);
        if (Number.isNaN(playlist_id)) {
            return res.status(400).json({ successful: false, message: 'playlist_id is required.' });
        }
        const video_id = await resolvePlayableVideoId(req.body?.video_id ?? req.body?.videoId, req.user.user_id);
        if (video_id == null) {
            return res.status(404).json({ successful: false, message: 'Video not found.' });
        }
        const pl = await prisma.playlist.findFirst({ where: { playlist_id, user_id: req.user.user_id } });
        if (!pl) return res.status(404).json({ successful: false, message: 'Playlist not found.' });

        await addVideoItem(playlist_id, video_id);
        const full = await prisma.playlist.findUnique({ where: { playlist_id }, include: withItems });
        res.json({ successful: true, data: shapePlaylist(full, req.user.user_id) });
    } catch (err) { next(err); }
});

/** DELETE /playlist/:playlist_id/items/:video_id — remove a video */
router.delete('/:playlist_id/items/:video_id', authenticateToken, async (req, res, next) => {
    try {
        const playlist_id = Number(req.params.playlist_id);
        const video_id = Number(req.params.video_id);
        if (Number.isNaN(playlist_id) || Number.isNaN(video_id)) {
            return res.status(400).json({ successful: false, message: Number.isNaN(playlist_id) ? 'playlist_id is required.' : 'video_id is required.' });
        }
        const pl = await prisma.playlist.findFirst({ where: { playlist_id, user_id: req.user.user_id } });
        if (!pl) return res.status(404).json({ successful: false, message: 'Playlist not found.' });
        await prisma.playlist_item.deleteMany({ where: { playlist_id, video_id } });
        res.json({ successful: true });
    } catch (err) { next(err); }
});

/** DELETE /playlist/:playlist_id — delete a playlist */
router.delete('/:playlist_id', authenticateToken, async (req, res, next) => {
    try {
        const playlist_id = Number(req.params.playlist_id);
        if (Number.isNaN(playlist_id)) {
            return res.status(400).json({ successful: false, message: 'playlist_id is required.' });
        }
        const pl = await prisma.playlist.findFirst({ where: { playlist_id, user_id: req.user.user_id } });
        if (!pl) return res.status(404).json({ successful: false, message: 'Playlist not found.' });
        await prisma.playlist.delete({ where: { playlist_id } });
        res.json({ successful: true });
    } catch (err) { next(err); }
});

export default router;
