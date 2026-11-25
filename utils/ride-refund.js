import Stripe from 'stripe';
import prisma from './prisma-client.js';
import { getExpectedChargeForRide } from './ride-payment-safety.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

export const RIDESHARE_PAYMENT_SOURCE = 'rideshare_payment';
export const RIDESHARE_REFUND_SOURCE = 'rideshare_refund';

/** Legacy env — prefer resolvePassengerCancelFeeRate for passenger cancels. */
export const RIDESHARE_CANCEL_FEE_RATE = Number(process.env.RIDESHARE_CANCEL_FEE_RATE ?? 0);

/** After driver accepts, passenger cancel keeps this share (default 30% → 70% refund). */
export const RIDESHARE_PASSENGER_CANCEL_FEE_RATE = Number(
  process.env.RIDESHARE_PASSENGER_CANCEL_FEE_RATE ?? 0.30,
);

/** No-show (driver arrived, rider never got in): steeper than a plain cancel — the driver
 * already drove to pickup and waited out the full grace period. Default 50% → 50% refund. */
export const RIDESHARE_NO_SHOW_FEE_RATE = Number(
  process.env.RIDESHARE_NO_SHOW_FEE_RATE ?? 0.50,
);

/** Passenger cancel fee: 0 before accept, 30% after driver accepts; system cancels = 0;
 * no-show (driver arrived, rider never got in) = RIDESHARE_NO_SHOW_FEE_RATE regardless of
 * priorStatus (a no-show can only be detected once the ride is already 'accepted'). */
export function resolvePassengerCancelFeeRate(priorStatus, reason = 'cancelled_by_passenger') {
  if (reason === 'no_show') {
    return Math.min(1, Math.max(0, RIDESHARE_NO_SHOW_FEE_RATE));
  }
  if (reason !== 'cancelled_by_passenger') return 0;
  if ((priorStatus || '').toLowerCase() === 'accepted') {
    return Math.min(1, Math.max(0, RIDESHARE_PASSENGER_CANCEL_FEE_RATE));
  }
  return 0;
}

function roundMoney(n) {
  return parseFloat(Number(n).toFixed(2));
}

/**
 * Whole-number fee % for user-facing copy, derived from the actual fee/paid split
 * so messages stay correct if the configured rate ever changes. Falls back to the
 * configured passenger rate when the paid amount is unknown.
 */
export function formatCancelFeePct(cancelFee, paidAmount) {
  const fee = Number(cancelFee);
  const paid = Number(paidAmount);
  if (Number.isFinite(fee) && Number.isFinite(paid) && paid > 0) {
    return Math.round((fee / paid) * 100);
  }
  return Math.round(RIDESHARE_PASSENGER_CANCEL_FEE_RATE * 100);
}

export function rideshareBookingDebitDescription(rideRequestId) {
  return `Rideshare booking #${rideRequestId}`;
}

export function rideshareRefundDescription(rideRequestId, reason) {
  const label = reason ? String(reason).replace(/_/g, ' ') : 'ride cancelled';
  return `Refund — rideshare booking #${rideRequestId} (${label})`;
}

/** Passenger refund after optional cancel fee (v1: fee rate defaults to 0). */
export function computePassengerRefundAmount(paidAmount, cancelFeeRate = RIDESHARE_CANCEL_FEE_RATE) {
  const paid = Number(paidAmount);
  if (!Number.isFinite(paid) || paid <= 0) return 0;
  const rate = Math.min(1, Math.max(0, Number(cancelFeeRate) || 0));
  return roundMoney(paid * (1 - rate));
}

export async function findRideshareWalletDebit(passengerId, rideRequestId) {
  if (!passengerId || !rideRequestId) return null;
  return prisma.wallet_transaction.findFirst({
    where: {
      user_id: Number(passengerId),
      type: 'debit',
      source: RIDESHARE_PAYMENT_SOURCE,
      description: rideshareBookingDebitDescription(rideRequestId),
    },
    orderBy: { created_at: 'desc' },
  });
}

export async function findExistingRideshareRefund(passengerId, rideRequestId) {
  if (!passengerId || !rideRequestId) return null;
  return prisma.wallet_transaction.findFirst({
    where: {
      user_id: Number(passengerId),
      type: 'credit',
      source: RIDESHARE_REFUND_SOURCE,
      description: { startsWith: `Refund — rideshare booking #${rideRequestId}` },
    },
    orderBy: { created_at: 'desc' },
  });
}

export async function resolveRidePaymentMethod(passengerId, rideRequestId) {
  const debit = await findRideshareWalletDebit(passengerId, rideRequestId);
  return debit ? 'wallet' : 'card';
}

async function findStripePaymentIntentForRide(rideRequestId, passengerId) {
  if (!stripe || !rideRequestId || !passengerId) return null;
  const rideId = String(rideRequestId);
  const userId = String(passengerId);
  try {
    if (typeof stripe.paymentIntents.search === 'function') {
      const result = await stripe.paymentIntents.search({
        query: `metadata['ride_request_id']:'${rideId}' AND metadata['user_id']:'${userId}'`,
        limit: 5,
      });
      const match = (result?.data ?? []).find((pi) => pi.status === 'succeeded');
      if (match?.id) return match.id;
    }
  } catch (err) {
    console.warn('[ride-refund] Stripe search unavailable:', err.message);
  }
  return null;
}

async function stripeRefundAlreadyIssued(paymentIntentId) {
  if (!stripe || !paymentIntentId) return false;
  try {
    const refunds = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 5 });
    return (refunds?.data ?? []).some((r) => r.status === 'succeeded' || r.status === 'pending');
  } catch {
    return false;
  }
}

async function refundCardPayment({ paymentIntentId, rideRequestId, passengerId, amount, cancelFeeRate = 0 }) {
  if (!stripe || !paymentIntentId) {
    return { refunded: false, skipped: true, reason: 'stripe_unavailable' };
  }
  const paidAmount = roundMoney(Math.abs(Number(amount)));
  const refundAmount = computePassengerRefundAmount(paidAmount, cancelFeeRate);
  const cancelFee = roundMoney(paidAmount - refundAmount);
  if (await stripeRefundAlreadyIssued(paymentIntentId)) {
    return { refunded: false, already_refunded: true, method: 'card', amount: refundAmount, cancel_fee: cancelFee, paid_amount: paidAmount };
  }
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (pi.status !== 'succeeded') {
    return { refunded: false, skipped: true, reason: 'payment_not_succeeded' };
  }
  if (pi.metadata?.ride_request_id !== String(rideRequestId)) {
    return { refunded: false, skipped: true, reason: 'payment_mismatch' };
  }
  if (pi.metadata?.user_id !== String(passengerId)) {
    return { refunded: false, skipped: true, reason: 'payment_user_mismatch' };
  }
  if (!(refundAmount > 0)) {
    return { refunded: false, skipped: true, reason: 'zero_refund' };
  }
  if (refundAmount >= roundMoney(pi.amount / 100) - 0.01) {
    await stripe.refunds.create({ payment_intent: paymentIntentId });
  } else {
    await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: Math.round(refundAmount * 100),
    });
  }
  return {
    refunded: true,
    method: 'card',
    amount: refundAmount,
    cancel_fee: cancelFee,
    paid_amount: paidAmount,
    payment_intent_id: paymentIntentId,
  };
}

async function refundWalletPayment({ passengerId, rideRequestId, amount, reason, cancelFeeRate = 0 }) {
  const paidAmount = roundMoney(Math.abs(Number(amount)));
  const refundAmount = computePassengerRefundAmount(paidAmount, cancelFeeRate);
  const cancelFee = roundMoney(paidAmount - refundAmount);
  if (!(refundAmount > 0)) {
    return { refunded: false, skipped: true, reason: 'zero_refund' };
  }
  const existing = await findExistingRideshareRefund(passengerId, rideRequestId);
  if (existing) {
    return {
      refunded: false,
      already_refunded: true,
      method: 'wallet',
      amount: roundMoney(Math.abs(Number(existing.amount))),
    };
  }
  const debit = await findRideshareWalletDebit(passengerId, rideRequestId);
  if (!debit) {
    return { refunded: false, skipped: true, reason: 'no_wallet_debit' };
  }

  await prisma.$transaction(async (tx) => {
    const dup = await tx.wallet_transaction.findFirst({
      where: {
        user_id: Number(passengerId),
        type: 'credit',
        source: RIDESHARE_REFUND_SOURCE,
        description: { startsWith: `Refund — rideshare booking #${rideRequestId}` },
      },
    });
    if (dup) return;

    let wallet = await tx.strug_wallet.findUnique({ where: { user_id: Number(passengerId) } });
    if (!wallet) {
      wallet = await tx.strug_wallet.create({
        data: { user_id: Number(passengerId), balance: 0, currency: 'CAD' },
      });
    }
    await tx.strug_wallet.update({
      where: { user_id: Number(passengerId) },
      data: { balance: { increment: refundAmount } },
    });
    await tx.wallet_transaction.create({
      data: {
        user_id: Number(passengerId),
        amount: refundAmount,
        type: 'credit',
        source: RIDESHARE_REFUND_SOURCE,
        description: rideshareRefundDescription(rideRequestId, reason),
      },
    });
  });

  return { refunded: true, method: 'wallet', amount: refundAmount, cancel_fee: cancelFee, paid_amount: paidAmount };
}

/**
 * Refund passenger payment when a paid ride is cancelled before completion.
 * Idempotent — safe to call more than once for the same ride.
 */
export async function refundPassengerRideIfPaid({
  rideRequestId,
  passengerId,
  reason = 'ride_cancelled',
  payment_method,
  payment_intent_id,
  amount,
  cancelFeeRate = RIDESHARE_CANCEL_FEE_RATE,
}) {
  const rideId = Number(rideRequestId);
  const uid = Number(passengerId);
  if (!rideId || !uid) {
    return { refunded: false, skipped: true, reason: 'missing_ids' };
  }

  const ride = await prisma.ride_request.findUnique({ where: { ride_request_id: rideId } });
  if (!ride) return { refunded: false, skipped: true, reason: 'ride_not_found' };

  const status = (ride.status || '').toLowerCase();
  if (status === 'pending_payment') {
    return { refunded: false, skipped: true, reason: 'not_paid' };
  }
  if (status === 'ongoing' || status === 'completed') {
    return { refunded: false, skipped: true, reason: 'ride_not_refundable' };
  }
  if (status === 'cancelled') {
    const existingWalletRefund = await findExistingRideshareRefund(uid, rideId);
    if (existingWalletRefund) {
      return {
        refunded: false,
        already_refunded: true,
        method: 'wallet',
        amount: roundMoney(Math.abs(Number(existingWalletRefund.amount))),
      };
    }
  } else if (status !== 'scheduled' && status !== 'pending' && status !== 'accepted') {
    return { refunded: false, skipped: true, reason: 'ride_not_refundable' };
  }

  const method = payment_method ?? (await resolveRidePaymentMethod(uid, rideId));
  const paidAmount =
    amount ??
    (await findRideshareWalletDebit(uid, rideId))?.amount ??
    getExpectedChargeForRide(ride);

  const numericPaid = roundMoney(Math.abs(Number(paidAmount)));
  if (!(numericPaid > 0)) {
    return { refunded: false, skipped: true, reason: 'no_paid_amount' };
  }

  if (method === 'wallet') {
    return refundWalletPayment({
      passengerId: uid,
      rideRequestId: rideId,
      amount: numericPaid,
      reason,
      cancelFeeRate,
    });
  }

  const piId = payment_intent_id ?? (await findStripePaymentIntentForRide(rideId, uid));
  if (!piId) {
    return { refunded: false, skipped: true, reason: 'no_card_payment', method: 'card' };
  }
  return refundCardPayment({
    paymentIntentId: piId,
    rideRequestId: rideId,
    passengerId: uid,
    amount: numericPaid,
    cancelFeeRate,
  });
}

/** @deprecated Use refundPassengerRideIfPaid — kept for confirm-payment call sites. */
export async function refundRidePayment({
  payment_method,
  payment_intent_id,
  userId,
  rideRequestId,
  amount,
  reason = 'ride_not_dispatched',
}) {
  return refundPassengerRideIfPaid({
    rideRequestId,
    passengerId: userId,
    reason,
    payment_method,
    payment_intent_id,
    amount,
  });
}
