import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sanitizeInput } from '../../middleware/sanitizer.js';
import { checkAuthRateLimit, checkRateLimit, clearRateLimit } from '../../utils/rate-limiter.js';
import redis, { isRedisReady } from '../../utils/redis-client.js';

vi.mock('../../utils/redis-client.js', () => ({
  default: {
    set: vi.fn(),
    incr: vi.fn(),
    del: vi.fn(),
    get: vi.fn(),
  },
  isRedisReady: vi.fn(() => true),
}));

describe('Sanitizer Middleware Tests', () => {
  it('should recursively sanitize deep nested objects', () => {
    const req = {
      body: {
        username: '<script>alert("xss")</script>hacker',
        meta: {
          bio: 'normal bio',
          nested: {
            payload: '<img src="x" onerror="alert(1)">'
          }
        }
      }
    };
    const res = {};
    const next = vi.fn();

    sanitizeInput(req, res, next);

    expect(req.body.username).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;hacker');
    expect(req.body.meta.nested.payload).toBe('<img src>');
    expect(next).toHaveBeenCalled();
  });
});

describe('Rate Limiter Utility Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isRedisReady.mockReturnValue(true);
    delete process.env.AUTH_RATE_LIMIT_REQUIRE_REDIS;
  });

  it('should use redis set and incr when connected', async () => {
    redis.set.mockResolvedValue('OK');
    redis.incr.mockResolvedValue(3);

    const limited = await checkRateLimit('test_key', 2, 60);

    expect(redis.set).toHaveBeenCalledWith('test_key', 0, 'EX', 60, 'NX');
    expect(redis.incr).toHaveBeenCalledWith('test_key');
    expect(limited).toBe(true);
  });

  it('should fallback to in-memory limiter on redis connection failure', async () => {
    isRedisReady.mockReturnValue(false);
    redis.set.mockRejectedValue(new Error('Redis connection lost'));

    const firstAttempt = await checkRateLimit('fail_key_mem', 1, 60);
    const secondAttempt = await checkRateLimit('fail_key_mem', 1, 60);

    expect(firstAttempt).toBe(false);
    expect(secondAttempt).toBe(true);
  });

  it('auth fail-closed when Redis required and unavailable', async () => {
    process.env.AUTH_RATE_LIMIT_REQUIRE_REDIS = '1';
    isRedisReady.mockReturnValue(false);
    const limited = await checkAuthRateLimit('auth_fail_closed', 5, 60);
    expect(limited).toBe(true);
  });

  it('failClosed when Redis is ready but commands throw', async () => {
    process.env.AUTH_RATE_LIMIT_REQUIRE_REDIS = '1';
    isRedisReady.mockReturnValue(true);
    redis.set.mockRejectedValue(new Error('READONLY'));
    const limited = await checkAuthRateLimit('auth_redis_throw', 5, 60);
    expect(limited).toBe(true);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('does not fail-closed merely because NODE_ENV is production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.AUTH_RATE_LIMIT_REQUIRE_REDIS;
    isRedisReady.mockReturnValue(false);
    try {
      const limited = await checkAuthRateLimit('auth_prod_mem', 5, 60);
      expect(limited).toBe(false);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});