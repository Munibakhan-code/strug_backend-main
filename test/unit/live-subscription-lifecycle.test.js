import { describe, it, expect, beforeEach, vi } from 'vitest';

// Offline lifecycle test for the live-subscription webhook handlers. Docker/Neon
// aren't available locally, so we mock the Prisma singleton with a tiny in-memory
// store and drive the REAL handlers through subscribe -> renew -> fail -> cancel.
// The handlers read attribution + period from the invoice object (no Stripe call
// on the happy path), so this exercises the true code path.

const h = vi.hoisted(() => {
  const store = { streamers: {}, subs: [], payments: [], wallets: {}, txns: [] };
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const findSub = (su, st) => store.subs.find((r) => r.subscriber_user_id === su && r.streamer_id === st);
  const matches = (row, where) => Object.entries(where)
    .filter(([k]) => k !== 'OR')
    .every(([k, v]) => row[k] === v);

  const client = {
    live_subscription_payment: {
      findUnique: async ({ where }) =>
        store.payments.find((p) => p.stripe_invoice_id === where.stripe_invoice_id) || null,
      create: async ({ data }) => {
        if (store.payments.some((p) => p.stripe_invoice_id === data.stripe_invoice_id)) {
          const e = new Error('Unique constraint'); e.code = 'P2002'; throw e;
        }
        const row = { payment_id: store.payments.length + 1, ...data };
        store.payments.push(row);
        return row;
      },
    },
    live_subscription: {
      findUnique: async ({ where }) => {
        const k = where.subscriber_user_id_streamer_id;
        return findSub(k.subscriber_user_id, k.streamer_id) || null;
      },
      upsert: async ({ where, update, create }) => {
        const k = where.subscriber_user_id_streamer_id;
        const row = findSub(k.subscriber_user_id, k.streamer_id);
        if (row) { Object.assign(row, clean(update)); return row; }
        const created = { subscription_id: store.subs.length + 1, cancel_at_period_end: false, ...create };
        store.subs.push(created);
        return created;
      },
      update: async ({ where, data }) => {
        const row = store.subs.find((r) => r.subscription_id === where.subscription_id);
        Object.assign(row, clean(data));
        return row;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        store.subs.forEach((r) => { if (matches(r, where)) { Object.assign(r, clean(data)); count++; } });
        return { count };
      },
    },
    live_streamer_wallet: {
      upsert: async ({ where, update, create }) => {
        const id = where.streamer_id;
        let w = store.wallets[id];
        if (w) {
          if (update.balance?.increment) w.balance += update.balance.increment;
          return w;
        }
        w = { ...create, balance: typeof create.balance === 'number' ? create.balance : 0 };
        store.wallets[id] = w;
        return w;
      },
    },
    wallet_transaction: { create: async ({ data }) => { store.txns.push(data); return data; } },
    live_streamer_profile: { findUnique: async ({ where }) => store.streamers[where.streamer_id] || null },
    $transaction: async (fn) => fn(client),
  };
  return { store, client };
});

vi.mock('../../utils/prisma-client.js', () => ({ default: h.client }));

const {
  handleInvoicePaid,
  handlePaymentFailed,
  handleSubscriptionDeleted,
  isSubscribed,
} = await import('../../services/live-subscription.js');

const STREAMER_ID = 7;
const SUBSCRIBER_ID = 42;
const STRIPE_SUB = 'sub_test_123';
const FUTURE = Math.floor(Date.UTC(2999, 0, 1) / 1000); // far-future period end

// A Stripe invoice.paid object as our handler reads it (metadata + line period
// live on the invoice — no Stripe round-trip needed).
const invoice = (id, periodEnd = FUTURE) => ({
  id,
  subscription: STRIPE_SUB,
  customer: 'cus_test_1',
  currency: 'cad',
  amount_paid: 499,
  subscription_details: {
    metadata: { streamer_id: String(STREAMER_ID), subscriber_user_id: String(SUBSCRIBER_ID) },
  },
  lines: { data: [{ period: { end: periodEnd }, price: { id: 'price_test_1' } }] },
});

beforeEach(() => {
  h.store.subs.length = 0;
  h.store.payments.length = 0;
  h.store.txns.length = 0;
  h.store.wallets = {};
  h.store.streamers = { [STREAMER_ID]: { streamer_id: STREAMER_ID, user_id: 99, handle: 'tester' } };
});

describe('subscription lifecycle', () => {
  it('invoice.paid activates the sub and splits 70/30 into the wallet', async () => {
    await handleInvoicePaid(invoice('in_1'));

    expect(await isSubscribed(SUBSCRIBER_ID, STREAMER_ID)).toBe(true);
    expect(h.store.wallets[STREAMER_ID].balance).toBeCloseTo(3.49, 2); // creator 70%
    const platformTxn = h.store.txns.find((t) => t.source === 'live_subscription_tax');
    expect(Number(platformTxn.amount)).toBeCloseTo(1.5, 2); // platform 30%
    expect(platformTxn.user_id).toBe(1);
    expect(h.store.payments).toHaveLength(1);
  });

  it('is idempotent — a re-delivered invoice does not double-credit', async () => {
    await handleInvoicePaid(invoice('in_1'));
    const res = await handleInvoicePaid(invoice('in_1')); // same invoice id again

    expect(res.idempotent).toBe(true);
    expect(h.store.wallets[STREAMER_ID].balance).toBeCloseTo(3.49, 2); // unchanged
    expect(h.store.payments).toHaveLength(1);
  });

  it('payment_failed -> past_due revokes access; a later renewal restores it', async () => {
    await handleInvoicePaid(invoice('in_1'));

    await handlePaymentFailed({ subscription: STRIPE_SUB });
    expect(await isSubscribed(SUBSCRIBER_ID, STREAMER_ID)).toBe(false);

    await handleInvoicePaid(invoice('in_2')); // next month's successful charge
    expect(await isSubscribed(SUBSCRIBER_ID, STREAMER_ID)).toBe(true);
    expect(h.store.wallets[STREAMER_ID].balance).toBeCloseTo(6.98, 2); // two payouts
    expect(h.store.payments).toHaveLength(2);
  });

  it('subscription.deleted marks canceled and revokes access', async () => {
    await handleInvoicePaid(invoice('in_1'));
    await handleSubscriptionDeleted({ id: STRIPE_SUB });

    expect(await isSubscribed(SUBSCRIBER_ID, STREAMER_ID)).toBe(false);
    expect(h.store.subs[0].status).toBe('canceled');
  });

  it('an expired period revokes access even while status is active', async () => {
    const past = Math.floor(Date.UTC(2000, 0, 1) / 1000);
    await handleInvoicePaid(invoice('in_old', past));
    expect(h.store.subs[0].status).toBe('active');
    expect(await isSubscribed(SUBSCRIBER_ID, STREAMER_ID)).toBe(false); // period lapsed
  });
});
