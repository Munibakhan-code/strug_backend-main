import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { truncateAll, createUser, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

describe('GET /user/addresses', () => {
  it('401 without a token', async () => {
    await request(app).get('/user/addresses').expect(401);
  });

  it('200 + empty list for a fresh authenticated user', async () => {
    const u = await createUser();
    const res = await request(app).get('/user/addresses').set(authHeader(u)).expect(200);
    expect(res.body).toEqual({ successful: true, data: [] });
  });
});

describe('POST /user/addresses', () => {
  it('400 when label or street is missing', async () => {
    const u = await createUser();
    await request(app).post('/user/addresses').set(authHeader(u)).send({ label: 'Home' }).expect(400);
    await request(app).post('/user/addresses').set(authHeader(u)).send({ street: '1 Main St' }).expect(400);
  });

  it('creates the first address as default (201) and lists it', async () => {
    const u = await createUser();
    const created = await request(app).post('/user/addresses').set(authHeader(u))
      .send({ label: 'Home', street: '1 Main St', city: 'Toronto', country: 'Canada' })
      .expect(201);
    expect(created.body.data).toMatchObject({
      label: 'Home', street: '1 Main St', city: 'Toronto', country: 'Canada', is_default: true,
    });

    const list = await request(app).get('/user/addresses').set(authHeader(u)).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].label).toBe('Home');
  });

  it('isolates addresses per user (no cross-account leak)', async () => {
    const a = await createUser();
    const b = await createUser();
    await request(app).post('/user/addresses').set(authHeader(a))
      .send({ label: 'A home', street: 'A St' }).expect(201);

    const res = await request(app).get('/user/addresses').set(authHeader(b)).expect(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('DELETE /user/addresses/:address_id', () => {
  it('removes the caller\'s address', async () => {
    const u = await createUser();
    const created = await request(app).post('/user/addresses').set(authHeader(u))
      .send({ label: 'Home', street: '1 Main St' }).expect(201);
    const id = created.body.data.address_id;

    await request(app).delete(`/user/addresses/${id}`).set(authHeader(u)).expect(200);

    const list = await request(app).get('/user/addresses').set(authHeader(u)).expect(200);
    expect(list.body.data).toEqual([]);
  });

  it('404 when deleting an address that is not the caller\'s', async () => {
    const a = await createUser();
    const b = await createUser();
    const created = await request(app).post('/user/addresses').set(authHeader(a))
      .send({ label: 'A', street: 'A St' }).expect(201);

    await request(app).delete(`/user/addresses/${created.body.data.address_id}`)
      .set(authHeader(b)).expect(404);
  });
});
