import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const store = {
    wallets: {},
    profiles: {},
    payouts: [],
    bookings: [],
    txns: [],
  };

  function matchesBookingWhere(b, where = {}) {
    if (where.host_id != null && b.host_id !== where.host_id) return false;
    if (where.booking_id != null && b.booking_id !== where.booking_id) return false;
    if (where.payment_status != null && b.payment_status !== where.payment_status) return false;
    if (where.status != null && typeof where.status === 'string' && b.status !== where.status) return false;
    if (where.status?.in && !where.status.in.includes(b.status)) return false;
    if (Object.prototype.hasOwnProperty.call(where, 'wallet_credited_at')) {
      if (where.wallet_credited_at === null && b.wallet_credited_at != null) return false;
      if (where.wallet_credited_at?.not != null && b.wallet_credited_at == null) return false;
    }
    if (typeof where.vertical === 'string' && b.vertical !== where.vertical) return false;
    if (where.vertical?.notIn && where.vertical.notIn.includes(b.vertical)) return false;
    return true;
  }

  const client = {
    booking_host_wallet: {
      findUnique: async ({ where }) => store.wallets[where.user_id] || null,
      create: async ({ data }) => {
        const w = {
          wallet_id: Object.keys(store.wallets).length + 1,
          available_balance: 0,
          total_earned: 0,
          ...data,
        };
        store.wallets[data.user_id] = w;
        return w;
      },
      update: async ({ where, data }) => {
        const w = store.wallets[where.user_id];
        if (!w) return w;
        if (data.available_balance?.increment) w.available_balance += data.available_balance.increment;
        if (data.available_balance?.decrement) w.available_balance -= data.available_balance.decrement;
        if (data.total_earned?.increment) w.total_earned += data.total_earned.increment;
        if (data.total_earned?.decrement) w.total_earned -= data.total_earned.decrement;
        return w;
      },
      updateMany: async ({ where, data }) => {
        const rows = Object.values(store.wallets).filter((w) => {
          if (where.user_id != null && w.user_id !== where.user_id) return false;
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
    booking_host_payout_profile: {
      findUnique: async ({ where }) => store.profiles[where.user_id] || null,
      create: async ({ data }) => {
        const p = { ...data };
        store.profiles[data.user_id] = p;
        return p;
      },
      update: async ({ where, data }) => {
        const p = store.profiles[where.user_id] || { user_id: where.user_id };
        Object.assign(p, data);
        store.profiles[where.user_id] = p;
        return p;
      },
    },
    booking: {
      findMany: async ({ where = {}, select } = {}) => {
        const rows = store.bookings.filter((b) => matchesBookingWhere(b, where));
        if (!select) return rows;
        return rows.map((b) => Object.fromEntries(Object.keys(select).map((k) => [k, b[k]])));
      },
      updateMany: async ({ where, data }) => {
        const matches = store.bookings.filter((b) => matchesBookingWhere(b, where));
        matches.forEach((b) => Object.assign(b, data));
        return { count: matches.length };
      },
    },
    booking_host_payout_request: {
      findMany: async ({ where = {} } = {}) => store.payouts.filter((p) => {
        if (where.user_id != null && p.user_id !== where.user_id) return false;
        return true;
      }),
      update: async ({ where, data }) => {
        const row = store.payouts.find((p) => p.payout_id === where.payout_id);
        Object.assign(row, data);
        return row;
      },
    },
    wallet_transaction: {
      create: async ({ data }) => {
        store.txns.push(data);
        return data;
      },
    },
    live_streamer_profile: {
      findUnique: async () => null,
    },
    food_vendor: {
      findFirst: async () => null,
    },
    user: {
      findUnique: async () => ({ email: 'host@test.com' }),
    },
    $transaction: async (fn) => fn(client),
  };

  return { store, client };
});

vi.mock('../../utils/prisma-client.js', () => ({ default: h.client }));
vi.mock('../../services/stripe-connect.js', () => ({
  getStripe: () => null,
  PAYOUT_CURRENCY: 'CAD',
  createExpressAccount: vi.fn(),
  createAccountOnboardingLink: vi.fn(),
  connectStatusByAccountId: vi.fn(async () => ({ connected: false, payouts_enabled: false })),
  transferToConnect: vi.fn(),
}));

import {
  hostNetOf,
  tryCreditSettledBooking,
  reverseBookingWalletCredit,
  pendingBalanceForHost,
  reconcileBookingHostWallet,
} from '../../services/booking-host-payout.js';

describe('booking-host-payout', () => {
  beforeEach(() => {
    h.store.wallets = {};
    h.store.profiles = {};
    h.store.payouts = [];
    h.store.bookings = [];
    h.store.txns = [];
  });

  it('computes host net as subtotal + cleaning_fee', () => {
    expect(hostNetOf({ subtotal: 100, cleaning_fee: 20, service_fee: 12 })).toBe(120);
  });

  it('credits available balance once on paid completed booking', async () => {
    const booking = {
      booking_id: 1,
      host_id: 39,
      vertical: 'hotel',
      status: 'completed',
      payment_status: 'paid',
      subtotal: 200,
      cleaning_fee: 30,
      wallet_credited_at: null,
    };
    h.store.bookings.push(booking);

    const first = await tryCreditSettledBooking(booking);
    expect(first.credited).toBe(true);
    expect(h.store.wallets[39].available_balance).toBe(230);
    expect(h.store.wallets[39].total_earned).toBe(230);
    expect(booking.wallet_credited_at).toBeTruthy();

    const second = await tryCreditSettledBooking(booking);
    expect(second.credited).toBe(false);
    expect(h.store.wallets[39].available_balance).toBe(230);
  });

  it('skips mechanic vertical', async () => {
    const booking = {
      booking_id: 2,
      host_id: 39,
      vertical: 'mechanic',
      status: 'completed',
      payment_status: 'paid',
      subtotal: 80,
      cleaning_fee: 0,
      wallet_credited_at: null,
    };
    const result = await tryCreditSettledBooking(booking);
    expect(result.credited).toBe(false);
    expect(h.store.wallets[39]).toBeUndefined();
  });

  it('treats paid confirmed stays as pending (not available)', async () => {
    h.store.bookings.push({
      booking_id: 3,
      host_id: 39,
      vertical: 'hotel',
      status: 'confirmed',
      payment_status: 'paid',
      subtotal: 150,
      cleaning_fee: 10,
      wallet_credited_at: null,
    });
    const pending = await pendingBalanceForHost(39, { vertical: 'hotel' });
    expect(pending).toBe(160);
  });

  it('reconciles completed unpaid-to-ledger bookings', async () => {
    h.store.bookings.push({
      booking_id: 4,
      host_id: 39,
      vertical: 'hotel',
      status: 'completed',
      payment_status: 'paid',
      subtotal: 100,
      cleaning_fee: 0,
      wallet_credited_at: null,
    });
    const { credited } = await reconcileBookingHostWallet(39, { vertical: 'hotel' });
    expect(credited).toBe(1);
    expect(h.store.wallets[39].available_balance).toBe(100);
  });

  it('reverses a settle credit', async () => {
    const booking = {
      booking_id: 5,
      host_id: 39,
      vertical: 'tempstay',
      status: 'completed',
      payment_status: 'paid',
      subtotal: 90,
      cleaning_fee: 10,
      wallet_credited_at: null,
    };
    h.store.bookings.push(booking);
    await tryCreditSettledBooking(booking);
    const rev = await reverseBookingWalletCredit(booking);
    expect(rev.reversed).toBe(true);
    expect(h.store.wallets[39].available_balance).toBe(0);
    expect(booking.wallet_credited_at).toBeNull();
  });
});
