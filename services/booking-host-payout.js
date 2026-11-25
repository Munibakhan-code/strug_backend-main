import prisma from '../utils/prisma-client.js';
import {
  getStripe,
  PAYOUT_CURRENCY,
  createExpressAccount,
  createAccountOnboardingLink,
  connectStatusByAccountId,
  transferToConnect,
} from './stripe-connect.js';

export { getStripe, PAYOUT_CURRENCY };

/** Mechanic uses strug_wallet settlement — exclude to avoid double credit. */
export const BOOKING_HOST_WALLET_EXCLUDE_VERTICALS = new Set(['mechanic']);

export const BOOKING_HOST_PENDING_STATUSES = ['confirmed', 'in_progress'];
export const BOOKING_HOST_SETTLED_STATUS = 'completed';

export const SETTLE_REF = (bookingId) => `booking:${bookingId}:settle`;
export const REVERSE_REF = (bookingId) => `booking:${bookingId}:reverse`;
export const PAYOUT_HOLD_REF = (payoutId) => `booking_payout:${payoutId}:hold`;
export const PAYOUT_REFUND_REF = (payoutId) => `booking_payout:${payoutId}:refund`;

export function hostNetOf(booking) {
  const sub = Number(booking?.subtotal ?? 0) || 0;
  const clean = Number(booking?.cleaning_fee ?? 0) || 0;
  return Math.round((sub + clean) * 100) / 100;
}

export function isBookingHostWalletVertical(vertical) {
  return vertical && !BOOKING_HOST_WALLET_EXCLUDE_VERTICALS.has(String(vertical));
}

export function isBookingHostSettled(booking) {
  return booking?.status === BOOKING_HOST_SETTLED_STATUS
    && booking?.payment_status === 'paid'
    && isBookingHostWalletVertical(booking?.vertical);
}

export async function ensureBookingHostWallet(tx, user_id) {
  if (user_id == null) {
    const err = new Error('Wallet_Owner_Required');
    err.statusCode = 400;
    throw err;
  }
  const db = tx || prisma;
  const existing = await db.booking_host_wallet.findUnique({ where: { user_id } });
  if (existing) return existing;
  return db.booking_host_wallet.create({
    data: { user_id, currency: PAYOUT_CURRENCY },
  });
}

export async function ensureBookingHostPayoutProfile(tx, user_id) {
  const db = tx || prisma;
  const existing = await db.booking_host_payout_profile.findUnique({ where: { user_id } });
  if (existing) return existing;
  return db.booking_host_payout_profile.create({ data: { user_id } });
}

/** Credit host net once when a paid booking is completed. */
export async function tryCreditSettledBooking(booking) {
  if (!booking?.booking_id || !booking.host_id) return { credited: false };
  if (booking.wallet_credited_at) return { credited: false, reason: 'already' };
  if (!isBookingHostSettled(booking)) return { credited: false, reason: 'not_settled' };

  const net = hostNetOf(booking);
  if (!(net > 0)) return { credited: false, reason: 'zero' };

  const user_id = booking.host_id;
  try {
    const credited = await prisma.$transaction(async (tx) => {
      const claimed = await tx.booking.updateMany({
        where: {
          booking_id: booking.booking_id,
          wallet_credited_at: null,
          payment_status: 'paid',
          status: BOOKING_HOST_SETTLED_STATUS,
        },
        data: { wallet_credited_at: new Date() },
      });
      if (claimed.count !== 1) return false;

      await ensureBookingHostWallet(tx, user_id);
      await tx.booking_host_wallet.update({
        where: { user_id },
        data: {
          available_balance: { increment: net },
          total_earned: { increment: net },
        },
      });
      await tx.wallet_transaction.create({
        data: {
          user_id,
          amount: net,
          type: 'credit',
          source: 'booking_settle',
          description: `Booking #${booking.booking_id} settle`,
          external_ref: SETTLE_REF(booking.booking_id),
        },
      });
      return true;
    });
    return { credited: !!credited };
  } catch (err) {
    if (err?.code === 'P2002') return { credited: false, reason: 'already' };
    throw err;
  }
}

/** Reverse a settle credit (cancel/refund after complete). No-op if never credited. */
export async function reverseBookingWalletCredit(booking) {
  if (!booking?.booking_id || !booking.host_id || !booking.wallet_credited_at) {
    return { reversed: false };
  }
  if (!isBookingHostWalletVertical(booking.vertical)) return { reversed: false };

  const net = hostNetOf(booking);
  const user_id = booking.host_id;
  if (!(net > 0)) return { reversed: false };

  try {
    const reversed = await prisma.$transaction(async (tx) => {
      const claimed = await tx.booking.updateMany({
        where: { booking_id: booking.booking_id, wallet_credited_at: { not: null } },
        data: { wallet_credited_at: null },
      });
      if (claimed.count !== 1) return false;

      await tx.booking_host_wallet.updateMany({
        where: { user_id },
        data: {
          available_balance: { decrement: net },
          total_earned: { decrement: net },
        },
      });
      await tx.wallet_transaction.create({
        data: {
          user_id,
          amount: net,
          type: 'debit',
          source: 'booking_reverse',
          description: `Reverse booking #${booking.booking_id}`,
          external_ref: REVERSE_REF(booking.booking_id),
        },
      });
      return true;
    });
    return { reversed: !!reversed };
  } catch (err) {
    if (err?.code === 'P2002') return { reversed: false };
    throw err;
  }
}

/** Backfill paid completed bookings that never landed in the ledger. */
export async function reconcileBookingHostWallet(user_id, { vertical } = {}) {
  if (user_id == null) return { credited: 0 };
  const rows = await prisma.booking.findMany({
    where: {
      host_id: user_id,
      payment_status: 'paid',
      wallet_credited_at: null,
      status: BOOKING_HOST_SETTLED_STATUS,
      vertical: vertical
        ? vertical
        : { notIn: [...BOOKING_HOST_WALLET_EXCLUDE_VERTICALS] },
    },
  });
  let credited = 0;
  for (const booking of rows) {
    const result = await tryCreditSettledBooking(booking);
    if (result?.credited) credited += 1;
  }
  return { credited };
}

export async function bookingHostLedgerRefs(user_id, { vertical } = {}) {
  const bookingWhere = {
    host_id: user_id,
    ...(vertical
      ? { vertical }
      : { vertical: { notIn: [...BOOKING_HOST_WALLET_EXCLUDE_VERTICALS] } }),
  };
  const [bookings, payouts] = await Promise.all([
    prisma.booking.findMany({
      where: bookingWhere,
      select: { booking_id: true },
    }),
    prisma.booking_host_payout_request.findMany({
      where: { user_id },
      select: { payout_id: true },
    }),
  ]);
  const refs = [];
  for (const b of bookings) {
    refs.push(SETTLE_REF(b.booking_id), REVERSE_REF(b.booking_id));
  }
  for (const p of payouts) {
    refs.push(PAYOUT_HOLD_REF(p.payout_id), PAYOUT_REFUND_REF(p.payout_id));
  }
  return refs;
}

export async function pendingBalanceForHost(user_id, { vertical } = {}) {
  const rows = await prisma.booking.findMany({
    where: {
      host_id: user_id,
      payment_status: 'paid',
      wallet_credited_at: null,
      status: { in: BOOKING_HOST_PENDING_STATUSES },
      ...(vertical
        ? { vertical }
        : { vertical: { notIn: [...BOOKING_HOST_WALLET_EXCLUDE_VERTICALS] } }),
    },
    select: { subtotal: true, cleaning_fee: true },
  });
  return rows.reduce((sum, b) => sum + hostNetOf(b), 0);
}

async function resolveConnectAccountId(user_id) {
  const profile = await ensureBookingHostPayoutProfile(prisma, user_id);
  if (profile.stripe_account_id) return profile.stripe_account_id;

  const live = await prisma.live_streamer_profile.findUnique({
    where: { user_id },
    select: { streamer_id: true, stripe_account_id: true },
  });
  if (live?.stripe_account_id) {
    await prisma.booking_host_payout_profile.update({
      where: { user_id },
      data: { stripe_account_id: live.stripe_account_id },
    });
    return live.stripe_account_id;
  }

  const food = await prisma.food_vendor.findFirst({
    where: { owner_id: user_id, stripe_account_id: { not: null } },
    select: { stripe_account_id: true },
  });
  if (food?.stripe_account_id) {
    await prisma.booking_host_payout_profile.update({
      where: { user_id },
      data: { stripe_account_id: food.stripe_account_id },
    });
    return food.stripe_account_id;
  }
  return null;
}

export async function createBookingHostOnboardingLink(user_id, { refreshUrl, returnUrl }) {
  if (!getStripe()) throw new Error('Stripe not configured');

  let accountId = await resolveConnectAccountId(user_id);
  if (!accountId) {
    const user = await prisma.user.findUnique({
      where: { user_id },
      select: { email: true },
    });
    const account = await createExpressAccount({
      email: user?.email || undefined,
      metadata: { host_user_id: String(user_id), purpose: 'booking_host' },
    });
    accountId = account.id;
    await ensureBookingHostPayoutProfile(prisma, user_id);
    await prisma.booking_host_payout_profile.update({
      where: { user_id },
      data: { stripe_account_id: accountId },
    });
    const live = await prisma.live_streamer_profile.findUnique({
      where: { user_id },
      select: { streamer_id: true, stripe_account_id: true },
    });
    if (live && !live.stripe_account_id) {
      await prisma.live_streamer_profile.update({
        where: { streamer_id: live.streamer_id },
        data: { stripe_account_id: accountId },
      });
    }
  }

  const link = await createAccountOnboardingLink({ accountId, refreshUrl, returnUrl });
  return { account_id: accountId, url: link.url };
}

export async function bookingHostConnectStatus(user_id) {
  let accountId = null;
  const profile = await prisma.booking_host_payout_profile.findUnique({
    where: { user_id },
    select: { stripe_account_id: true },
  });
  accountId = profile?.stripe_account_id || null;
  if (!accountId) {
    accountId = await resolveConnectAccountId(user_id);
  }
  return connectStatusByAccountId(accountId);
}

export async function approveBookingHostPayout(payout, { note } = {}) {
  if (payout.status !== 'PENDING') {
    const err = new Error('Payout_Not_Pending');
    err.statusCode = 409;
    throw err;
  }

  const profile = await prisma.booking_host_payout_profile.findUnique({
    where: { user_id: payout.user_id },
    select: { stripe_account_id: true },
  });
  const accountId = profile?.stripe_account_id || null;
  const canTransfer = getStripe() && accountId;

  if (canTransfer) {
    const status = await connectStatusByAccountId(accountId);
    if (!status.payouts_enabled) {
      return prisma.booking_host_payout_request.update({
        where: { payout_id: payout.payout_id },
        data: { status: 'APPROVED', admin_note: note ?? payout.admin_note, resolved_at: new Date() },
      });
    }
    const transfer = await transferToConnect({
      amount: payout.amount,
      destination: accountId,
      metadata: { payout_id: String(payout.payout_id), host_user_id: String(payout.user_id) },
      idempotencyKey: `booking_host_payout_${payout.payout_id}`,
    });
    return prisma.booking_host_payout_request.update({
      where: { payout_id: payout.payout_id },
      data: {
        status: 'PAID',
        stripe_transfer_id: transfer.id,
        admin_note: note ?? payout.admin_note,
        paid_at: new Date(),
        resolved_at: new Date(),
      },
    });
  }

  return prisma.booking_host_payout_request.update({
    where: { payout_id: payout.payout_id },
    data: { status: 'APPROVED', admin_note: note ?? payout.admin_note, resolved_at: new Date() },
  });
}

export async function markBookingHostPaid(payout, { reference } = {}) {
  if (payout.status !== 'PENDING' && payout.status !== 'APPROVED') {
    const err = new Error('Payout_Not_Payable');
    err.statusCode = 409;
    throw err;
  }
  const note = reference ? `Manual payout: ${reference}` : payout.admin_note;
  return prisma.booking_host_payout_request.update({
    where: { payout_id: payout.payout_id },
    data: { status: 'PAID', admin_note: note, paid_at: new Date(), resolved_at: new Date() },
  });
}

export async function rejectBookingHostPayout(payout, { note } = {}) {
  if (payout.status !== 'PENDING' && payout.status !== 'APPROVED') {
    const err = new Error('Payout_Not_Rejectable');
    err.statusCode = 409;
    throw err;
  }
  return prisma.$transaction(async (tx) => {
    await tx.booking_host_wallet.update({
      where: { user_id: payout.user_id },
      data: { available_balance: { increment: payout.amount } },
    });
    await tx.wallet_transaction.create({
      data: {
        user_id: payout.user_id,
        amount: payout.amount,
        type: 'credit',
        source: 'booking_payout_refund',
        description: `Refund of rejected booking payout #${payout.payout_id}`,
        external_ref: PAYOUT_REFUND_REF(payout.payout_id),
      },
    });
    return tx.booking_host_payout_request.update({
      where: { payout_id: payout.payout_id },
      data: { status: 'REJECTED', admin_note: note ?? payout.admin_note, resolved_at: new Date() },
    });
  });
}
