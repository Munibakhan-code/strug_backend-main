import { beforeEach, describe, expect, it, vi } from 'vitest';

const notificationCreate = vi.fn();
const sendWebPushToUser = vi.fn();

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    notification: { create: notificationCreate },
  },
}));

vi.mock('../../services/web-push-service.js', () => ({
  PUSH_CATEGORIES: [
    'chat', 'social', 'orders', 'rides', 'work', 'quotes',
    'live', 'video', 'townhall', 'payments', 'system',
  ],
  sendWebPushToUser,
}));

describe('notify push categories', () => {
  beforeEach(() => {
    notificationCreate.mockReset();
    sendWebPushToUser.mockReset();
  });

  it('sends town hall notifications through the townhall push category', async () => {
    notificationCreate.mockResolvedValue({
      notification_id: 12,
      user_id: 7,
      vertical: 'townhall',
      type: 'townhall.like',
      title: 'Someone liked your Town Hall post',
    });
    sendWebPushToUser.mockResolvedValue({ sent: 1, skipped: 0 });
    const io = { to: vi.fn(() => ({ emit: vi.fn() })) };

    const { notify } = await import('../../services/notify.js');
    await notify(io, {
      userId: 7,
      vertical: 'townhall',
      type: 'townhall.like',
      title: 'Someone liked your Town Hall post',
      entityType: 'town_hall_post',
      entityId: 44,
      actionUrl: 'social',
    });

    expect(sendWebPushToUser).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        title: 'Someone liked your Town Hall post',
        tag: 'town_hall_post-44',
        data: expect.objectContaining({
          vertical: 'townhall',
          type: 'townhall.like',
          notification_id: 12,
        }),
      }),
      'townhall',
    );
  });
});
