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

import router from '../../routes/job-routes.js';
import { resetRiderAnalyticsGuard } from '../../utils/rider-analytics-guard.js';

const app = express();
app.use(express.json());
app.use('/job', router);

describe('POST /job/analytics', () => {
  beforeEach(() => {
    resetRiderAnalyticsGuard();
    vi.clearAllMocks();
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/job/analytics').send({ event: 'job_viewed' });
    expect(res.status).toBe(401);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it('rejects unknown event names', async () => {
    const res = await request(app)
      .post('/job/analytics')
      .set('Authorization', 'Bearer valid')
      .send({ event: 'arbitrary_event' });
    expect(res.status).toBe(400);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it.each(['job_viewed', 'job_applied'])('accepts allow-listed %s', async (event) => {
    const res = await request(app)
      .post('/job/analytics')
      .set('Authorization', 'Bearer valid')
      .send({ event, job_id: 42 });
    expect(res.status).toBe(202);
    expect(activity.recordActivity).toHaveBeenCalledWith(7, `jobs.${event}`, {
      metadata: { job_id: 42 },
    });
  });

  it('strips non-allowlisted metadata', async () => {
    const res = await request(app)
      .post('/job/analytics')
      .set('Authorization', 'Bearer valid')
      .send({
        event: 'job_viewed',
        job_id: 9,
        job_application_id: 3,
        email: 'secret@example.com',
        nested: { x: 1 },
      });
    expect(res.status).toBe(202);
    expect(activity.recordActivity).toHaveBeenCalledWith(7, 'jobs.job_viewed', {
      metadata: { job_id: 9, job_application_id: 3 },
    });
  });

  it('dedupes identical events within the window', async () => {
    const payload = { event: 'job_viewed', job_id: 11 };
    const first = await request(app).post('/job/analytics').set('Authorization', 'Bearer valid').send(payload);
    const retry = await request(app).post('/job/analytics').set('Authorization', 'Bearer valid').send(payload);
    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(activity.recordActivity).toHaveBeenCalledTimes(1);
  });
});
