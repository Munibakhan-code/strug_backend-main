/** Rideshare driver/platform split — single source for settlement math. */
export const DRIVER_PAYOUT_RATE = 0.79;
export const PLATFORM_FEE_RATE = 0.21;

function roundMoney(n) {
  return parseFloat(Number(n).toFixed(2));
}

/**
 * @param {number|null|undefined} totalFare — rider all-in fare charged at booking
 * @returns {{ total_fare: number|null, driver_payout: number|null, platform_fee: number|null }}
 */
export function computeRideSettlement(totalFare) {
  const total = totalFare != null && totalFare !== '' ? Number(totalFare) : null;
  if (total == null || Number.isNaN(total) || total <= 0) {
    return { total_fare: null, driver_payout: null, platform_fee: null };
  }
  const driver_payout = roundMoney(total * DRIVER_PAYOUT_RATE);
  const platform_fee = roundMoney(total - driver_payout);
  return { total_fare: roundMoney(total), driver_payout, platform_fee };
}

export const RIDESHARE_PAYOUT_SOURCE = 'rideshare_payout';

export function ridesharePayoutDescription(tripId) {
  return `Rideshare payout #${tripId}`;
}

/**
 * Credit driver wallet once per trip (idempotent on trip_id description).
 */
export async function creditDriverRidePayout(tx, { tripId, driverUserId, driverPayout }) {
  if (!driverUserId || !(driverPayout > 0)) return { credited: false };

  const existing = await tx.wallet_transaction.findFirst({
    where: {
      user_id: driverUserId,
      type: 'credit',
      source: RIDESHARE_PAYOUT_SOURCE,
      description: ridesharePayoutDescription(tripId),
    },
  });
  if (existing) return { credited: false, already_credited: true };

  let wallet = await tx.strug_wallet.findUnique({ where: { user_id: driverUserId } });
  if (!wallet) {
    wallet = await tx.strug_wallet.create({
      data: { user_id: driverUserId, balance: 0, currency: 'CAD' },
    });
  }

  await tx.strug_wallet.update({
    where: { user_id: driverUserId },
    data: { balance: { increment: driverPayout } },
  });
  await tx.wallet_transaction.create({
    data: {
      user_id: driverUserId,
      amount: driverPayout,
      type: 'credit',
      source: RIDESHARE_PAYOUT_SOURCE,
      description: ridesharePayoutDescription(tripId),
    },
  });
  return { credited: true };
}

export const RIDESHARE_TIP_SOURCE = 'rideshare_tip';

export function ridesharTipDescription(tripId) {
  return `Rideshare tip #${tripId}`;
}

/**
 * Credit driver wallet with a rider tip — 100%, no platform-fee split (tips bypass
 * DRIVER_PAYOUT_RATE entirely, mirroring work_job.tip_amount's "100% to the worker" convention).
 * Idempotent on the Stripe PaymentIntent id via wallet_transaction.external_ref's UNIQUE
 * constraint — callers should catch a thrown P2002 and treat it as "already credited," the same
 * pattern used by routes/work-wallet-routes.js's topup/confirm.
 */
export async function creditDriverTip(tx, { tripId, driverUserId, tipAmount, paymentIntentId }) {
  if (!driverUserId || !(tipAmount > 0)) return { credited: false };

  let wallet = await tx.strug_wallet.findUnique({ where: { user_id: driverUserId } });
  if (!wallet) {
    wallet = await tx.strug_wallet.create({
      data: { user_id: driverUserId, balance: 0, currency: 'CAD' },
    });
  }

  await tx.strug_wallet.update({
    where: { user_id: driverUserId },
    data: { balance: { increment: tipAmount } },
  });
  await tx.wallet_transaction.create({
    data: {
      user_id: driverUserId,
      amount: tipAmount,
      type: 'credit',
      source: RIDESHARE_TIP_SOURCE,
      description: ridesharTipDescription(tripId),
      external_ref: paymentIntentId,
    },
  });
  return { credited: true };
}
