import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

process.env.ACCESS_TOKEN_KEY ||= 'test-access-token-key';

const { runChatGraph } = vi.hoisted(() => ({
  runChatGraph: vi.fn(async (_m, _v, _h, userId, profileId) =>
    JSON.stringify({ userId, profileId })
  ),
}));

vi.mock('../../ai/graph.js', () => ({ runChatGraph }));
vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    social_profile: { findFirst: vi.fn(async () => ({ profile_id: 77 })) },
  },
}));
vi.mock('../../middleware/rate-limit.js', () => ({
  rateLimit: () => (_req, _res, next) => next(),
}));

const { default: router } = await import('../../routes/ai-chat-routes.js');
const express = (await import('express')).default;
const app = express();
app.use(express.json());
app.use('/ai-chat', router);

beforeEach(() => {
  runChatGraph.mockClear();
});

describe('POST /ai-chat auth', () => {
  it('does not impersonate user 1 when no token is sent', async () => {
    const res = await request(app).post('/ai-chat').send({
      message: 'hello',
      verticalSlug: 'home',
    });
    expect(res.status).toBe(200);
    expect(runChatGraph).toHaveBeenCalled();
    const userId = runChatGraph.mock.calls[0][3];
    expect(userId).toBeNull();
  });

  it('passes the JWT user_id when a valid token is sent', async () => {
    const token = jwt.sign({ user_id: 42 }, process.env.ACCESS_TOKEN_KEY, { expiresIn: '1h' });
    const res = await request(app)
      .post('/ai-chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hello', verticalSlug: 'home' });
    expect(res.status).toBe(200);
    expect(runChatGraph.mock.calls[0][3]).toBe(42);
    expect(runChatGraph.mock.calls[0][4]).toBe(77);
  });
});
