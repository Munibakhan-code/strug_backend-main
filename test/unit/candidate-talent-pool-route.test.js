/**
 * Talent-pool GET select must not request user.profile_pic_url (that column is on social_profile).
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findMany, agentsFindFirst, authMode } = vi.hoisted(() => ({
  findMany: vi.fn(),
  agentsFindFirst: vi.fn(),
  authMode: { value: 'ok' },
}));

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    candidate: { findMany },
    agents: { findFirst: agentsFindFirst },
  },
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    if (authMode.value === 'deny') return res.status(401).json('Access denied');
    req.user = { user_id: 10, role: 'USER' };
    return next();
  },
}));

import express from 'express';
import request from 'supertest';
import candidateRouter from '../../routes/candidate-routes.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/candidate', candidateRouter);
  return a;
}

describe('GET /candidate/talent-pool select shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMode.value = 'ok';
    agentsFindFirst.mockResolvedValue({ agent_id: 1, agent_user_id: 10 });
    findMany.mockResolvedValue([]);
  });

  it('uses social_profiles.profile_pic_url, not user.profile_pic_url', async () => {
    const res = await request(app()).get('/candidate/talent-pool?limit=5');
    expect(res.status).toBe(200);
    expect(findMany).toHaveBeenCalled();
    const include = findMany.mock.calls[0][0].include;
    expect(include.user.select.profile_pic_url).toBeUndefined();
    expect(include.user.select.social_profiles).toEqual({
      select: { profile_pic_url: true },
    });
  });

  it('returns 403 without employer agent (edge)', async () => {
    agentsFindFirst.mockResolvedValue(null);
    const res = await request(app()).get('/candidate/talent-pool');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/employer company profile/i);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated (edge)', async () => {
    authMode.value = 'deny';
    const res = await request(app()).get('/candidate/talent-pool');
    expect(res.status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });
});
