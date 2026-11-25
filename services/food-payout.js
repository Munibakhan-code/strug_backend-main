import prisma from '../utils/prisma-client.js';
import {
  FOOD_IN_PROGRESS_STATUSES,
  FOOD_SETTLED_STATUSES,
  isFoodSettledStatus,
  vendorNetOf,
} from '../utils/food-vendor-net.js';
import {
  getStripe,
  PAYOUT_CURRENCY,
  createExpressAccount,
  createAccountOnboardingLink,
  connectStatusByAccountId,
  transferToConnect,
} from './stripe-connect.js';
import { decrypt } from '../utils/crypto.js';

export { getStripe, PAYOUT_CURRENCY };

export const SETTLE_REF = (orderId) => `food_order:${orderId}:settle`;
export const REVERSE_REF = (orderId) => `food_order:${orderId}:reverse`;
export const PAYOUT_HOLD_REF = (payoutId) => `food_payout:${payoutId}:hold`;
export const PAYOUT_REFUND_REF = (payoutId) => `food_payout:${payoutId}:refund`;

export async function ensureFoodVendorWallet(tx, { vendor_id, user_id }) {
  if (user_id == null) {
    const err = new Error('Wallet_Owner_Required');
    err.statusCode = 400;
    throw err;
  }
  const db = tx || prisma;
  const existing = await db.food_vendor_wallet.findUnique({ where: { vendor_id } });
  if (existing) return existing;
  return db.food_vendor_wallet.create({
    data: {
      vendor_id,
      user_id,
      currency: PAYOUT_CURRENCY,
    },
  });
}

async function ownerIdForOrder(order) {
  if (order?.food_vendor?.owner_id != null) return order.food_vendor.owner_id;
  if (!order?.vendor_id) return null;
  const vendor = await prisma.food_vendor.findUnique({
    where: { vendor_id: order.vendor_id },
    select: { owner_id: true },
  });
  return vendor?.owner_id ?? null;
}

/** Credit vendor net once when a paid order reaches picked_up / delivered / completed. */
export async function tryCreditSettledFoodOrder(order) {
  if (!order?.food_order_id || !order.vendor_id) return { credited: false };
  if (order.wallet_credited_at) return { credited: false, reason: 'already' };
  if (!order.ispaid) return { credited: false, reason: 'unpaid' };
  if (!isFoodSettledStatus(order.order_status)) return { credited: false, reason: 'not_settled' };

  const net = vendorNetOf(order);
  if (!(net > 0)) return { credited: false, reason: 'zero' };

  const user_id = await ownerIdForOrder(order);
  if (user_id == null) return { credited: false, reason: 'no_owner' };

  try {
    const credited = await prisma.$transaction(async (tx) => {
      const claimed = await tx.food_order.updateMany({
        where: { food_order_id: order.food_order_id, wallet_credited_at: null, ispaid: true },
        data: { wallet_credited_at: new Date() },
      });
      if (claimed.count !== 1) return false;

      await ensureFoodVendorWallet(tx, { vendor_id: order.vendor_id, user_id });
      await tx.food_vendor_wallet.update({
        where: { vendor_id: order.vendor_id },
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
          source: 'food_order_settle',
          description: `Food order #${order.food_order_id} settle`,
          external_ref: SETTLE_REF(order.food_order_id),
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

/** Reverse a settle credit (reject/cancel after pickup). No-op if never credited. */
export async function reverseFoodOrderWalletCredit(order) {
  if (!order?.food_order_id || !order.vendor_id || !order.wallet_credited_at) {
    return { reversed: false };
  }
  const net = vendorNetOf(order);
  const user_id = await ownerIdForOrder(order);
  if (user_id == null || !(net > 0)) return { reversed: false };

  try {
    const reversed = await prisma.$transaction(async (tx) => {
      const claimed = await tx.food_order.updateMany({
        where: { food_order_id: order.food_order_id, wallet_credited_at: { not: null } },
        data: { wallet_credited_at: null },
      });
      if (claimed.count !== 1) return false;

      await tx.food_vendor_wallet.updateMany({
        where: { vendor_id: order.vendor_id },
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
          source: 'food_order_reverse',
          description: `Reverse food order #${order.food_order_id}`,
          external_ref: REVERSE_REF(order.food_order_id),
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

/** Credit any paid settled orders that never landed in the ledger (history + failed fire-and-forget). */
export async function reconcileFoodVendorWallet(vendor_id) {
  if (vendor_id == null) return { credited: 0 };
  const rows = await prisma.food_order.findMany({
    where: {
      vendor_id,
      ispaid: true,
      wallet_credited_at: null,
      order_status: { in: FOOD_SETTLED_STATUSES },
    },
    include: { food_vendor: { select: { owner_id: true } } },
  });
  let credited = 0;
  for (const order of rows) {
    const result = await tryCreditSettledFoodOrder(order);
    if (result?.credited) credited += 1;
  }
  return { credited };
}

export async function foodVendorLedgerRefs(vendor_id) {
  const [orders, payouts] = await Promise.all([
    prisma.food_order.findMany({
      where: { vendor_id },
      select: { food_order_id: true },
    }),
    prisma.food_vendor_payout_request.findMany({
      where: { vendor_id },
      select: { payout_id: true },
    }),
  ]);
  const refs = [];
  for (const o of orders) {
    refs.push(SETTLE_REF(o.food_order_id), REVERSE_REF(o.food_order_id));
  }
  for (const p of payouts) {
    refs.push(PAYOUT_HOLD_REF(p.payout_id), PAYOUT_REFUND_REF(p.payout_id));
  }
  return refs;
}

export async function pendingBalanceForVendor(vendor_id) {
  const rows = await prisma.food_order.findMany({
    where: {
      vendor_id,
      ispaid: true,
      order_status: { in: FOOD_IN_PROGRESS_STATUSES },
    },
    select: { total_amount: true, platform_fee: true, delivery_fee: true, tip_amount: true },
  });
  return rows.reduce((sum, o) => sum + vendorNetOf(o), 0);
}

function validEmail(value) {
  const email = String(value || '').trim();
  if (!email || email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function resolvePlainEmail(value) {
  const direct = validEmail(value);
  if (direct) return direct;
  try {
    return validEmail(decrypt(value));
  } catch {
    return null;
  }
}

async function resolveConnectAccountId(vendor) {
  if (vendor.stripe_account_id) return vendor.stripe_account_id;

  const live = vendor.owner_id
    ? await prisma.live_streamer_profile.findUnique({
        where: { user_id: vendor.owner_id },
        select: { streamer_id: true, stripe_account_id: true },
      })
    : null;

  if (live?.stripe_account_id) {
    await prisma.food_vendor.update({
      where: { vendor_id: vendor.vendor_id },
      data: { stripe_account_id: live.stripe_account_id },
    });
    return live.stripe_account_id;
  }
  return null;
}

export async function createFoodOnboardingLink(vendor, { refreshUrl, returnUrl }) {
  if (!getStripe()) throw new Error('Stripe not configured');

  let accountId = await resolveConnectAccountId(vendor);
  if (!accountId) {
    const user = await prisma.user.findUnique({
      where: { user_id: vendor.owner_id },
      select: { email: true },
    });
    const account = await createExpressAccount({
      email: resolvePlainEmail(user?.email) || undefined,
      metadata: { vendor_id: String(vendor.vendor_id), owner_id: String(vendor.owner_id) },
    });
    accountId = account.id;
    await prisma.food_vendor.update({
      where: { vendor_id: vendor.vendor_id },
      data: { stripe_account_id: accountId },
    });
    const live = await prisma.live_streamer_profile.findUnique({
      where: { user_id: vendor.owner_id },
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

export async function foodConnectStatus(vendor) {
  let accountId = vendor?.stripe_account_id || null;
  if (!accountId && vendor?.owner_id) {
    const live = await prisma.live_streamer_profile.findUnique({
      where: { user_id: vendor.owner_id },
      select: { stripe_account_id: true },
    });
    accountId = live?.stripe_account_id || null;
  }
  return connectStatusByAccountId(accountId);
}

export async function approveFoodPayout(payout, { note } = {}) {
  if (payout.status !== 'PENDING') {
    const err = new Error('Payout_Not_Pending');
    err.statusCode = 409;
    throw err;
  }

  const vendor = payout.vendor;
  const canTransfer = getStripe() && vendor?.stripe_account_id;

  if (canTransfer) {
    const status = await connectStatusByAccountId(vendor.stripe_account_id);
    if (!status.payouts_enabled) {
      // Incomplete Connect must not block ops — fall back to manual APPROVED.
      return prisma.food_vendor_payout_request.update({
        where: { payout_id: payout.payout_id },
        data: { status: 'APPROVED', admin_note: note ?? payout.admin_note, resolved_at: new Date() },
      });
    }
    const transfer = await transferToConnect({
      amount: payout.amount,
      destination: vendor.stripe_account_id,
      metadata: { payout_id: String(payout.payout_id), vendor_id: String(vendor.vendor_id) },
      idempotencyKey: `food_payout_${payout.payout_id}`,
    });
    return prisma.food_vendor_payout_request.update({
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

  return prisma.food_vendor_payout_request.update({
    where: { payout_id: payout.payout_id },
    data: { status: 'APPROVED', admin_note: note ?? payout.admin_note, resolved_at: new Date() },
  });
}

export async function markFoodPaid(payout, { reference } = {}) {
  if (payout.status !== 'PENDING' && payout.status !== 'APPROVED') {
    const err = new Error('Payout_Not_Payable');
    err.statusCode = 409;
    throw err;
  }
  const note = reference ? `Manual payout: ${reference}` : payout.admin_note;
  return prisma.food_vendor_payout_request.update({
    where: { payout_id: payout.payout_id },
    data: { status: 'PAID', admin_note: note, paid_at: new Date(), resolved_at: new Date() },
  });
}

export async function rejectFoodPayout(payout, { note } = {}) {
  if (payout.status !== 'PENDING' && payout.status !== 'APPROVED') {
    const err = new Error('Payout_Not_Rejectable');
    err.statusCode = 409;
    throw err;
  }
  return prisma.$transaction(async (tx) => {
    await tx.food_vendor_wallet.update({
      where: { vendor_id: payout.vendor_id },
      data: { available_balance: { increment: payout.amount } },
    });
    await tx.wallet_transaction.create({
      data: {
        user_id: payout.vendor.owner_id,
        amount: payout.amount,
        type: 'credit',
        source: 'food_payout_refund',
        description: `Refund of rejected food payout #${payout.payout_id}`,
        external_ref: PAYOUT_REFUND_REF(payout.payout_id),
      },
    });
    return tx.food_vendor_payout_request.update({
      where: { payout_id: payout.payout_id },
      data: { status: 'REJECTED', admin_note: note ?? payout.admin_note, resolved_at: new Date() },
    });
  });
}
