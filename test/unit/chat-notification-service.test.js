import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '../../utils/prisma-client.js';
import { notifyChatRecipients } from '../../services/chat-notification-service.js';
import { sendWebPushToProfile } from '../../services/web-push-service.js';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    social_profile: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    social_block: { findFirst: vi.fn(), findMany: vi.fn() },
    chat_participants: { findMany: vi.fn() },
    social_notification: { create: vi.fn() },
    notification: { create: vi.fn() },
  },
}));

vi.mock('../../services/web-push-service.js', () => ({
  sendWebPushToProfile: vi.fn().mockResolvedValue({ sent: 0, skipped: 0 }),
}));

const io = { to: vi.fn(() => ({ emit: vi.fn() })) };

describe('notifyChatRecipients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CHAT_NOTIFICATIONS_DISABLED = 'false';
  });

  it('creates legacy and unified notification rows for every non-sender group recipient', async () => {
    prisma.social_profile.findFirst.mockResolvedValue({ profile_id: 10 });
    prisma.social_profile.findMany.mockResolvedValue([
      { user_id: 1, profile_id: 10 },
      { user_id: 2, profile_id: 20 },
      { user_id: 3, profile_id: 30 },
    ]);
    prisma.social_block.findFirst.mockResolvedValue(null);
    prisma.chat_participants.findMany.mockResolvedValue([
      { user_id: 1, user: { social_profiles: [{ profile_id: 10 }] } },
      { user_id: 2, user: { social_profiles: [{ profile_id: 20 }] } },
      { user_id: 3, user: { social_profiles: [{ profile_id: 30 }] } },
    ]);
    prisma.social_profile.findUnique
      .mockResolvedValueOnce({ user_id: 2 })
      .mockResolvedValueOnce({ user_id: 3 });
    prisma.social_notification.create
      .mockResolvedValueOnce({ notification_id: 101, sender: { handle: 'sender', profile_pic_url: null } })
      .mockResolvedValueOnce({ notification_id: 102, sender: { handle: 'sender', profile_pic_url: null } });
    prisma.notification.create
      .mockResolvedValueOnce({ notification_id: 201 })
      .mockResolvedValueOnce({ notification_id: 202 });

    const rows = await notifyChatRecipients(io, {
      channelId: 77,
      senderId: 1,
      messageId: 555,
      content: 'hello group',
    });

    expect(rows).toHaveLength(2);
    expect(prisma.social_notification.create).toHaveBeenCalledTimes(2);
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        user_id: 2,
        vertical: 'social',
        type: 'chat.message',
        title: 'Message from @sender',
        body: 'hello group',
        action_url: '/messages?channel=77',
        entity_type: 'chat_message',
        entity_id: 555,
      }),
    });
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        user_id: 3,
        vertical: 'social',
        type: 'chat.message',
        title: 'Message from @sender',
        body: 'hello group',
        action_url: '/messages?channel=77',
        entity_type: 'chat_message',
        entity_id: 555,
      }),
    });
    expect(sendWebPushToProfile).toHaveBeenCalledTimes(2);
  });
});
