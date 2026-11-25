import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const { checkRateLimitMock } = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn(),
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    if (!req.headers.authorization) {
      return res.status(401).json('Access denied');
    }
    req.user = { user_id: 42 };
    next();
  },
}));

vi.mock('../../utils/rate-limiter.js', () => ({
  checkRateLimit: (...args) => checkRateLimitMock(...args),
}));

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    user_service_provider: { findMany: vi.fn() },
  },
}));

const router = (await import('../../routes/location-routes.js')).default;

const app = express();
app.use(express.json());
app.use('/location', router);

describe('location proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitMock.mockResolvedValue(false);
  });

  it('requires authentication before proxying autocomplete requests', async () => {
    const res = await request(app).get('/location/autocomplete?q=Toronto');

    expect(res.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('requires authentication before geocoding addresses', async () => {
    const res = await request(app)
      .post('/location/geocode')
      .send({ address: '10 King St' });

    expect(res.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('requires authentication before resolving place details', async () => {
    const res = await request(app).get('/location/place-details?place_id=abc');

    expect(res.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it('rate limits authenticated autocomplete requests before using external providers', async () => {
    checkRateLimitMock.mockResolvedValue(true);

    const res = await request(app)
      .get('/location/autocomplete?q=Toronto')
      .set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(429);
    expect(res.body).toEqual(expect.objectContaining({ successful: false }));
    expect(checkRateLimitMock).toHaveBeenCalledWith('location-proxy:autocomplete:42', 30, 60);
  });

  it('rate limits authenticated geocode requests before using external providers', async () => {
    checkRateLimitMock.mockResolvedValue(true);

    const res = await request(app)
      .post('/location/geocode')
      .set('Authorization', 'Bearer test-token')
      .send({ address: '10 King St' });

    expect(res.status).toBe(429);
    expect(res.body).toEqual(expect.objectContaining({ successful: false }));
    expect(checkRateLimitMock).toHaveBeenCalledWith('location-proxy:geocode:42', 30, 60);
  });

  it('allows authenticated short autocomplete queries without calling external providers', async () => {
    const res = await request(app)
      .get('/location/autocomplete?q=T')
      .set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ successful: true, data: [] });
    expect(checkRateLimitMock).toHaveBeenCalledWith('location-proxy:autocomplete:42', 30, 60);
  });
});
