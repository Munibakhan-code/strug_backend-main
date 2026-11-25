import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));

vi.mock('../../services/activity-log.js', () => activity);
vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    const users = { 'Bearer valid': 7, 'Bearer other': 8 };
    if (!users[req.headers.authorization]) return res.status(401).json({ successful: false });
    req.user = { user_id: users[req.headers.authorization] };
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));

import router from '../../routes/ride-request-routes.js';
import prisma from '../../utils/prisma-client.js';
import { resetRiderAnalyticsGuard } from '../../utils/rider-analytics-guard.js';

const app = express();
app.use(express.json());
app.use('/ride-request', router);

describe('POST /ride-request/analytics', () => {
  beforeEach(() => {
    resetRiderAnalyticsGuard();
    vi.clearAllMocks();
    vi.spyOn(prisma.ride_request, 'findFirst').mockResolvedValue({ ride_request_id: 42 });
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/ride-request/analytics').send({ event: 'vehicle_selected' });
    expect(res.status).toBe(401);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it('rejects unknown event names', async () => {
    const res = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send({ event: 'arbitrary_event' });
    expect(res.status).toBe(400);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it.each([
    'page_viewed', 'route_started', 'route_resolved', 'pickup_confidence_shown',
    'pickup_adjusted', 'vehicle_selected', 'confirmation_started', 'confirmation_completed',
    'matching_started', 'matching_expanded', 'matching_delayed', 'matched', 'no_driver',
    'cancelled', 'driver_arrived', 'pickup_verified', 'ride_started', 'ride_completed',
    'rating_submitted', 'book_again',
  ])('accepts the allow-listed %s event', async (event) => {
    const res = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send({ event });
    expect(res.status).toBe(202);
    expect(activity.recordActivity).toHaveBeenCalledWith(7, `rideshare.${event}`, { metadata: {} });
  });

  it('records only allow-listed flat metadata without raw or nested private data', async () => {
    const res = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send({
      event: 'vehicle_selected', vehicle_type: 'economy', ride_request_id: 42,
      pickup: 'private address', coordinates: { lat: 1, lng: 2 }, card_number: '4111',
      unexpected: 'drop me', route_resolved: true, elapsed_ms: 1234,
      confidence: 'high', matching_phase: 'expanding', payment_method: 'wallet', price_mode: 'standard',
    });
    expect(res.status).toBe(202);
    expect(activity.recordActivity).toHaveBeenCalledWith(7, 'rideshare.vehicle_selected', {
      metadata: {
        vehicle_type: 'economy', ride_request_id: 42, route_resolved: true, elapsed_ms: 1234,
        confidence: 'high', matching_phase: 'expanding', payment_method: 'wallet', price_mode: 'standard',
      },
    });
  });

  it('keeps an owned ride ID and checks ownership without exposing ride details', async () => {
    const res = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send({
      event: 'matched', ride_request_id: 42,
    });
    expect(res.status).toBe(202);
    expect(prisma.ride_request.findFirst).toHaveBeenCalledWith({
      where: { ride_request_id: 42, passenger_id: 7 }, select: { ride_request_id: true },
    });
    expect(activity.recordActivity).toHaveBeenCalledWith(7, 'rideshare.matched', { metadata: { ride_request_id: 42 } });
  });

  it.each(['foreign', 'missing'])('silently drops a %s ride ID', async () => {
    prisma.ride_request.findFirst.mockResolvedValueOnce(null);
    const res = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send({
      event: 'matched', ride_request_id: 99,
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ successful: true });
    expect(activity.recordActivity).toHaveBeenCalledWith(7, 'rideshare.matched', { metadata: {} });
  });

  it('does not query ride ownership when no ride ID is supplied', async () => {
    const res = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send({ event: 'page_viewed' });
    expect(res.status).toBe(202);
    expect(prisma.ride_request.findFirst).not.toHaveBeenCalled();
  });

  it('drops sensitive strings smuggled through categorical fields', async () => {
    const res = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send({
      event: 'confirmation_completed',
      vehicle_type: '123 Main Street', payment_method: '4111111111111111',
      confidence: 'home address', matching_phase: 'secret', price_mode: 'card 4242',
    });
    expect(res.status).toBe(202);
    expect(activity.recordActivity).toHaveBeenCalledWith(7, 'rideshare.confirmation_completed', { metadata: {} });
  });

  it('drops invalid booleans and unsafe or out-of-range numeric metadata', async () => {
    const res = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send({
      event: 'matching_delayed', route_resolved: 'true', ride_request_id: Number.MAX_SAFE_INTEGER + 1,
      elapsed_ms: 86_400_001, vehicle_type: true, payment_method: 4242424242424242,
    });
    expect(res.status).toBe(202);
    expect(activity.recordActivity).toHaveBeenCalledWith(7, 'rideshare.matching_delayed', { metadata: {} });
  });

  it('keeps analytics best-effort when the activity service throws', async () => {
    activity.recordActivity.mockImplementationOnce(() => { throw new Error('logging offline'); });
    const res = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send({ event: 'page_viewed' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ successful: true });
  });

  it('accepts normal analytics volume but throttles sustained spam per user', async () => {
    for (let index = 0; index < 60; index += 1) {
      const res = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send({
        event: 'vehicle_selected', elapsed_ms: index,
      });
      expect(res.status).toBe(202);
    }
    const throttled = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send({
      event: 'vehicle_selected', elapsed_ms: 61,
    });
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(throttled.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('isolates analytics throttling by authenticated user', async () => {
    for (let index = 0; index < 61; index += 1) {
      await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send({
        event: 'vehicle_selected', elapsed_ms: index,
      });
    }
    const otherUser = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer other').send({ event: 'page_viewed' });
    expect(otherUser.status).toBe(202);
  });

  it('records an identical analytics delivery only once', async () => {
    const payload = { event: 'matching_started', ride_request_id: 42, matching_phase: 'contacting' };
    const first = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send(payload);
    const retry = await request(app).post('/ride-request/analytics').set('Authorization', 'Bearer valid').send(payload);
    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(activity.recordActivity).toHaveBeenCalledTimes(1);
  });
});
