import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import router from '../../routes/video-routes.js';
import prisma from '../../utils/prisma-client.js';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    channel: {
      findUnique: vi.fn()
    },
    video: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    video_comments: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn()
    },
    video_comment_likes: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn()
    },
    social_profile: {
      findMany: vi.fn()
    },
    social_block: {
      findFirst: vi.fn()
    },
    $transaction: vi.fn(async (cb) => cb(prisma))
  }
}));

vi.mock('../../middleware/profanity-filter.js', () => ({
  profanityFilter: (req, res, next) => {
    const text = req.body.content || '';
    if (text.includes('abuseword1')) {
      return res.status(400).json({ successful: false, message: 'Content violates community standards.' });
    }
    next();
  }
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { user_id: 1, name: 'Test User', role: 'USER' };
    next();
  },
  optionalAuth: (req, res, next) => {
    req.user = { user_id: 1, name: 'Test User', role: 'USER' };
    next();
  }
}));

const app = express();
app.use(express.json());
app.use('/video', router);

describe('Nested Comments & Thread Depth API Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.social_profile.findMany.mockResolvedValue([
      { user_id: 1, profile_id: 10 },
      { user_id: 2, profile_id: 20 }
    ]);
    prisma.social_block.findFirst.mockResolvedValue(null);
  });

  it('should reject comment creation if body text contains profanity phrases', async () => {
    const res = await request(app)
      .post('/video/101/comments')
      .send({ content: 'This is a bad comment with abuseword1' });

    expect(res.status).toBe(400);
    expect(res.body.successful).toBe(false);
    expect(res.body.message).toContain('Content violates community standards.');
  });

  it('should reject comment replies if thread depth limit of 3 is exceeded', async () => {
    prisma.video.findUnique.mockResolvedValue({ video_id: 101, status: 'safe', channel: { user_id: 2 } });
    prisma.video_comments.findUnique
      .mockResolvedValueOnce({ video_id: 101, user_id: 2, parent_id: 201 })
      .mockResolvedValueOnce({ parent_id: 202 })
      .mockResolvedValueOnce({ parent_id: 203 })
      .mockResolvedValueOnce({ parent_id: null });

    const res = await request(app)
      .post('/video/101/comments')
      .send({ content: 'Too deep reply', parent_id: 200 });

    expect(res.status).toBe(400);
    expect(res.body.successful).toBe(false);
    expect(res.body.message).toBe('Comment thread depth limit exceeded');
  });

  it('should successfully structure flat database rows into recursive tree up to level 3', async () => {
    prisma.video_comments.findMany.mockResolvedValue([
      { comment_id: 301, parent_id: null, content: 'Root comment', _count: { comment_likes: 0 }, user: { name: 'Owner' } },
      { comment_id: 302, parent_id: 301, content: 'Level 2 reply', _count: { comment_likes: 0 }, user: { name: 'Replier' } }
    ]);

    const res = await request(app).get('/video/101/comments');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].content).toBe('Root comment');
    expect(res.body.data[0].replies[0].content).toBe('Level 2 reply');
  });
});
