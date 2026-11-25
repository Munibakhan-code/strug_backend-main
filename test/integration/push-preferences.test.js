// GET/PUT /push/preferences.
//
// These exist because of a real regression: the category allowlist was hoisted out of this router
// into web-push-service.PUSH_CATEGORIES, but the GET handler kept referencing the deleted local
// KNOWN_CATEGORIES const. Nothing imported it, nothing linted it, and no test touched this route —
// so `GET /push/preferences` threw a ReferenceError and 500'd in staging with the unit suite green.
//
// The load-bearing assertion is that rides/work/quotes/live/video/townhall/payments round-trip.
// Those keys used to be silently stripped by sanitizeCategories(), which is what made the
// highest-volume verticals permanently unmutable.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { PUSH_CATEGORIES } from '../../services/web-push-service.js';
import { truncateAll, createUser, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

let user;

beforeAll(async () => {
  await truncateAll();
  user = await createUser({ email: 'push-prefs@test.local' });
});

afterAll(async () => {
  await closeDb();
});

describe('GET /push/preferences', () => {
  it('returns every known category (defaulting to allowed) for a user with no subscription', async () => {
    const res = await request(app).get('/push/preferences').set(authHeader(user));

    expect(res.status).toBe(200);
    // The regression: this route 500'd. Assert the shape, not just the status.
    expect(Object.keys(res.body.categories).sort()).toEqual([...PUSH_CATEGORIES].sort());
    // Sparse opt-out: absent key means allowed, so a fresh user is opted into everything.
    for (const key of PUSH_CATEGORIES) expect(res.body.categories[key]).toBe(true);
    expect(res.body.subscribed).toBe(false);
  });

  it('exposes the categories that were previously unmutable', async () => {
    const res = await request(app).get('/push/preferences').set(authHeader(user));
    for (const key of ['rides', 'work', 'quotes', 'live']) {
      expect(res.body.categories).toHaveProperty(key);
    }
  });
});

describe('PUT /push/preferences', () => {
  it('accepts the categories notify() actually emits instead of stripping them', async () => {
    const res = await request(app)
      .put('/push/preferences')
      .set(authHeader(user))
      .send({ categories: { rides: false, work: false, quotes: false, live: false, video: false } });

    expect(res.status).toBe(200);
    // sanitizeCategories() used to drop every one of these — the mute silently did nothing.
    expect(res.body.categories).toMatchObject({
      rides: false, work: false, quotes: false, live: false, video: false,
    });
  });

  it('still rejects an unknown category', async () => {
    const res = await request(app)
      .put('/push/preferences')
      .set(authHeader(user))
      .send({ categories: { not_a_real_category: false } });

    expect(res.status).toBe(400);
  });
});
