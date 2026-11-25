import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, truncateAll, createUser, seedOnlineDriver, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

const makeRide = (passenger_id, over = {}) => db.ride_request.create({
  data: { passenger_id, status: 'pending_payment', offered_fare: 17.17, ...over },
});

describe('POST /ride-request/:id/confirm-payment — money safety', () => {
  it('403 when the ride is not the caller\'s', async () => {
    const a = await createUser();
    const b = await createUser();
    const ride = await makeRide(a.user_id);
    await request(app).post(`/ride-request/${ride.ride_request_id}/confirm-payment`)
      .set(authHeader(b)).send({ payment_method: 'wallet' }).expect(403);
  });

  it('is idempotent: a ride already past the hold returns "Payment already confirmed" without charging', async () => {
    const u = await createUser();
    // Give the user a funded wallet to prove it is NOT touched on the idempotent path.
    await db.strug_wallet.create({ data: { user_id: u.user_id, balance: 50, currency: 'CAD', status: 'active' } });
    const ride = await makeRide(u.user_id, { status: 'pending' }); // already advanced

    const res = await request(app).post(`/ride-request/${ride.ride_request_id}/confirm-payment`)
      .set(authHeader(u)).send({ payment_method: 'wallet' }).expect(200);
    expect(res.body).toMatchObject({ successful: true, message: 'Payment already confirmed' });

    const wallet = await db.strug_wallet.findUnique({ where: { user_id: u.user_id } });
    expect(Number(wallet.balance)).toBe(50); // untouched
    const debits = await db.wallet_transaction.count({ where: { user_id: u.user_id, type: 'debit' } });
    expect(debits).toBe(0);
  });

  it('402 on insufficient wallet balance — the atomic debit guard rejects the overdraw', async () => {
    const u = await createUser();
    await db.strug_wallet.create({ data: { user_id: u.user_id, balance: 5, currency: 'CAD', status: 'active' } });
    const ride = await makeRide(u.user_id); // pending_payment, fare 17.17
    // A driver must be online, else the route short-circuits with 503 (no_driver_available)
    // before it ever reaches the wallet-balance guard this test asserts.
    await seedOnlineDriver();

    const res = await request(app).post(`/ride-request/${ride.ride_request_id}/confirm-payment`)
      .set(authHeader(u)).send({ payment_method: 'wallet' }).expect(402);
    expect(res.body.message).toMatch(/Insufficient wallet balance/);

    const wallet = await db.strug_wallet.findUnique({ where: { user_id: u.user_id } });
    expect(Number(wallet.balance)).toBe(5); // not debited
    const debits = await db.wallet_transaction.count({ where: { user_id: u.user_id, type: 'debit' } });
    expect(debits).toBe(0);
  });
});
