// services/live-notify.js
// Live alerts (#259): when a streamer goes live, notify their followers via the existing
// social-notification system — persisted row + real-time socket + optional web push.
// Fire-and-forget and fail-open: a notification problem must never block going live.
import prisma from '../utils/prisma-client.js';
import { sendWebPushToUser } from './web-push-service.js';
import { notify } from './notify.js';

/**
 * Notify a streamer's followers that they've just gone live.
 * Call this once, right after a session transitions to LIVE.
 *
 * @param {number} streamerId  live_streamer_profile.streamer_id
 * @param {import('socket.io').Server} [io]  socket server for instant delivery (optional)
 */
export async function notifyFollowersLive(streamerId, io) {
    try {
        const sid = Number(streamerId);
        if (!Number.isInteger(sid)) return;

        const streamer = await prisma.live_streamer_profile.findUnique({
            where: { streamer_id: sid },
            select: { user_id: true, handle: true, display_name: true },
        });
        if (!streamer) return;

        // The streamer's social profile is the "sender" of the notification. If they have no
        // social profile there's nothing to attribute a follow graph to — nothing to send.
        const sender = await prisma.social_profile.findUnique({
            where: { user_id: streamer.user_id },
            select: { profile_id: true },
        });
        if (!sender) return;

        const follows = await prisma.follower.findMany({
            where: { following_id: sender.profile_id },
            select: { follower: { select: { profile_id: true, user_id: true } } },
            // Soft cap — huge follow graphs must not stall the go-live path.
            take: 5000,
        });
        if (!follows.length) return;

        const displayName = streamer.display_name || `@${streamer.handle}`;
        const socketPayload = {
            type: 'LIVE',
            sender_id: streamer.user_id,
            streamer_id: sid,
            streamer_handle: streamer.handle,
            display_name: displayName,
            message: `${displayName} is live`,
        };
        const pushPayload = {
            title: `${displayName} is live`,
            body: 'Tap to watch the stream',
            url: '/live',
            data: { type: 'LIVE', streamer_handle: streamer.handle },
        };

        // Chunk persist + fan-out so we never hold one giant createMany / await loop on the
        // RTMP ready path. Callers should still fire-and-forget this function.
        const CHUNK = 200;
        for (let i = 0; i < follows.length; i += CHUNK) {
            const chunk = follows.slice(i, i + CHUNK);
            await prisma.social_notification.createMany({
                data: chunk.map((f) => ({
                    receiver_id: f.follower.profile_id,
                    sender_id: sender.profile_id,
                    type: 'LIVE',
                    target_id: sid,
                })),
            });

            for (const f of chunk) {
                const uid = f.follower.user_id;
                if (!uid) continue;
                if (io) io.to(`user-${uid}`).emit('social-notification', socketPayload);
                sendWebPushToUser(uid, pushPayload, 'live').catch(() => {});
                // Durable row for the global bell. push:false — sendWebPushToUser above already pushed
                // this exact event; letting notify() push too would double-buzz every follower.
                notify(io, {
                    userId: uid,
                    vertical: 'live',
                    type: 'live.started',
                    title: `${displayName} is live`,
                    body: 'Tap to watch the stream',
                    urgency: 'ambient',
                    entityType: 'live_streamer_profile',
                    entityId: sid,
                    actionUrl: 'live',
                    data: { streamer_handle: streamer.handle },
                    push: false,
                });
            }
        }

        // Also ping users who opted into "Notify me" on an upcoming schedule for this streamer.
        try {
            const upcoming = await prisma.live_stream_schedule.findMany({
                where: {
                    streamer_id: sid,
                    is_cancelled: false,
                    scheduled_at: {
                        gte: new Date(Date.now() - 6 * 60 * 60 * 1000),
                        lte: new Date(Date.now() + 6 * 60 * 60 * 1000),
                    },
                },
                select: { schedule_id: true },
                take: 5,
            });
            for (const sch of upcoming) {
                // Opt-ins are rows now, not a Redis set that silently read back empty.
                // Only un-notified ones, so a re-run (sweep restart, duplicate ready hook)
                // cannot double-notify — notify() itself is not idempotent.
                const reminders = await prisma.live_schedule_reminder.findMany({
                    where: { schedule_id: sch.schedule_id, notified_at: null },
                    select: { id: true, user_id: true },
                    take: 5000,
                });
                for (const reminder of reminders) {
                    const uid = Number(reminder.user_id);
                    if (!uid) continue;
                    if (io) io.to(`user-${uid}`).emit('social-notification', socketPayload);
                    notify(io, {
                        userId: uid,
                        vertical: 'live',
                        type: 'live.started',
                        title: `${displayName} is live`,
                        body: 'A stream you asked to be reminded about just started',
                        urgency: 'ambient',
                        entityType: 'live_streamer_profile',
                        entityId: sid,
                        actionUrl: 'live',
                        data: { streamer_handle: streamer.handle, schedule_id: sch.schedule_id },
                        push: false,
                    });
                }
                // Stamp rather than delete: keeps the opt-in as a growth signal and makes
                // the loop above idempotent.
                if (reminders.length) {
                    await prisma.live_schedule_reminder.updateMany({
                        where: { id: { in: reminders.map((r) => r.id) } },
                        data: { notified_at: new Date() },
                    });
                }
            }
        } catch (err) {
            console.debug('[live-notify] schedule remind soft-fail:', err?.message);
        }
    } catch (err) {
        console.error('[live-notify] fail-open:', err?.message);
    }
}
