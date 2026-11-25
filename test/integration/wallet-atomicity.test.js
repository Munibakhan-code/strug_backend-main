import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, truncateAll, createUser, closeDb } from '../helpers/db.js';

// Guards the money-safety invariant the rideshare confirm-payment route depends on: the
// `balance >= amount` test lives in the UPDATE's WHERE clause, so concurrent debits can
// never both pass a stale read and overdraw the wallet (there is no DB-level balance>=0
// constraint to fall back on). See routes/ride-request-routes.js confirm-payment.
beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

const guardedDebit = (userId, amount) => db.strug_wallet.updateMany({
  where: { user_id: userId, currency: 'CAD', balance: { gte: amount } },
  data: { balance: { decrement: amount } },
});

describe('strug_wallet conditional debit', () => {
  it('two concurrent debits never overdraw — exactly one applies', async () => {
    const u = await createUser();
    await db.strug_wallet.create({ data: { user_id: u.user_id, balance: 10, currency: 'CAD', status: 'active' } });

    const [r1, r2] = await Promise.all([guardedDebit(u.user_id, 8), guardedDebit(u.user_id, 8)]);

    expect(r1.count + r2.count).toBe(1); // only one debit succeeded
    const wallet = await db.strug_wallet.findUnique({ where: { user_id: u.user_id } });
    expect(Number(wallet.balance)).toBe(2); // never went negative
  });

  it('rejects a debit when the balance is below the amount', async () => {
    const u = await createUser();
    await db.strug_wallet.create({ data: { user_id: u.user_id, balance: 5, currency: 'CAD', status: 'active' } });

    const r = await guardedDebit(u.user_id, 8);

    expect(r.count).toBe(0);
    const wallet = await db.strug_wallet.findUnique({ where: { user_id: u.user_id } });
    expect(Number(wallet.balance)).toBe(5);
  });
});
