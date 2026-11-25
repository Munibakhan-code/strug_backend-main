import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sanitizeHandle, checkHandleAvailability } from '../../utils/handle-availability.js';
import prisma from '../../utils/prisma-client.js';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    user: { findFirst: vi.fn() },
    social_profile: { findFirst: vi.fn() },
    vertical_profile: { findFirst: vi.fn() },
    live_streamer_profile: { findFirst: vi.fn() },
    channel: { findFirst: vi.fn() }
  }
}));

describe('Handle Availability Utility Tests', () => {
  it.each(['user', 'social_profile', 'vertical_profile', 'channel'])('checks other-owner and same-owner handles in %s', async namespace => {
    for (const key of ['user', 'social_profile', 'vertical_profile', 'channel']) prisma[key].findFirst.mockResolvedValue(null);
    prisma[namespace].findFirst.mockResolvedValue({user_id:50});
    expect((await checkHandleAvailability('My_Handle', 99)).available).toBe(false);
    expect((await checkHandleAvailability('My_Handle', 50)).available).toBe(true);
    expect(prisma[namespace].findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({[namespace === 'user' ? 'username' : 'handle']:{equals:'my_handle',mode:'insensitive'}})}));
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should sanitize handle string correctly', () => {
    expect(sanitizeHandle(' My_Handle_123! ')).toBe('my_handle_123');
    expect(sanitizeHandle('STRUG.CA')).toBe('strug.ca');
    expect(sanitizeHandle('foo.bar')).toBe('foo.bar');
    expect(sanitizeHandle('foo.bar')).not.toBe('foobar');
    expect(sanitizeHandle('')).toBe('');
  });

  it('should return available true when no collisions exist', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.social_profile.findFirst.mockResolvedValue(null);
    prisma.vertical_profile.findFirst.mockResolvedValue(null);
    prisma.live_streamer_profile.findFirst.mockResolvedValue(null);
    prisma.channel.findFirst.mockResolvedValue(null);

    const result = await checkHandleAvailability('foo.bar');
    expect(result.available).toBe(true);
    expect(prisma.social_profile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { handle: { equals: 'foo.bar', mode: 'insensitive' } },
      }),
    );
  });

  it('should detect collisions in channel schema', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.social_profile.findFirst.mockResolvedValue(null);
    prisma.vertical_profile.findFirst.mockResolvedValue(null);
    prisma.live_streamer_profile.findFirst.mockResolvedValue(null);
    prisma.channel.findFirst.mockResolvedValue({ user_id: 100 });

    const result = await checkHandleAvailability('collided_handle', 99);
    expect(result.available).toBe(false);
    expect(result.namespace).toBe('channel');
    expect(result.takenBy).toBe(100);
  });

  it('should allow self-reuse of handles across profiles', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.social_profile.findFirst.mockResolvedValue({ user_id: 50 });
    prisma.vertical_profile.findFirst.mockResolvedValue(null);
    prisma.live_streamer_profile.findFirst.mockResolvedValue(null);
    prisma.channel.findFirst.mockResolvedValue(null);

    const result = await checkHandleAvailability('my_own_handle', 50);
    expect(result.available).toBe(true);
  });
});
