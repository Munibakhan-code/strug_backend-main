// utils/notification-service.js
import prisma from './prisma-client.js';
import {
  sendWebPushToProfile,
  categoryForNotificationType,
} from '../services/web-push-service.js';
import { notify } from '../services/notify.js';
import { areSocialProfilesBlocked } from './platform-blocks.js';

// Deep-link target per social event. FOLLOW points at the follower's profile; the rest at the feed.
const SOCIAL_ACTION_URL = 'social';

// Human-readable one-liner for a social notification, used as the push body.
function describeNotification({ type, senderHandle }) {
  const who = senderHandle ? `@${senderHandle}` : 'Someone';
  switch (String(type || '').toUpperCase()) {
    case 'FOLLOW': return `${who} started following you`;
    case 'LIKE': return `${who} liked your post`;
    case 'COMMENT': return `${who} commented on your post`;
    case 'REPLY': return `${who} replied to you`;
    case 'MENTION': return `${who} mentioned you`;
    default: return `${who} sent you a notification`;
  }
}

/**

 */
export const createNotification = async (io, { receiver_id, sender_id, type, target_id }) => {
    try {

        if (receiver_id === sender_id) return null;
        if (await areSocialProfilesBlocked(receiver_id, sender_id)) return null;


        const notification = await prisma.social_notification.create({
            data: { receiver_id, sender_id, type, target_id },
            include: {
                sender: { select: { handle: true, profile_pic_url: true } }
            }
        });


        io.to(`profile_${receiver_id}`).emit('new-notification', notification);

        // Epic 10: mirror into the unified `notification` table so social events reach the global
        // bell as first-class rows (and become filterable / mutable like every other vertical).
        //
        // ⚠️ TWO THINGS TO KNOW HERE:
        //  1. This silo is keyed on social_profile.profile_id; `notification` is keyed on user_id.
        //     They are DIFFERENT id spaces — writing receiver_id straight through would file the
        //     row against whatever user happens to share that integer. Resolve it.
        //  2. push:false — sendWebPushToProfile() below already pushes this same event. Letting
        //     notify() push too would double-notify every follow/like on the user's device.
        prisma.social_profile
	          .findUnique({ where: { profile_id: receiver_id }, select: { user_id: true } })
	          .then(async (receiver) => {
	            if (!receiver?.user_id) return;
	            const senderUser = await prisma.social_profile.findUnique({
	              where: { profile_id: sender_id },
	              select: { user_id: true },
	            });
	            // #472 deep-link target. LIKE/COMMENT/MENTION point at the liked/commented post
	            // (a feed post). FOLLOW points at the FOLLOWER'S PROFILE — but the app keys profiles
	            // on user_id, while sender_id/target_id here are the follower's profile_id, so resolve it.
	            let entityType = 'social_post';
	            let entityId = target_id ?? null;
	            let actionUrl = SOCIAL_ACTION_URL;
	            if (String(type || '').toUpperCase() === 'FOLLOW') {
	              entityType = 'profile';
	              entityId = senderUser?.user_id ?? null;
	              actionUrl = 'profile';
	            }
            notify(io, {
              userId: receiver.user_id,
              actorUserId: senderUser?.user_id ?? null,
              vertical: 'social',
              type: `social.${String(type || '').toLowerCase()}`,
              title: describeNotification({ type, senderHandle: notification.sender?.handle }),
              urgency: 'ambient',
              entityType,
              entityId,
              actionUrl,
              data: { sender_profile_id: sender_id, sender_user_id: senderUser?.user_id ?? null },
              push: false,
            });
          })
          .catch(() => {});

        // #193: also deliver a background web push (fail-open, category-gated).
        sendWebPushToProfile(
          receiver_id,
          {
            title: 'Strug',
            body: describeNotification({ type, senderHandle: notification.sender?.handle }),
            url: '/notifications',
            icon: notification.sender?.profile_pic_url || '/favicon.ico',
            tag: `notif-${type}-${target_id ?? ''}`,
            data: { type, target_id },
          },
          categoryForNotificationType(type),
        ).catch(() => {});

        console.log(`🔔 [Notification] ${type} sent to Profile:${receiver_id}`);
        return notification;
    } catch (err) {
        console.error("❌ Notification Service Error:", err.message);
    }
};
