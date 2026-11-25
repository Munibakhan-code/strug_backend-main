import prisma from '../utils/prisma-client.js';
import { sendWebPushToProfile } from './web-push-service.js';
import { areUsersBlockedOnPlatform } from '../utils/platform-blocks.js';

export async function notifyChatRecipients(io, { channelId, senderId, messageId, content }) {
  if (!io) return [];
  if (process.env.CHAT_NOTIFICATIONS_DISABLED === 'true') return [];

  try {
    const senderProfile = await prisma.social_profile.findFirst({
      where: { user_id: senderId },
      select: { profile_id: true },
    });
    if (!senderProfile) return [];

    const recipients = await prisma.chat_participants.findMany({
      where: {
        channel_id: channelId,
        user_id: { not: senderId },
        muted: false,
      },
      include: {
        user: {
          select: {
            social_profiles: {
              select: { profile_id: true },
              take: 1,
            },
          },
        },
      },
    });

    const results = await Promise.all(recipients.map(async (participant) => {
      const receiverId = participant.user?.social_profiles?.[0]?.profile_id;
      if (!receiverId || receiverId === senderProfile.profile_id) return null;
      if (await areUsersBlockedOnPlatform(senderId, participant.user_id)) return null;

      const notification = await prisma.social_notification.create({
        data: {
          receiver_id: receiverId,
          sender_id: senderProfile.profile_id,
          type: 'CHAT_MESSAGE',
          target_id: messageId,
        },
        include: {
          sender: {
            select: { handle: true, profile_pic_url: true },
          },
        },
      });
      const title = notification.sender?.handle ? `Message from @${notification.sender.handle}` : 'New message';
      const body = content ? String(content).slice(0, 240) : 'Sent you a message';
      try {
        const row = await prisma.notification.create({
          data: {
            user_id: participant.user_id,
            vertical: 'social',
            type: 'chat.message',
            urgency: 'ambient',
            title,
            body,
            entity_type: 'chat_message',
            entity_id: messageId,
            action_url: `/messages?channel=${channelId}`,
            data: { channel_id: channelId, message_id: messageId, social_notification_id: notification.notification_id },
          },
        });
        io.to(`user-${participant.user_id}`).emit('notification:new', row);
      } catch (err) {
        console.error('Unified chat notification failed:', err.message);
      }
      io.to(`profile_${receiverId}`).emit('new-notification', {
        ...notification,
        channel_id: channelId,
        content: content ?? '',
      });

      // #193: background web push for the new message (fail-open, 'chat' category).
      sendWebPushToProfile(
        receiverId,
        {
          title: notification.sender?.handle ? `@${notification.sender.handle}` : 'New message',
          body,
          url: `/messages?channel=${channelId}`,
          icon: notification.sender?.profile_pic_url || '/favicon.ico',
          tag: `chat-${channelId}`,
          data: { channel_id: channelId, message_id: messageId },
        },
        'chat',
      ).catch(() => {});

      return notification;
    }));

    return results.filter(Boolean);
  } catch (error) {
    console.error('Chat notification failed:', error.message);
    return [];
  }
}
