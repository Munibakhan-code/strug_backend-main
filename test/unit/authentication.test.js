import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authenticateToken, requireAdmin } from '../../middleware/authentication.js';
import prisma from '../../utils/prisma-client.js';
import jwt from 'jsonwebtoken';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    user: {
      findUnique: vi.fn()
    },
    social_profile: {
      findFirst: vi.fn()
    }
  }
}));

vi.mock('jsonwebtoken', () => {
  const mockVerify = vi.fn((token, secret, callback) => {
    callback(null, { user_id: 1, iat: Math.floor(Date.now() / 1000) });
  });
  return {
    default: {
      verify: mockVerify
    },
    verify: mockVerify
  };
});

describe('Authentication Middleware Tests', () => {
  let req, res, next;

  beforeEach(() => {
    vi.clearAllMocks();
    req = { headers: {} };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };
    next = vi.fn();
    process.env.ACCESS_TOKEN_KEY = 'test_secret';
  });

  it('should return 401 if authorization header is missing', async () => {
    authenticateToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith('Access denied');
  });

  it('should return 403 if account is suspended', async () => {
    req.headers['authorization'] = 'Bearer valid_token';

    prisma.user.findUnique.mockResolvedValue({
      user_id: 1,
      role: 'USER',
      account_status: 'suspended',
      password_changed_at: null,
      sessions_invalidated_at: null
    });

    authenticateToken(req, res, next);
    await new Promise(r => setTimeout(r, 10));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Account suspended',
      account_status: 'suspended'
    });
  });

  it('should return 403 if account is deleted', async () => {
    req.headers['authorization'] = 'Bearer valid_token';

    prisma.user.findUnique.mockResolvedValue({
      user_id: 1,
      role: 'USER',
      account_status: 'deleted',
      password_changed_at: null,
      sessions_invalidated_at: null
    });

    authenticateToken(req, res, next);
    await new Promise(r => setTimeout(r, 10));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Account deleted',
      account_status: 'deleted'
    });
  });

  it('should fail closed with 503 if account lookup throws', async () => {
    req.headers['authorization'] = 'Bearer valid_token';
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));

    authenticateToken(req, res, next);
    await new Promise(r => setTimeout(r, 10));
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('should deny access if token was issued before password change', async () => {
    req.headers['authorization'] = 'Bearer old_token';
    const oldIat = Math.floor((Date.now() - 10000) / 1000);

    jwt.verify.mockImplementation((token, secret, callback) => {
      callback(null, { user_id: 1, iat: oldIat });
    });

    prisma.user.findUnique.mockResolvedValue({
      user_id: 1,
      role: 'USER',
      account_status: 'active',
      password_changed_at: new Date(Date.now() - 1000),
      sessions_invalidated_at: null
    });

    authenticateToken(req, res, next);
    await new Promise(r => setTimeout(r, 10));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith('Invalid token');
  });

  it('should proceed to next if everything is valid', async () => {
    req.headers['authorization'] = 'Bearer valid_token';
    const currentIat = Math.floor(Date.now() / 1000);

    jwt.verify.mockImplementation((token, secret, callback) => {
      callback(null, { user_id: 1, iat: currentIat });
    });

    prisma.user.findUnique.mockResolvedValue({
      user_id: 1,
      role: 'USER',
      account_status: 'active',
      password_changed_at: null,
      sessions_invalidated_at: null
    });

    prisma.social_profile.findFirst.mockResolvedValue({ profile_id: 200 });

    authenticateToken(req, res, next);
    await new Promise(r => setTimeout(r, 10));
    expect(next).toHaveBeenCalled();
  });
});