import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { truncateAll, createUser, closeDb, db } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

describe('GET /social-profile/me', () => {
  it('returns data:null (not 404) when the user has no profile yet', async () => {
    const u = await createUser();
    const res = await request(app).get('/social-profile/me').set(authHeader(u)).expect(200);
    expect(res.body).toEqual({ successful: true, data: null });
  });

  it('does NOT auto-provision a placeholder profile on read', async () => {
    const u = await createUser();
    await request(app).get('/social-profile/me').set(authHeader(u)).expect(200);
    // The regression: GET /me used to create a `user{id}` row, which then blocked setup.
    const count = await db.social_profile.count({ where: { user_id: u.user_id } });
    expect(count).toBe(0);
  });
});

describe('PATCH /social-profile/me', () => {
  it('accepts an empty display_name and empty work_status (settings save)', async () => {
    const u = await createUser();
    await db.social_profile.create({
      data: { user_id: u.user_id, handle: 'save_profile', display_name: 'Existing' },
    });
    const res = await request(app).patch('/social-profile/me').set(authHeader(u))
      .send({ bio: 'hello', display_name: '', work_status: '' }).expect(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data).toMatchObject({ display_name: 'Existing', bio: 'hello', work_status: null });
  });

  it('returns Zod issues (not a bare successful:false) for an overlong bio', async () => {
    const u = await createUser();
    const res = await request(app).patch('/social-profile/me').set(authHeader(u))
      .send({ bio: 'x'.repeat(501), display_name: 'Zain' }).expect(400);
    expect(res.body.successful).toBe(false);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(res.body.errors[0].path).toContain('bio');
  });
});

describe('POST /social-profile/setup', () => {
  it('creates a profile and syncs user.username for a brand-new user', async () => {
    const u = await createUser();
    const res = await request(app).post('/social-profile/setup').set(authHeader(u))
      .send({ handle: 'fresh_handle', display_name: 'Fresh User' }).expect(201);
    expect(res.body.data).toMatchObject({ handle: 'fresh_handle', display_name: 'Fresh User' });

    const user = await db.user.findUnique({ where: { user_id: u.user_id } });
    expect(user.username).toBe('fresh_handle');
  });

  it('upgrades an auto-provisioned placeholder (handle===user{id}) instead of rejecting', async () => {
    const u = await createUser();
    // Simulate the placeholder a previous GET /me fallback would have created.
    await db.social_profile.create({
      data: { user_id: u.user_id, handle: `user${u.user_id}`, display_name: 'User' },
    });

    const res = await request(app).post('/social-profile/setup').set(authHeader(u))
      .send({ handle: 'chosen_handle', display_name: 'Chosen Name', bio: 'hi' }).expect(201);
    expect(res.body.data).toMatchObject({ handle: 'chosen_handle', display_name: 'Chosen Name' });

    // The placeholder row is upgraded in place — still exactly one profile, new handle synced.
    const profiles = await db.social_profile.findMany({ where: { user_id: u.user_id } });
    expect(profiles).toHaveLength(1);
    expect(profiles[0].handle).toBe('chosen_handle');
    const user = await db.user.findUnique({ where: { user_id: u.user_id } });
    expect(user.username).toBe('chosen_handle');
  });

  it('stores dotted handles as foo.bar not foobar', async () => {
    const u = await createUser();
    const res = await request(app).post('/social-profile/setup').set(authHeader(u))
      .send({ handle: 'foo.bar', display_name: 'Dotted' }).expect(201);
    expect(res.body.data.handle).toBe('foo.bar');
  });

  it('still rejects a genuinely customised existing profile', async () => {
    const u = await createUser();
    await db.social_profile.create({
      data: { user_id: u.user_id, handle: 'already_set', display_name: 'Already' },
    });
    const res = await request(app).post('/social-profile/setup').set(authHeader(u))
      .send({ handle: 'new_attempt', display_name: 'Nope' }).expect(400);
    expect(res.body.message).toMatch(/already have a social profile/i);
  });

  it('rejects a handle taken by a different user', async () => {
    const taken = await createUser();
    await db.social_profile.create({
      data: { user_id: taken.user_id, handle: 'popular', display_name: 'Taken' },
    });
    const u = await createUser();
    const res = await request(app).post('/social-profile/setup').set(authHeader(u))
      .send({ handle: 'popular', display_name: 'Wants It' }).expect(400);
    expect(res.body.message).toMatch(/already taken/i);
  });
});
