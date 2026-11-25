import { describe, it, expect, vi } from 'vitest';

// Offline money-safety test for the live-streamer payout disbursement service.
// Mocks the Prisma singleton + Stripe SDK with tiny in-memory fakes and drives
// the REAL approve/reject/mark-paid handlers. Focus: the wallet must never be
// double-debited or double-paid, and a reject must refund the held funds.

const h = vi.hoisted(() => {
  const store = { payouts: [], wallets: {}, txns: [] };
  const transfers = [];

  const client = {
    live_streamer_wallet: {
      update: async ({ where, data }) => {
        const w = store.wallets[where.streamer_id];
        if (data.balance?.increment) w.balance += data.balance.increment;
        return w;
      },
    },
    wallet_transaction: {
      create: async ({ data }) => { store.txns.push(data); return data; },
    },
    live_payout_request: {
      update: async ({ where, data }) => {
        const row = store.payouts.find((p) => p.payout_id === where.payout_id);
        Object.assign(row, data);
        return row;
      },
    },
    // Run the callback against the same fake client (no real transaction needed).
    $transaction: async (fn) => fn(client),
  };

  const stripe = {
    accounts: {
      retrieve: async () => ({ payouts_enabled: true, charges_enabled: true, details_submitted: true }),
    },
    transfers: {
      create: async (params) => {
        const t = { id: `tr_${transfers.length + 1}`, ...params };
        transfers.push(t);
        return t;
      },
    },
  };

  return { store, transfers, client, stripe };
});

vi.mock('../../utils/prisma-client.js', () => ({ default: h.client }));
// The service builds `new Stripe(key)` at import; return our fake from the ctor.
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
vi.mock('stripe', () => ({ default: class { constructor() { return h.stripe; } } }));

const { approvePayout, rejectPayout, markPaid } = await import('../../services/live-payout.js');

const makePayout = (over = {}) => {
  const payout = {
    payout_id: 1,
    streamer_id: 7,
    amount: 150,
    status: 'PENDING',
    admin_note: null,
    streamer: { streamer_id: 7, user_id: 42, handle: 'creator', stripe_account_id: null },
    ...over,
  };
  h.store.payouts = [payout];
  h.store.wallets[7] = { streamer_id: 7, balance: 0 }; // funds already held (debited at request time)
  h.store.txns = [];
  h.transfers.length = 0;
  return payout;
};

describe('approvePayout', () => {
  it('clears to APPROVED for manual disbursement when no Connect account', async () => {
    const p = makePayout();
    const out = await approvePayout(p);
    expect(out.status).toBe('APPROVED');
    expect(h.transfers).toHaveLength(0);     // no money moved automatically
    expect(h.store.wallets[7].balance).toBe(0); // wallet untouched (already held)
  });

  it('transfers via Connect and marks PAID when an account is connected', async () => {
    const p = makePayout({ streamer: { streamer_id: 7, user_id: 42, handle: 'creator', stripe_account_id: 'acct_1' } });
    const out = await approvePayout(p);
    expect(out.status).toBe('PAID');
    expect(out.stripe_transfer_id).toBe('tr_1');
    expect(h.transfers).toHaveLength(1);
    expect(h.transfers[0].amount).toBe(15000);       // dollars → cents
    expect(h.transfers[0].destination).toBe('acct_1');
  });

  it('refuses to approve a non-PENDING payout (no double pay)', async () => {
    const p = makePayout({ status: 'PAID' });
    await expect(approvePayout(p)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.transfers).toHaveLength(0);
  });
});

describe('rejectPayout', () => {
  it('refunds the held funds to the wallet and marks REJECTED', async () => {
    const p = makePayout();
    const out = await rejectPayout(p);
    expect(out.status).toBe('REJECTED');
    expect(h.store.wallets[7].balance).toBe(150);    // funds returned
    expect(h.store.txns).toEqual([
      expect.objectContaining({ user_id: 42, amount: 150, type: 'credit', source: 'live_payout_refund' }),
    ]);
  });

  it('refuses to reject an already-PAID payout (money already left)', async () => {
    const p = makePayout({ status: 'PAID' });
    await expect(rejectPayout(p)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.store.wallets[7].balance).toBe(0);      // no spurious refund
  });
});

describe('markPaid', () => {
  it('marks an APPROVED payout PAID with a reference note', async () => {
    const p = makePayout({ status: 'APPROVED' });
    const out = await markPaid(p, { reference: 'etransfer-999' });
    expect(out.status).toBe('PAID');
    expect(out.admin_note).toContain('etransfer-999');
    expect(out.paid_at).toBeInstanceOf(Date);
  });
});
