import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { areUsersBlockedOnPlatform } from '../utils/platform-blocks.js';

const router = express.Router();

const chatSettingsSchema = z.object({
    chat_mode: z.enum(['PUBLIC', 'FOLLOWERS_ONLY', 'SUBSCRIBERS_ONLY']).optional(),
    slow_mode_ms: z.number().int().min(0).max(30000).optional()
});

// The caller's own streamer channel (the channel a streamer moderates from their dashboard).
async function getOwnerProfile(user_id) {
    return prisma.live_streamer_profile.findUnique({ where: { user_id } });
}

// Resolve a ban/mod target from an explicit user id OR a @username (so the dashboard can
// act on someone by handle, not just numeric id).
async function resolveTargetUserId({ target_user_id, target_username }) {
    if (target_user_id != null && !Number.isNaN(Number(target_user_id))) return Number(target_user_id);
    if (target_username) {
        const handle = String(target_username).trim().replace(/^@/, '');
        if (!handle) return null;
        const u = await prisma.user.findUnique({ where: { username: handle }, select: { user_id: true } });
        return u?.user_id ?? null;
    }
    return null;
}

// Shape a related user for the dashboard lists (never leak more than display fields).
const publicUser = { select: { user_id: true, username: true, name: true } };

const CHAT_COLORS = ['#bf94ff', '#00c8b0', '#ff7b72', '#58a6ff', '#f778ba', '#8b949e', '#ffab70', '#79c0ff'];

function chatColorFor(userIdOrName) {
    const s = String(userIdOrName || '');
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return CHAT_COLORS[h % CHAT_COLORS.length];
}

function formatChatClock(offsetSec) {
    const s = Math.max(0, Math.floor(Number(offsetSec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
}

// Public replay of chat from a finished (or still-live) session — powers VOD "Chat on Videos".
// Offsets are seconds from session start so the player can sync messages to currentTime.
router.get('/replay/:session_id', optionalAuth, async (req, res, next) => {
    try {
        const session_id = Number(req.params.session_id);
        if (!Number.isInteger(session_id)) {
            return res.status(400).json({ successful: false, message: 'Invalid_Session_Id' });
        }

        const session = await prisma.live_session.findUnique({
            where: { session_id },
            select: {
                session_id: true,
                started_at: true,
                created_at: true,
                streamer: { select: { is_active: true, user_id: true } },
            },
        });
        if (!session || session.streamer?.is_active === false) {
            return res.status(404).json({ successful: false, message: 'Session_Not_Found' });
        }
        if (session.streamer?.user_id && req.user?.user_id && await areUsersBlockedOnPlatform(req.user.user_id, session.streamer.user_id)) {
            return res.status(404).json({ successful: false, message: 'Session_Not_Found' });
        }

        const rows = await prisma.live_chat_message.findMany({
            where: { session_id },
            orderBy: { created_at: 'asc' },
            take: 2000,
            select: {
                message_id: true,
                user_id: true,
                username: true,
                text: true,
                created_at: true,
            },
        });

        const originMs = new Date(session.started_at || session.created_at).getTime();
        const data = rows.map((row) => {
            const offset_sec = Math.max(0, (new Date(row.created_at).getTime() - originMs) / 1000);
            return {
                id: row.message_id,
                user_id: row.user_id,
                user: row.username || `User ${row.user_id}`,
                text: row.text,
                color: chatColorFor(row.user_id ?? row.username),
                offset_sec,
                t: formatChatClock(offset_sec),
                created_at: row.created_at,
            };
        });

        return res.json({
            successful: true,
            data: {
                session_id,
                started_at: session.started_at || session.created_at,
                messages: data,
            },
        });
    } catch (err) {
        next(err);
    }
});

router.patch('/settings', authenticateToken, async (req, res, next) => {
    try {
        const validated = chatSettingsSchema.parse(req.body);
        const user_id = req.user.user_id;

        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id }
        });

        if (!profile) return res.status(404).json({ message: "Profile_Not_Found" });

        const updated = await prisma.live_streamer_profile.update({
            where: { streamer_id: profile.streamer_id },
            data: validated
        });

        const io = req.app.get('io');
        io.to(`stream_channel_${profile.streamer_id}`).emit('chat-settings-updated', validated);

        return res.json({
            successful: true,
            data: {
                streamer_id: updated.streamer_id,
                chat_mode: updated.chat_mode,
                slow_mode_ms: updated.slow_mode_ms,
            }
        });
    } catch (err) {
        next(err);
    }
});

router.post('/moderator/add', authenticateToken, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;

        const profile = await getOwnerProfile(user_id);
        if (!profile) return res.status(404).json({ message: "Profile_Not_Found" });

        const targetId = await resolveTargetUserId(req.body);
        if (!targetId) return res.status(400).json({ message: "Target_Not_Found" });
        if (targetId === user_id) return res.status(400).json({ message: "Cannot_Moderate_Self" });

        const mod = await prisma.live_chat_moderator.create({
            data: {
                streamer_id: profile.streamer_id,
                user_id: targetId
            },
            include: { user: publicUser }
        });

        return res.status(201).json({ successful: true, data: mod });
    } catch (err) {
        if (err.code === 'P2002') return res.status(409).json({ message: "Already_Moderator" });
        next(err);
    }
});

// List the moderators the caller has appointed on their own channel.
router.get('/moderators', authenticateToken, async (req, res, next) => {
    try {
        const profile = await getOwnerProfile(req.user.user_id);
        if (!profile) return res.status(404).json({ message: "Profile_Not_Found" });

        const mods = await prisma.live_chat_moderator.findMany({
            where: { streamer_id: profile.streamer_id },
            include: { user: publicUser },
            orderBy: { created_at: 'desc' }
        });

        return res.json({ successful: true, data: mods });
    } catch (err) {
        next(err);
    }
});

router.delete('/moderator/:user_id', authenticateToken, async (req, res, next) => {
    try {
        const profile = await getOwnerProfile(req.user.user_id);
        if (!profile) return res.status(404).json({ message: "Profile_Not_Found" });

        const targetId = Number(req.params.user_id);
        if (Number.isNaN(targetId)) return res.status(400).json({ message: "Invalid_User" });

        await prisma.live_chat_moderator.deleteMany({
            where: { streamer_id: profile.streamer_id, user_id: targetId }
        });

        return res.json({ successful: true });
    } catch (err) {
        next(err);
    }
});

router.post('/ban', authenticateToken, async (req, res, next) => {
    try {
        const { reason, duration_minutes, streamer_id } = req.body;
        const user_id = req.user.user_id;

        const target_user_id = await resolveTargetUserId(req.body);
        if (target_user_id == null) return res.status(400).json({ message: "Target_Not_Found" });

        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id }
        });

        // Resolve which channel the ban targets. Prefer an explicit streamer_id (so a
        // moderator can act on the channel they moderate, not their own); fall back to the
        // caller's own channel for the common streamer-bans-on-own-channel case.
        const streamerId = Number(streamer_id ?? profile?.streamer_id);
        if (!streamerId || Number.isNaN(streamerId)) {
            return res.status(400).json({ message: "streamer_id required" });
        }

        // Authorize against THAT channel: caller must own it or moderate it.
        const isOwner = profile?.streamer_id === streamerId;
        const isMod = isOwner ? null : await prisma.live_chat_moderator.findFirst({
            where: { streamer_id: streamerId, user_id }
        });
        if (!isOwner && !isMod) return res.status(403).json({ message: "Unauthorized" });

        // Never let anyone ban the channel owner.
        const targetId = Number(target_user_id);
        const channel = await prisma.live_streamer_profile.findUnique({
            where: { streamer_id: streamerId }, select: { user_id: true }
        });
        if (!channel) return res.status(404).json({ message: "Channel_Not_Found" });
        if (channel.user_id === targetId) return res.status(400).json({ message: "Cannot_Ban_Channel_Owner" });

        const expiresAt = duration_minutes ? new Date(Date.now() + duration_minutes * 60000) : null;

        const ban = await prisma.live_chat_ban.upsert({
            where: { streamer_id_user_id: { streamer_id: streamerId, user_id: targetId } },
            update: { reason, expires_at: expiresAt },
            create: { streamer_id: streamerId, user_id: targetId, reason, expires_at: expiresAt }
        });

        const io = req.app.get('io');
        // Public chat-moderation event for the viewers of THIS stream — scope it to the stream's
        // room instead of io.emit (which broadcast the banned user_id to every connected socket
        // app-wide). Target the active session room (where chat viewers are); fall back to the
        // per-channel room. Optional-chain io so supertest (no socket server) doesn't throw.
        if (io) {
            const activeSession = await prisma.live_session.findFirst({
                where: { streamer_id: streamerId, status: { in: ['STARTING', 'LIVE'] } },
                orderBy: { created_at: 'desc' },
                select: { session_id: true },
            });
            const room = activeSession ? `stream_${activeSession.session_id}` : `stream_channel_${streamerId}`;
            io.to(room).emit(`chat_ban_${streamerId}`, { user_id: targetId, expires_at: expiresAt });
        }

        return res.json({ successful: true, data: ban });
    } catch (err) {
        next(err);
    }
});

// List bans on the caller's own channel (active + expired; the dashboard flags expired ones).
router.get('/bans', authenticateToken, async (req, res, next) => {
    try {
        const profile = await getOwnerProfile(req.user.user_id);
        if (!profile) return res.status(404).json({ message: "Profile_Not_Found" });

        const bans = await prisma.live_chat_ban.findMany({
            where: { streamer_id: profile.streamer_id },
            include: { user: publicUser },
            orderBy: { created_at: 'desc' }
        });

        return res.json({ successful: true, data: bans });
    } catch (err) {
        next(err);
    }
});

// Lift a ban (unban) — owner or moderator of the channel.
router.delete('/ban/:user_id', authenticateToken, async (req, res, next) => {
    try {
        const targetId = Number(req.params.user_id);
        if (Number.isNaN(targetId)) return res.status(400).json({ message: "Invalid_User" });

        const streamerId = Number(req.query.streamer_id || req.body?.streamer_id);
        const profile = await getOwnerProfile(req.user.user_id);
        const channelId = streamerId || profile?.streamer_id;
        if (!channelId) return res.status(404).json({ message: "Profile_Not_Found" });

        const isOwner = profile?.streamer_id === channelId;
        const isMod = !isOwner && await prisma.live_chat_moderator.findFirst({
            where: { streamer_id: channelId, user_id: req.user.user_id },
        });
        if (!isOwner && !isMod) return res.status(403).json({ message: "Unauthorized" });

        await prisma.live_chat_ban.deleteMany({
            where: { streamer_id: channelId, user_id: targetId },
        });

        const io = req.app.get('io');
        if (io) {
            const activeSession = await prisma.live_session.findFirst({
                where: { streamer_id: channelId, status: { in: ['STARTING', 'LIVE'] } },
                orderBy: { created_at: 'desc' },
                select: { session_id: true },
            });
            const room = activeSession ? `stream_${activeSession.session_id}` : `stream_channel_${channelId}`;
            io.to(room).emit(`chat_unban_${channelId}`, { user_id: targetId });
        }

        return res.json({ successful: true });
    } catch (err) {
        next(err);
    }
});

router.post('/words', authenticateToken, async (req, res, next) => {
    try {
        const { word } = req.body;
        const user_id = req.user.user_id;

        const profile = await prisma.live_streamer_profile.findUnique({
            where: { user_id }
        });

        if (!profile) return res.status(403).json({ message: "Unauthorized" });
        const cleaned = String(word || '').trim().toLowerCase();
        if (!cleaned || cleaned === 'undefined') {
            return res.status(400).json({ message: "Invalid_Word" });
        }

        const newWord = await prisma.live_banned_word.create({
            data: {
                streamer_id: profile.streamer_id,
                word: cleaned,
            }
        });

        return res.status(201).json({ successful: true, data: newWord });
    } catch (err) {
        if (err.code === 'P2002') return res.status(409).json({ message: "Already_Blocked" });
        next(err);
    }
});

// List the caller's blocked words (automod filter).
router.get('/words', authenticateToken, async (req, res, next) => {
    try {
        const profile = await getOwnerProfile(req.user.user_id);
        if (!profile) return res.status(404).json({ message: "Profile_Not_Found" });

        const words = await prisma.live_banned_word.findMany({
            where: { streamer_id: profile.streamer_id },
            orderBy: { word: 'asc' }
        });

        return res.json({ successful: true, data: words });
    } catch (err) {
        next(err);
    }
});

router.delete('/words/:word_id', authenticateToken, async (req, res, next) => {
    try {
        const profile = await getOwnerProfile(req.user.user_id);
        if (!profile) return res.status(404).json({ message: "Profile_Not_Found" });

        const wordId = Number(req.params.word_id);
        if (Number.isNaN(wordId)) return res.status(400).json({ message: "Invalid_Word" });

        // Scope the delete to the caller's channel so nobody can remove another streamer's word.
        await prisma.live_banned_word.deleteMany({
            where: { word_id: wordId, streamer_id: profile.streamer_id }
        });

        return res.json({ successful: true });
    } catch (err) {
        next(err);
    }
});

// The caller's current chat settings (drives the dashboard form).
router.get('/settings', authenticateToken, async (req, res, next) => {
    try {
        const profile = await getOwnerProfile(req.user.user_id);
        if (!profile) return res.status(404).json({ message: "Profile_Not_Found" });

        return res.json({
            successful: true,
            data: {
                streamer_id: profile.streamer_id,
                chat_mode: profile.chat_mode,
                slow_mode_ms: profile.slow_mode_ms
            }
        });
    } catch (err) {
        next(err);
    }
});

router.get('/banned-check/:streamer_id', authenticateToken, async (req, res, next) => {
    try {
        const streamer_id = Number(req.params.streamer_id);
        const user_id = req.user.user_id;

        const ban = await prisma.live_chat_ban.findFirst({
            where: {
                streamer_id,
                user_id,
                OR: [
                    { expires_at: null },
                    { expires_at: { gte: new Date() } }
                ]
            }
        });

        return res.json({ is_banned: !!ban, details: ban });
    } catch (err) {
        next(err);
    }
});

// Delete a chat message (owner or mod) and broadcast removal to the room.
router.delete('/message/:message_id', authenticateToken, async (req, res, next) => {
    try {
        const message_id = Number(req.params.message_id);
        if (!Number.isInteger(message_id)) {
            return res.status(400).json({ successful: false, message: 'Invalid_Message' });
        }
        const msg = await prisma.live_chat_message.findUnique({
            where: { message_id },
            include: {
                session: {
                    select: {
                        session_id: true,
                        streamer_id: true,
                        streamer: { select: { user_id: true } },
                    },
                },
            },
        });
        if (!msg) return res.status(404).json({ successful: false, message: 'Not_Found' });

        const streamerId = msg.session.streamer_id;
        const isOwner = msg.session.streamer.user_id === req.user.user_id;
        const isMod = !isOwner && await prisma.live_chat_moderator.findFirst({
            where: { streamer_id: streamerId, user_id: req.user.user_id },
        });
        if (!isOwner && !isMod) return res.status(403).json({ successful: false, message: 'Unauthorized' });

        await prisma.live_chat_message.delete({ where: { message_id } });
        const io = req.app.get('io');
        io?.to(`stream_${msg.session.session_id}`).emit('live:chat-deleted', {
            message_id,
            session_id: msg.session.session_id,
        });
        return res.json({ successful: true });
    } catch (err) {
        next(err);
    }
});

// Temporary timeout (ban with short expiry) — owner or mod.
router.post('/timeout', authenticateToken, async (req, res, next) => {
    try {
        const duration_minutes = Math.min(Math.max(Number(req.body.duration_minutes) || 10, 1), 24 * 60);
        const streamer_id = Number(req.body.streamer_id);
        const target_user_id = await resolveTargetUserId(req.body);
        if (target_user_id == null) return res.status(400).json({ message: 'Target_Not_Found' });
        if (!streamer_id) return res.status(400).json({ message: 'streamer_id required' });

        const profile = await prisma.live_streamer_profile.findUnique({ where: { user_id: req.user.user_id } });
        const isOwner = profile?.streamer_id === streamer_id;
        const isMod = !isOwner && await prisma.live_chat_moderator.findFirst({
            where: { streamer_id, user_id: req.user.user_id },
        });
        if (!isOwner && !isMod) return res.status(403).json({ message: 'Unauthorized' });

        const expires_at = new Date(Date.now() + duration_minutes * 60000);
        const ban = await prisma.live_chat_ban.upsert({
            where: { streamer_id_user_id: { streamer_id, user_id: Number(target_user_id) } },
            update: { reason: req.body.reason || 'timeout', expires_at },
            create: {
                streamer_id,
                user_id: Number(target_user_id),
                reason: req.body.reason || 'timeout',
                expires_at,
            },
        });
        return res.json({ successful: true, data: ban });
    } catch (err) {
        next(err);
    }
});

export default router;
