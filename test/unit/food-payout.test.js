import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => {
  const store = { payouts: [], wallets: {}, txns: [], orders: [] };
  const transfers = [];
  const state = { payoutsEnabled: true };

  function matchesOrderWhere(o, where = {}) {
    if (where.vendor_id != null && o.vendor_id !== where.vendor_id) return false;
    if (where.food_order_id != null && o.food_order_id !== where.food_order_id) return false;
    if (where.ispaid != null && o.ispaid !== where.ispaid) return false;
    if (Object.prototype.hasOwnProperty.call(where, 'wallet_credited_at')) {
      if (where.wallet_credited_at === null && o.wallet_credited_at != null) return false;
      if (where.wallet_credited_at?.not != null && o.wallet_credited_at == null) return false;
    }
    if (where.order_status?.in && !where.order_status.in.includes(o.order_status)) return false;
    return true;
  }

  const client = {
    food_vendor_wallet: {
      findUnique: async ({ where }) => store.wallets[where.vendor_id] || null,
      create: async ({ data }) => {
        const w = {
          wallet_id: Object.keys(store.wallets).length + 1,
          available_balance: 0,
          total_earned: 0,
          ...data,
        };
        store.wallets[data.vendor_id] = w;
        return w;
      },
      update: async ({ where, data }) => {
        const w = store.wallets[where.vendor_id]
          || Object.values(store.wallets).find((row) => row.wallet_id === where.wallet_id);
        if (!w) return w;
        if (data.available_balance?.increment) w.available_balance += data.available_balance.increment;
        if (data.available_balance?.decrement) w.available_balance -= data.available_balance.decrement;
        if (data.total_earned?.increment) w.total_earned += data.total_earned.increment;
        if (data.total_earned?.decrement) w.total_earned -= data.total_earned.decrement;
        return w;
      },
      updateMany: async ({ where, data }) => {
        const rows = Object.values(store.wallets).filter((w) => {
          if (where.vendor_id != null && w.vendor_id !== where.vendor_id) return false;
          if (where.wallet_id != null && w.wallet_id !== where.wallet_id) return false;
          if (where.available_balance?.gte != null && w.available_balance < where.available_balance.gte) return false;
          return true;
        });
        for (const w of rows) {
          if (data.available_balance?.decrement) w.available_balance -= data.available_balance.decrement;
          if (data.available_balance?.increment) w.available_balance += data.available_balance.increment;
          if (data.total_earned?.decrement) w.total_earned -= data.total_earned.decrement;
        }
        return { count: rows.length };
      },
    },
    food_order: {
      findMany: async ({ where = {}, select } = {}) => {
        const rows = store.orders.filter((o) => matchesOrderWhere(o, where));
        if (!select) return rows;
        return rows.map((o) => Object.fromEntries(Object.keys(select).map((k) => [k, o[k]])));
      },
      updateMany: async ({ where, data }) => {
        const matches = store.orders.filter((o) => matchesOrderWhere(o, where));
        matches.forEach((o) => Object.assign(o, data));
        return { count: matches.length };
      },
    },
    food_vendor_payout_request: {
      findMany: async ({ where = {} } = {}) => store.payouts.filter((p) => {
        if (where.vendor_id != null && p.vendor_id !== where.vendor_id) return false;
        return true;
      }),
      update: async ({ where, data }) => {
        const row = store.payouts.find((p) => p.payout_id === where.payout_id);
        Object.assign(row, data);
        return row;
      },
    },
    food_vendor: {
      findUnique: async ({ where }) => ({ vendor_id: where.vendor_id, owner_id: 42 }),
    },
    live_streamer_profile: {
      findUnique: async () => null,
    },
    user: {
      findUnique: async () => ({ email: 'a@b.c' }),
    },
    wallet_transaction: {
      create: async ({ data }) => { store.txns.push(data); return data; },
    },
    $transaction: async (fn) => fn(client),
  };

  const stripe = {
    accounts: {
      retrieve: async () => ({
        payouts_enabled: state.payoutsEnabled,
        charges_enabled: true,
        details_submitted: true,
      }),
    },
    transfers: {
      create: async (params) => {
        const t = { id: `tr_${transfers.length + 1}`, ...params };
        transfers.push(t);
        return t;
      },
    },
  };

  return { store, transfers, client, stripe, state };
});

vi.mock('../../utils/prisma-client.js', () => ({ default: h.client }));
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
vi.mock('stripe', () => ({ default: class { constructor() { return h.stripe; } } }));

const {
  approveFoodPayout,
  rejectFoodPayout,
  markFoodPaid,
  reconcileFoodVendorWallet,
  foodVendorLedgerRefs,
  SETTLE_REF,
  REVERSE_REF,
  PAYOUT_HOLD_REF,
  PAYOUT_REFUND_REF,
} = await import('../../services/food-payout.js');

const makePayout = (over = {}) => {
  h.state.payoutsEnabled = true;
  const payout = {
    payout_id: 1,
    vendor_id: 9,
    amount: 150,
    status: 'PENDING',
    admin_note: null,
    vendor: { vendor_id: 9, owner_id: 42, vendor_name: 'Kitchen', stripe_account_id: null },
    ...over,
  };
  h.store.payouts = [payout];
  h.store.wallets[9] = { vendor_id: 9, wallet_id: 1, user_id: 42, available_balance: 0, total_earned: 0 };
  h.store.txns = [];
  h.store.orders = [];
  h.transfers.length = 0;
  return payout;
};

describe('approveFoodPayout', () => {
  it('clears to APPROVED for manual disbursement when no Connect account', async () => {
    const p = makePayout();
    const out = await approveFoodPayout(p);
    expect(out.status).toBe('APPROVED');
    expect(h.transfers).toHaveLength(0);
    expect(h.store.wallets[9].available_balance).toBe(0);
  });

  it('transfers via Connect and marks PAID when an account is connected', async () => {
    const p = makePayout({ vendor: { vendor_id: 9, owner_id: 42, vendor_name: 'Kitchen', stripe_account_id: 'acct_1' } });
    const out = await approveFoodPayout(p);
    expect(out.status).toBe('PAID');
    expect(out.stripe_transfer_id).toBe('tr_1');
    expect(h.transfers).toHaveLength(1);
    expect(h.transfers[0].amount).toBe(15000);
    expect(h.transfers[0].destination).toBe('acct_1');
  });

  it('falls back to APPROVED (no transfer) when Connect exists but payouts are not enabled', async () => {
    h.state.payoutsEnabled = false;
    const p = makePayout({ vendor: { vendor_id: 9, owner_id: 42, vendor_name: 'Kitchen', stripe_account_id: 'acct_1' } });
    h.state.payoutsEnabled = false;
    const out = await approveFoodPayout(p);
    expect(out.status).toBe('APPROVED');
    expect(out.stripe_transfer_id).toBeUndefined();
    expect(h.transfers).toHaveLength(0);
  });

  it('refuses to approve a non-PENDING payout (no double pay)', async () => {
    const p = makePayout({ status: 'PAID' });
    await expect(approveFoodPayout(p)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.transfers).toHaveLength(0);
  });
});

describe('rejectFoodPayout', () => {
  it('refunds the held funds to the wallet and marks REJECTED', async () => {
    const p = makePayout();
    const out = await rejectFoodPayout(p);
    expect(out.status).toBe('REJECTED');
    expect(h.store.wallets[9].available_balance).toBe(150);
    expect(h.store.txns).toEqual([
      expect.objectContaining({
        user_id: 42,
        amount: 150,
        type: 'credit',
        source: 'food_payout_refund',
        external_ref: PAYOUT_REFUND_REF(1),
      }),
    ]);
  });

  it('refuses to reject an already-PAID payout (money already left)', async () => {
    const p = makePayout({ status: 'PAID' });
    await expect(rejectFoodPayout(p)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.store.wallets[9].available_balance).toBe(0);
  });
});

describe('markFoodPaid', () => {
  it('marks an APPROVED payout PAID with a reference note', async () => {
    const p = makePayout({ status: 'APPROVED' });
    const out = await markFoodPaid(p, { reference: 'etransfer-999' });
    expect(out.status).toBe('PAID');
    expect(out.admin_note).toContain('etransfer-999');
    expect(out.paid_at).toBeInstanceOf(Date);
  });
});

describe('reconcileFoodVendorWallet', () => {
  it('credits a settled unpaid-to-ledger order once only', async () => {
    h.store.orders = [{
      food_order_id: 77,
      vendor_id: 9,
      ispaid: true,
      wallet_credited_at: null,
      order_status: 'delivered',
      platform_fee: 8,
      food_vendor: { owner_id: 42 },
    }];
    h.store.wallets[9] = { vendor_id: 9, wallet_id: 1, user_id: 42, available_balance: 0, total_earned: 0 };
    h.store.txns = [];

    const first = await reconcileFoodVendorWallet(9);
    expect(first.credited).toBe(1);
    expect(h.store.wallets[9].available_balance).toBe(100);
    expect(h.store.wallets[9].total_earned).toBe(100);
    expect(h.store.orders[0].wallet_credited_at).toBeInstanceOf(Date);
    expect(h.store.txns).toEqual([
      expect.objectContaining({
        source: 'food_order_settle',
        external_ref: SETTLE_REF(77),
        amount: 100,
        type: 'credit',
      }),
    ]);

    const second = await reconcileFoodVendorWallet(9);
    expect(second.credited).toBe(0);
    expect(h.store.txns).toHaveLength(1);
    expect(h.store.wallets[9].available_balance).toBe(100);
  });
});

describe('foodVendorLedgerRefs', () => {
  it('returns settle/reverse and payout hold/refund refs for this vendor only', async () => {
    h.store.orders = [
      { food_order_id: 5, vendor_id: 9 },
      { food_order_id: 6, vendor_id: 88 },
    ];
    h.store.payouts = [
      { payout_id: 3, vendor_id: 9 },
      { payout_id: 4, vendor_id: 88 },
    ];
    expect(await foodVendorLedgerRefs(9)).toEqual([
      SETTLE_REF(5),
      REVERSE_REF(5),
      PAYOUT_HOLD_REF(3),
      PAYOUT_REFUND_REF(3),
    ]);
    expect(await foodVendorLedgerRefs(88)).toEqual([
      SETTLE_REF(6),
      REVERSE_REF(6),
      PAYOUT_HOLD_REF(4),
      PAYOUT_REFUND_REF(4),
    ]);
  });
});
