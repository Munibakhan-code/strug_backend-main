// Artist-booking payment settlement — shared by the canonical Stripe webhook
// (routes/booking-engine-routes.js) and the GET self-heal (routes/book-artist-routes.js).
//
// Book-an-artist PaymentIntents are created in book-artist-routes.js /pay with the
// booking's unique stripe_payment_intent_id and metadata.booking_id. They are delivered
// to the SINGLE canonical webhook /booking/webhook/stripe (Stripe fans every
// payment_intent.* event to every configured endpoint, and the dashboard only registers
// that one), so settlement must live there — not on a second /artist/stripe endpoint,
// whose per-endpoint signing secret would never match and which would never fire.
import prisma from './prisma-client.js';
import { PLATFORM_FEE_PERCENTAGE, platformTakeFromPct } from './recruiter-settlement.js';
import { creditRecruiterShares } from './recruiter-share.js';
import { settleReferralThenRecruit } from './referral-settlement.js';

function feePctFromListing(listing) {
  const raw = listing?.service_fee_pct;
  if (raw == null || raw === '') return PLATFORM_FEE_PERCENTAGE;
  const n = Number(raw);
  // Listing stores percent as 0–100 in some rows and 0–1 in others — normalize.
  if (!Number.isFinite(n) || n <= 0) return PLATFORM_FEE_PERCENTAGE;
  return n > 1 ? n / 100 : n;
}

// Transition a PENDING artist booking to PAID and credit the artist's pending wallet
// balance EXACTLY ONCE. The updateMany PENDING->PAID guard is atomic, so it is safe to
// call from both the webhook and the self-heal (and on Stripe re-delivery): only the
// first caller flips the row and credits; everyone else no-ops. Returns true iff it
// performed the credit.
export async function creditArtistBookingOnPaid(booking) {
  if (!booking || booking.payment_status !== 'PENDING') return false;
  const credited = await prisma.$transaction(async (tx) => {
    const flipped = await tx.artistBooking.updateMany({
      where: { id: booking.id, payment_status: 'PENDING' },
      data: { payment_status: 'PAID' },
    });
    if (flipped.count !== 1) return false; // already settled by a concurrent caller

    const wallet = await tx.artistWallet.upsert({
      where: { artist_profile_id: booking.artist_profile_id },
      update: {},
      create: {
        artist_profile_id: booking.artist_profile_id,
        pending_balance: 0,
        available_balance: 0,
        total_earned: 0,
        total_withdrawn: 0,
      },
    });
    await tx.artistWallet.update({
      where: { id: wallet.id },
      data: { pending_balance: { increment: booking.price } },
    });
    await tx.artistWalletTransaction.create({
      data: {
        wallet_id: wallet.id,
        booking_id: booking.id,
        buyer_profile_id: booking.buyer_profile_id,
        artist_profile_id: booking.artist_profile_id,
        amount: booking.price,
        type: 'BOOKING',
        status: 'PENDING',
        available_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    return true;
  });

  if (!credited) return false;

  // Resolve ids for Referral (buyer friend code) + Recruit (artist receive-side).
  let artistUserId = booking.artist_profile?.user_id ?? null;
  let buyerUserId = booking.buyer_profile?.user_id ?? null;
  let referralCode = booking.referral_code ?? null;
  let feePct = feePctFromListing(booking.artist_listing);
  if (artistUserId == null || buyerUserId == null || booking.artist_listing == null || referralCode == null) {
    const full = await prisma.artistBooking.findUnique({
      where: { id: booking.id },
      include: {
        artist_profile: { select: { user_id: true } },
        buyer_profile: { select: { user_id: true } },
        artist_listing: { select: { service_fee_pct: true } },
      },
    });
    artistUserId = full?.artist_profile?.user_id ?? artistUserId;
    buyerUserId = full?.buyer_profile?.user_id ?? buyerUserId;
    referralCode = full?.referral_code ?? referralCode;
    feePct = feePctFromListing(full?.artist_listing);
  }

  await settleReferralThenRecruit({
    referralCode,
    buyerUserId,
    recruitParticipantUserIds: [artistUserId],
    subtotal: booking.price,
    platformTake: platformTakeFromPct(booking.price, feePct),
    orderType: 'artist',
    orderRef: booking.id,
    creditRecruiterShares,
  });
  return true;
}

// Mark a PENDING artist booking FAILED (card declined). Guarded so a late-arriving
// payment_failed can never clobber a booking that already succeeded.
export async function failArtistBookingIfPending(bookingId) {
  await prisma.artistBooking.updateMany({
    where: { id: bookingId, payment_status: 'PENDING' },
    data: { payment_status: 'FAILED' },
  });
}
