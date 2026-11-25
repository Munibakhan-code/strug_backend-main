/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    chat_channel: { findUnique: vi.fn() },
    chat_participants: { findMany: vi.fn() },
    chat_messages: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    job_application: { findUnique: vi.fn() },
  },
}));

vi.mock('../../services/email-service.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(true),
}));

import prisma from '../../utils/prisma-client.js';
import { sendEmail } from '../../services/email-service.js';
import { notifyJobApplicationChatMessage } from '../../services/job-chat-email-service.js';

describe('notifyJobApplicationChatMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.JOB_CHAT_EMAIL;
  });

  it('no-ops unless JOB_CHAT_EMAIL=true', async () => {
    const ok = await notifyJobApplicationChatMessage({
      channelId: 1,
      senderId: 2,
      content: 'hi',
      messageId: 3,
    });
    expect(ok).toBe(false);
    expect(prisma.chat_channel.findUnique).not.toHaveBeenCalled();
  });

  it('emails the other participant on a job_application channel', async () => {
    process.env.JOB_CHAT_EMAIL = 'true';
    prisma.chat_channel.findUnique.mockResolvedValue({
      context_type: 'job_application',
      context_id: '9',
    });
    prisma.chat_participants.findMany.mockResolvedValue([{ user_id: 5 }]);
    prisma.chat_messages.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({
      name: 'Employer',
      email: 'e@test',
      social_profiles: { display_name: 'Acme Hiring', handle: 'acme' },
    });
    prisma.job_application.findUnique.mockResolvedValue({
      jobs: { job_name: 'Backend Engineer' },
    });
    prisma.user.findMany.mockResolvedValue([{ email: 'seeker@test.com' }]);

    const ok = await notifyJobApplicationChatMessage({
      channelId: 11,
      senderId: 2,
      content: 'Can we chat?',
      messageId: 33,
    });
    expect(ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0][0].to).toEqual(['seeker@test.com']);
    expect(sendEmail.mock.calls[0][0].subject).toMatch(/Backend Engineer/);
    expect(sendEmail.mock.calls[0][0].html).toMatch(/Acme Hiring/);
  });

  it('stays quiet while the thread is still active', async () => {
    process.env.JOB_CHAT_EMAIL = 'true';
    prisma.chat_channel.findUnique.mockResolvedValue({
      context_type: 'job_application',
      context_id: '9',
    });
    prisma.chat_participants.findMany.mockResolvedValue([{ user_id: 5 }]);
    // Other party replied a minute ago — they are reading the thread right now.
    prisma.chat_messages.findFirst.mockResolvedValue({
      sender_id: 5,
      sent_at: new Date(Date.now() - 60 * 1000),
    });

    const ok = await notifyJobApplicationChatMessage({
      channelId: 11,
      senderId: 2,
      content: 'and one more thing',
      messageId: 34,
    });
    expect(ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('emails again once the thread has gone quiet', async () => {
    process.env.JOB_CHAT_EMAIL = 'true';
    prisma.chat_channel.findUnique.mockResolvedValue({
      context_type: 'job_application',
      context_id: '9',
    });
    prisma.chat_participants.findMany.mockResolvedValue([{ user_id: 5 }]);
    prisma.chat_messages.findFirst.mockResolvedValue({
      sender_id: 5,
      sent_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    prisma.user.findUnique.mockResolvedValue({
      name: 'Employer',
      email: 'e@test',
      social_profiles: null,
    });
    prisma.job_application.findUnique.mockResolvedValue({
      jobs: { job_name: 'Backend Engineer' },
    });
    prisma.user.findMany.mockResolvedValue([{ email: 'seeker@test.com' }]);

    const ok = await notifyJobApplicationChatMessage({
      channelId: 11,
      senderId: 2,
      content: 'following up',
      messageId: 35,
    });
    expect(ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledOnce();
    // No social profile on file — falls back to the account name.
    expect(sendEmail.mock.calls[0][0].html).toMatch(/Employer/);
  });

  it('skips non-job channels', async () => {
    process.env.JOB_CHAT_EMAIL = 'true';
    prisma.chat_channel.findUnique.mockResolvedValue({
      context_type: 'shop',
      context_id: '1',
    });
    const ok = await notifyJobApplicationChatMessage({
      channelId: 1,
      senderId: 2,
      content: 'hi',
      messageId: 3,
    });
    expect(ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
