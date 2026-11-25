import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { viewerCount as liveViewerCount } from '../services/live-presence.js';
import { authenticateToken } from '../middleware/authentication.js';
import { resolveLiveCategoryId } from '../services/live-category-resolver.js';
import { finalizeLiveSession } from '../services/live-session-finalize.js';

const router = express.Router();

// LNEW-6: the viewer count is best-effort everywhere else in the codebase; treat it the same
// here so a degraded backend never 500s the dashboard.
//
// This used to read the Redis set directly, which meant it reported 0 on a Redis-less prod —
// i.e. the number the streamer stares at while broadcasting was always zero. Delegates to
// services/live-presence.js, which falls back to socket-room membership.
async function safeViewerCount(io, session_id, hostUserId = null) {
    try {
        return await liveViewerCount(io, session_id, hostUserId);
    } catch (err) {
        console.debug(`[live-dashboard] viewer-count unavailable for ${session_id}:`, err?.message);
        return 0;
    }
}

const updateMetadataSchema = z.object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).optional().nullable(),
    category_id: z.number().int().positive().optional(),
    category_name: z.string().min(1).max(100).optional(),
});

// Consolidated Stream Manager payload — active session, playback, chat history, subs.
router.get('/manager', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;
        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id },
            include: { category: { select: { category_id: true, category_name: true } } },
        });
        if (!profile) {
            return res.json({ successful: true, data: { profile: null, session: null } });
        }

        const session = await prisma.live_session.findFirst({
            where: { streamer_id: profile.streamer_id, status: { in: ['STARTING', 'LIVE'] } },
            orderBy: { created_at: 'desc' },
        });

        let viewer_count = 0;
        let recent_chat = [];
        if (session) {
            viewer_count = await safeViewerCount(req.app.get('io'), session.session_id, req.user.user_id);
            recent_chat = await prisma.live_chat_message.findMany({
                where: { session_id: session.session_id },
                orderBy: { created_at: 'desc' },
                take: 40,
                select: {
                    message_id: true,
                    user_id: true,
                    username: true,
                    text: true,
                    created_at: true,
                },
            });
            recent_chat.reverse();
        }

        const recent_subscribers = await prisma.live_subscription.findMany({
            where: { streamer_id: profile.streamer_id, status: 'active' },
            orderBy: { created_at: 'desc' },
            take: 15,
            select: {
                subscription_id: true,
                created_at: true,
                subscriber: { select: { user_id: true, username: true, name: true } },
            },
        });

        return res.json({
            successful: true,
            data: {
                profile: {
                    streamer_id: profile.streamer_id,
                    handle: profile.handle,
                    display_name: profile.display_name,
                    category: profile.category,
                    chat_mode: profile.chat_mode,
                    slow_mode_ms: profile.slow_mode_ms,
                },
                session: session ? { ...session, viewer_count } : null,
                recent_chat,
                recent_subscribers,
            },
        });
    } catch (err) {
        next(err);
    }
});

router.patch('/:session_id/metadata', authenticateToken, async (req, res, next) => {
    try {
        const session_id = Number(req.params.session_id);
        const validated = updateMetadataSchema.parse(req.body);

        const session = await prisma.live_session.findUnique({
            where: { session_id },
            include: { streamer: true }
        });

        if (!session || session.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: "Unauthorized" });
        }

        const sessionData = {};
        if (validated.title != null) sessionData.title = validated.title;
        if (validated.description !== undefined) {
            sessionData.description = validated.description?.trim() || null;
        }

        const updated = await prisma.live_session.update({
            where: { session_id },
            data: sessionData,
        });

        const resolvedCategoryId = await resolveLiveCategoryId({
            category_id: validated.category_id,
            category_name: validated.category_name,
        });
        if (resolvedCategoryId) {
            await prisma.live_streamer_profile.update({
                where: { streamer_id: session.streamer_id },
                data: { category_id: resolvedCategoryId },
            });
        }

        const io = req.app.get('io');
        io.to(`stream_${session_id}`).emit('metadata-updated', {
            session_id: updated.session_id,
            title: updated.title,
            description: updated.description,
            thumbnail_url: updated.thumbnail_url,
            status: updated.status,
        });

        return res.json({ successful: true, data: updated });
    } catch (err) {
        next(err);
    }
});


router.get('/:session_id/stats', authenticateToken, async (req, res, next) => {
    try {
        const session_id = Number(req.params.session_id);
        if (!Number.isInteger(session_id)) return res.status(400).json({ message: "Invalid session id." });

        // LNEW-7: a dashboard stat is owner-only.
        const session = await prisma.live_session.findUnique({
            where: { session_id },
            include: { streamer: true }
        });
        if (!session || session.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: "Unauthorized" });
        }

        const viewerCount = await safeViewerCount(req.app.get('io'), session_id, session.streamer.user_id);

        return res.json({
            successful: true,
            stats: {
                concurrent_viewers: viewerCount,
                // Measured latency needs MediaMTX scrape; omit stub rather than invent 150ms.
                latency_ms: null,
            }
        });
    } catch (err) {
        next(err);
    }
});

router.post('/:session_id/kill', authenticateToken, async (req, res, next) => {
    try {
        const session_id = Number(req.params.session_id);
        if (!Number.isInteger(session_id)) return res.status(400).json({ message: "Invalid session id." });

        // LNEW-3: only the broadcaster may kill their own stream (was a blind update-by-id IDOR).
        const session = await prisma.live_session.findUnique({
            where: { session_id },
            include: { streamer: true }
        });
        if (!session || session.streamer.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: "Unauthorized" });
        }

        // Same finalize path as OBS disconnect / End Stream so VOD hooks + stream-ended stay consistent.
        const { updated, session: finalized } = await finalizeLiveSession({
            sessionId: session_id,
            session,
            status: 'CANCELLED',
            io: req.app.get('io'),
            emitExtra: { reason: 'Streamer_Action' },
            archive: false,
        });

        return res.json({
            successful: true,
            message: "Stream_Killed",
            data: { session: finalized, updated: Boolean(updated) },
        });
    } catch (err) {
        next(err);
    }
});

export default router;