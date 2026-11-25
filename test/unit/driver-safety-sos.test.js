// SOS press: what the driver is TOLD must match what actually happened.
//
// The regression this guards: SAFETY_ALERT_USER_ID is unset in an environment, so no human is
// notified, and the driver still read "We've been alerted. Stay safe." Also pins the urgency of
// both notifications to 'ambient' — 'actionable' is the client's *claimable offer* channel, and
// an SOS routed there rendered as an Accept/Decline ride card.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import prisma from '../../utils/prisma-client.js';
import { notify } from '../../services/notify.js';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    active_trip: { findUnique: vi.fn(), update: vi.fn() },
    driver_profile: { findUnique: vi.fn() },
    driver_emergency_contact: { findUnique: vi.fn(), upsert: vi.fn() },
    trip_sos_incident: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../../services/notify.js', () => ({ notify: vi.fn(() => Promise.resolve(null)) }));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, _res, next) => { req.user = { user_id: 6 }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));

vi.mock('../../utils/ride-auth.js', () => ({
  requireAuthUserId: (req) => req.user.user_id,
  resolveDriverProfileForUser: vi.fn(),
  assertTripAssignedToUser: vi.fn(() => null), // authorized
}));

const TRIP = { trip_id: 1, driver_id: 1, ended_at: null };
const INCIDENT = { incident_id: 42, trip_id: 1, triggered_by: 6 };

async function buildApp() {
  vi.resetModules();
  const { default: router } = await import('../../routes/driver-safety-routes.js');
  const app = express();
  app.use(express.json());
  app.use('/driver-safety', router);
  return app;
}

function notificationOfType(type) {
  const call = notify.mock.calls.find(([, n]) => n?.type === type);
  return call ? call[1] : null;
}

describe('POST /driver-safety/:trip_id/sos', () => {
  const originalEnv = process.env.SAFETY_ALERT_USER_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.active_trip.findUnique.mockResolvedValue(TRIP);
    prisma.driver_profile.findUnique.mockResolvedValue({
      current_lat: 43.6, current_long: -79.3, user: { name: 'Test Driver' },
    });
    prisma.driver_emergency_contact.findUnique.mockResolvedValue({ name: 'Kin', phone: '+1555' });
    prisma.trip_sos_incident.create.mockResolvedValue(INCIDENT);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SAFETY_ALERT_USER_ID;
    else process.env.SAFETY_ALERT_USER_ID = originalEnv;
  });

  it('alerts support and tells the driver so when SAFETY_ALERT_USER_ID is set', async () => {
    process.env.SAFETY_ALERT_USER_ID = '99';
    const res = await request(await buildApp()).post('/driver-safety/1/sos').send({});

    expect(res.status).toBe(200);
    expect(res.body.support_alerted).toBe(true);

    const support = notificationOfType('sos.triggered');
    expect(support).toBeTruthy();
    expect(support.userId).toBe(99);
    expect(support.entityId).toBe(INCIDENT.incident_id);

    expect(notificationOfType('sos.acknowledged').body).toMatch(/We've been alerted/);
  });

  it('does NOT claim the driver was alerted when SAFETY_ALERT_USER_ID is unset', async () => {
    delete process.env.SAFETY_ALERT_USER_ID;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(await buildApp()).post('/driver-safety/1/sos').send({});

    expect(res.status).toBe(200);
    expect(res.body.support_alerted).toBe(false);
    // The incident is still recorded — the alerting gap must never swallow the SOS itself.
    expect(prisma.trip_sos_incident.create).toHaveBeenCalledTimes(1);

    expect(notificationOfType('sos.triggered')).toBeNull();

    const ack = notificationOfType('sos.acknowledged');
    expect(ack.body).not.toMatch(/We've been alerted/);
    expect(ack.body).toMatch(/call emergency services directly/i);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('reached NO ONE'));
    errSpy.mockRestore();
  });

  it('never sends SOS notifications on the actionable (claimable-offer) channel', async () => {
    process.env.SAFETY_ALERT_USER_ID = '99';
    await request(await buildApp()).post('/driver-safety/1/sos').send({});

    for (const [, n] of notify.mock.calls) {
      expect(n.urgency).toBe('ambient');
    }
  });
});
