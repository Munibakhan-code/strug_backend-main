import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    scheduled_chat_message: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('../../services/chat-service.js', () => ({
  chatRoomName: (id) => `chat_channel_${id}`,
  ensureChannelParticipant: vi.fn(async () => ({})),
  createChatMessage: vi.fn(),
  sendChatError: (res, error, fallbackMessage = 'Chat request failed') => {
    const status = error?.statusCode || 500;
    res.status(status).json({ error: error?.message || fallbackMessage });
  },
}));

vi.mock('../../services/chat-notification-service.js', () => ({
  notifyChatRecipients: vi.fn(async () => {}),
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = { user_id: Number(req.headers['x-user-id'] || 7) };
    next();
  },
}));

const prisma = (await import('../../utils/prisma-client.js')).default;
const { ensureChannelParticipant } = await import('../../services/chat-service.js');
const {
  parseScheduledFor,
  flushDueScheduledChatMessages,
} = await import('../../services/scheduled-chat-service.js');
const router = (await import('../../routes/scheduled-chat-messages-routes.js')).default;

const app = express();
app.use(express.json());
app.use('/scheduled-chat-messages', router);

describe('parseScheduledFor', () => {
  it('accepts a time at least 30 seconds ahead', () => {
    const now = Date.parse('2026-09-12T12:00:00.000Z');
    const at = parseScheduledFor(new Date(now + 60_000).toISOString(), now);
    expect(at.getTime()).toBe(now + 60_000);
  });

  it('rejects missing / invalid dates', () => {
    expect(() => parseScheduledFor('not-a-date')).toThrow(/valid date/i);
  });

  it('rejects times that are too soon', () => {
    const now = Date.parse('2026-09-12T12:00:00.000Z');
    expect(() => parseScheduledFor(new Date(now + 10_000).toISOString(), now)).toThrow(/30 seconds/i);
  });
});

describe('POST /scheduled-chat-messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 without JWT', async () => {
    const res = await request(app).post('/scheduled-chat-messages').send({
      channel_id: 1,
      content: 'hi',
      scheduled_for: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 when scheduled_for is too soon', async () => {
    const res = await request(app)
      .post('/scheduled-chat-messages')
      .set('Authorization', 'Bearer t')
      .send({
        channel_id: 1,
        content: 'hi',
        scheduled_for: new Date(Date.now() + 5_000).toISOString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/30 seconds/i);
  });

  it('creates a pending scheduled message', async () => {
    const when = new Date(Date.now() + 120_000);
    prisma.scheduled_chat_message.findFirst.mockResolvedValue(null);
    prisma.scheduled_chat_message.create.mockResolvedValue({
      scheduled_message_id: 9,
      channel_id: 3,
      sender_id: 7,
      content: 'later',
      content_type: 'text',
      metadata: null,
      client_msg_id: 'c-1',
      scheduled_for: when,
      status: 'pending',
      created_message_id: null,
      error_message: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const res = await request(app)
      .post('/scheduled-chat-messages')
      .set('Authorization', 'Bearer t')
      .send({
        channel_id: 3,
        content: 'later',
        client_msg_id: 'c-1',
        scheduled_for: when.toISOString(),
      });

    expect(res.status).toBe(201);
    expect(res.body.scheduled_message_id).toBe(9);
    expect(res.body.status).toBe('pending');
    expect(ensureChannelParticipant).toHaveBeenCalledWith(3, 7);
  });
});

describe('GET /scheduled-chat-messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 without JWT', async () => {
    const res = await request(app).get('/scheduled-chat-messages');
    expect(res.status).toBe(401);
  });

  it('lists pending rows with a hard take bound', async () => {
    prisma.scheduled_chat_message.findMany.mockResolvedValue([]);
    const res = await request(app)
      .get('/scheduled-chat-messages')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(prisma.scheduled_chat_message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sender_id: 7, status: 'pending' },
        take: expect.any(Number),
        skip: expect.any(Number),
      }),
    );
    const arg = prisma.scheduled_chat_message.findMany.mock.calls[0][0];
    expect(arg.take).toBeGreaterThan(0);
    expect(arg.take).toBeLessThanOrEqual(200);
  });

  it('scopes an empty channel filter without calling findMany on bad channel id', async () => {
    const res = await request(app)
      .get('/scheduled-chat-messages?channel_id=not-a-number')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(400);
    expect(prisma.scheduled_chat_message.findMany).not.toHaveBeenCalled();
  });
});

describe('PATCH / DELETE ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when another user edits', async () => {
    prisma.scheduled_chat_message.findUnique.mockResolvedValue({
      scheduled_message_id: 1,
      sender_id: 99,
      status: 'pending',
      content: 'x',
    });
    const res = await request(app)
      .patch('/scheduled-chat-messages/1')
      .set('Authorization', 'Bearer t')
      .send({ content: 'edited' });
    expect(res.status).toBe(403);
  });

  it('cancels a pending message for the owner', async () => {
    prisma.scheduled_chat_message.findUnique
      .mockResolvedValueOnce({
        scheduled_message_id: 2,
        sender_id: 7,
        status: 'pending',
        content: 'x',
        channel_id: 1,
        content_type: 'text',
        metadata: null,
        client_msg_id: null,
        scheduled_for: new Date(),
        created_message_id: null,
        error_message: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .mockResolvedValueOnce({
        scheduled_message_id: 2,
        sender_id: 7,
        status: 'cancelled',
        content: 'x',
        channel_id: 1,
        content_type: 'text',
        metadata: null,
        client_msg_id: null,
        scheduled_for: new Date(),
        created_message_id: null,
        error_message: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
    prisma.scheduled_chat_message.updateMany.mockResolvedValue({ count: 1 });
    const res = await request(app)
      .delete('/scheduled-chat-messages/2')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(prisma.scheduled_chat_message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scheduled_message_id: 2,
          sender_id: 7,
          status: 'pending',
        }),
        data: { status: 'cancelled' },
      }),
    );
  });

  it('returns 400 when cancel loses the pending race to a flush', async () => {
    prisma.scheduled_chat_message.findUnique.mockResolvedValue({
      scheduled_message_id: 3,
      sender_id: 7,
      status: 'pending',
      content: 'x',
    });
    prisma.scheduled_chat_message.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(app)
      .delete('/scheduled-chat-messages/3')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(400);
  });
});

describe('flushDueScheduledChatMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no stale sending rows to reclaim.
    prisma.scheduled_chat_message.updateMany.mockResolvedValue({ count: 0 });
  });

  it('claims due rows and marks sent after createChatMessage', async () => {
    const { createChatMessage } = await import('../../services/chat-service.js');
    prisma.scheduled_chat_message.findMany.mockResolvedValue([
      {
        scheduled_message_id: 5,
        channel_id: 1,
        sender_id: 7,
        content: 'due now',
        content_type: 'text',
        metadata: null,
        client_msg_id: 'c-due',
      },
    ]);
    prisma.scheduled_chat_message.updateMany
      .mockResolvedValueOnce({ count: 0 }) // reclaim
      .mockResolvedValueOnce({ count: 1 }); // claim
    createChatMessage.mockResolvedValue({
      message_id: 100,
      channel_id: 1,
      content: 'due now',
    });
    prisma.scheduled_chat_message.update.mockResolvedValue({});

    const io = { to: vi.fn(() => ({ emit: vi.fn() })) };
    const result = await flushDueScheduledChatMessages(io, { now: new Date() });
    expect(result.sent).toBe(1);
    expect(createChatMessage).toHaveBeenCalledTimes(1);
    expect(prisma.scheduled_chat_message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'sent', created_message_id: 100 }),
      }),
    );
  });

  it('skips rows already claimed by another replica', async () => {
    const { createChatMessage } = await import('../../services/chat-service.js');
    prisma.scheduled_chat_message.findMany.mockResolvedValue([
      {
        scheduled_message_id: 6,
        channel_id: 1,
        sender_id: 7,
        content: 'race',
        content_type: 'text',
        metadata: null,
        client_msg_id: null,
      },
    ]);
    prisma.scheduled_chat_message.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const result = await flushDueScheduledChatMessages(null);
    expect(result.sent).toBe(0);
    expect(createChatMessage).not.toHaveBeenCalled();
  });

  it('reclaims stale sending rows before selecting due pending', async () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    prisma.scheduled_chat_message.findMany.mockResolvedValue([]);
    prisma.scheduled_chat_message.updateMany.mockResolvedValueOnce({ count: 2 });

    await flushDueScheduledChatMessages(null, { now, staleMs: 60_000 });

    expect(prisma.scheduled_chat_message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'sending',
        }),
        data: expect.objectContaining({ status: 'pending', claimed_at: null }),
      }),
    );
    const reclaimWhere = prisma.scheduled_chat_message.updateMany.mock.calls[0][0].where;
    expect(reclaimWhere.OR).toEqual([
      { claimed_at: { lt: new Date(now.getTime() - 60_000) } },
      { claimed_at: null },
    ]);
  });

  it('does not claim a row whose scheduled_for was moved into the future', async () => {
    const { createChatMessage } = await import('../../services/chat-service.js');
    const now = new Date('2026-09-12T12:00:00.000Z');
    prisma.scheduled_chat_message.findMany.mockResolvedValue([
      {
        scheduled_message_id: 8,
        channel_id: 1,
        sender_id: 7,
        content: 'rescheduled',
        content_type: 'text',
        metadata: null,
        client_msg_id: null,
      },
    ]);
    prisma.scheduled_chat_message.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 }); // claim fails: scheduled_for no longer due

    const result = await flushDueScheduledChatMessages(null, { now });
    expect(result.sent).toBe(0);
    expect(createChatMessage).not.toHaveBeenCalled();
    expect(prisma.scheduled_chat_message.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          scheduled_message_id: 8,
          status: 'pending',
          scheduled_for: { lte: now },
        }),
      }),
    );
  });
});
