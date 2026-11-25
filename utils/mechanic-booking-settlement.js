import prisma from './prisma-client.js';
import { PLATFORM_FEE_PERCENTAGE, platformTakeFromPct } from './recruiter-settlement.js';

const REFUND_SOURCE = 'mechanic_booking_refund';
const PAYOUT_SOURCE = 'mechanic_booking_payout';

function refundDescription(bookingId) {
  return `Refund — mechanic booking #${bookingId}`;
}

function payoutDescription(bookingId) {
  return `Mechanic payout — booking #${bookingId}`;
}

async function creditWallet(tx, userId, amount, currency, source, description) {
  const wallet = await tx.strug_wallet.findUnique({ where: { user_id: userId } });
  if (!wallet) {
    await tx.strug_wallet.create({ data: { user_id: userId, balance: amount, currency: currency || 'CAD' } });
  } else {
    await tx.strug_wallet.update({ where: { user_id: userId }, data: { balance: { increment: amount } } });
  }
  await tx.wallet_transaction.create({
    data: { user_id: userId, amount, type: 'credit', source, description },
  });
}

// Declined/cancelled paid mechanic booking -> refund the guest's Strug wallet (not the
// original card). Idempotent: the payment_status='paid' guard on the row flip only lets
// one caller through.
export async function refundMechanicBookingToWallet(booking) {
  if (!booking || booking.vertical !== 'mechanic') return { refunded: false };
  if (booking.payment_status !== 'paid') return { refunded: false };
  const amount = Math.round(Number(booking.total) * 100) / 100;
  if (!(amount > 0)) return { refunded: false };

  const refunded = await prisma.$transaction(async (tx) => {
    const flipped = await tx.booking.updateMany({
      where: { booking_id: booking.booking_id, payment_status: 'paid' },
      data: { payment_status: 'refunded', refund_status: 'issued', refund_amount: amount },
    });
    if (flipped.count !== 1) return false;
    await creditWallet(tx, booking.guest_id, amount, booking.currency, REFUND_SOURCE, refundDescription(booking.booking_id));
    return true;
  });

  return { refunded, amount };
}

// Completed, paid mechanic booking -> credit the mechanic's Strug wallet with
// total - Strug's cut. Idempotent via the wallet_transaction dedup lookup.
export async function payoutMechanicOnComplete(booking) {
  if (!booking || booking.vertical !== 'mechanic') return { paid: false };
  if (booking.payment_status !== 'paid') return { paid: false };

  const description = payoutDescription(booking.booking_id);
  const existing = await prisma.wallet_transaction.findFirst({
    where: { user_id: booking.host_id, type: 'credit', source: PAYOUT_SOURCE, description },
  });
  if (existing) return { paid: false, already_paid: true };

  const total = Number(booking.total) || 0;
  const recordedFee = Number(booking.service_fee) || 0;
  // Mirrors utils/artist-booking-settlement.js's feePctFromListing fallback: most mechanic
  // listings never set service_fee_pct, so fall back to the platform-wide default rather
  // than silently taking a 0% cut.
  const strugCut = recordedFee > 0 ? recordedFee : platformTakeFromPct(total, PLATFORM_FEE_PERCENTAGE);
  const amount = Math.max(0, Math.round((total - strugCut) * 100) / 100);
  if (!(amount > 0)) return { paid: false };

  await prisma.$transaction(async (tx) => {
    const dup = await tx.wallet_transaction.findFirst({
      where: { user_id: booking.host_id, type: 'credit', source: PAYOUT_SOURCE, description },
    });
    if (dup) return;
    await creditWallet(tx, booking.host_id, amount, booking.currency, PAYOUT_SOURCE, description);
  });

  return { paid: true, amount };
}
