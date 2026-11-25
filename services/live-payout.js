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

// ── Live-streamer payout disbursement ───────────────────────────────────────
// Streamers accrue earnings in live_streamer_wallet (subscription/ad-revenue
// share). A payout-request decrements the wallet and queues a PENDING row
// (live-wallet-routes). This module turns that queue into actual money out:
//
//   • Stripe Connect (Express) — if the streamer connected an account we can
//     transfer the funds straight to it; the request is marked PAID automatically.
//   • Manual — otherwise an admin sends money off-platform (e-transfer/bank) and
//     records a reference; the request is marked PAID by hand.
//
// Money safety: the wallet was ALREADY debited at request time, so a PENDING row
// is held funds. Approving never debits again; rejecting refunds the wallet.

// ── Stripe Connect onboarding (streamer-facing) ─────────────────────────────

// Find-or-create the streamer's Connect (Express) account and return an
// onboarding AccountLink the streamer redirects to. Idempotent: a streamer that
// already has stripe_account_id just gets a fresh link.
export async function createOnboardingLink(streamer, { refreshUrl, returnUrl }) {
  if (!getStripe()) throw new Error('Stripe not configured');

  let accountId = streamer.stripe_account_id;
  if (!accountId) {
    const user = await prisma.user.findUnique({
      where: { user_id: streamer.user_id },
      select: { email: true },
    });
    const account = await createExpressAccount({
      email: user?.email || undefined,
      metadata: { streamer_id: String(streamer.streamer_id), handle: streamer.handle },
    });
    accountId = account.id;
    await prisma.live_streamer_profile.update({
      where: { streamer_id: streamer.streamer_id },
      data: { stripe_account_id: accountId },
    });
  }

  const link = await createAccountOnboardingLink({ accountId, refreshUrl, returnUrl });
  return { account_id: accountId, url: link.url };
}

// Whether a connected account can actually receive transfers yet.
export async function connectStatus(streamer) {
  return connectStatusByAccountId(streamer?.stripe_account_id);
}

// ── Admin disbursement actions (all guard on the current status) ─────────────

// Approve a PENDING payout. If the streamer has a Connect account with payouts
// enabled, transfer the funds and mark PAID; otherwise mark APPROVED (cleared
// for manual disbursement). The Stripe transfer uses an idempotency key derived
// from the payout id so a retried/double-clicked approval can never pay twice.
export async function approvePayout(payout, { note } = {}) {
  if (payout.status !== 'PENDING') {
    const err = new Error('Payout_Not_Pending');
    err.statusCode = 409;
    throw err;
  }

  const streamer = payout.streamer;
  const canTransfer = getStripe() && streamer?.stripe_account_id;

  if (canTransfer) {
    // Confirm the connected account can receive funds before transferring.
    const status = await connectStatus(streamer);
    if (!status.payouts_enabled) {
      const err = new Error('Connect_Payouts_Not_Enabled');
      err.statusCode = 409;
      throw err;
    }
    const transfer = await transferToConnect({
      amount: payout.amount,
      destination: streamer.stripe_account_id,
      metadata: { payout_id: String(payout.payout_id), streamer_id: String(streamer.streamer_id) },
      idempotencyKey: `live_payout_${payout.payout_id}`,
    });
    return prisma.live_payout_request.update({
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

  // No Connect account — clear it for manual disbursement.
  return prisma.live_payout_request.update({
    where: { payout_id: payout.payout_id },
    data: { status: 'APPROVED', admin_note: note ?? payout.admin_note, resolved_at: new Date() },
  });
}

// Mark a PENDING/APPROVED payout PAID after a manual (off-platform) disbursement.
// `reference` (e-transfer id, bank ref) is recorded in admin_note.
export async function markPaid(payout, { reference } = {}) {
  if (payout.status !== 'PENDING' && payout.status !== 'APPROVED') {
    const err = new Error('Payout_Not_Payable');
    err.statusCode = 409;
    throw err;
  }
  const note = reference ? `Manual payout: ${reference}` : payout.admin_note;
  return prisma.live_payout_request.update({
    where: { payout_id: payout.payout_id },
    data: { status: 'PAID', admin_note: note, paid_at: new Date(), resolved_at: new Date() },
  });
}

// Reject a PENDING/APPROVED payout and refund the held funds to the wallet.
// (A PAID payout cannot be rejected — the money already left.)
export async function rejectPayout(payout, { note } = {}) {
  if (payout.status !== 'PENDING' && payout.status !== 'APPROVED') {
    const err = new Error('Payout_Not_Rejectable');
    err.statusCode = 409;
    throw err;
  }
  return prisma.$transaction(async (tx) => {
    // Refund the amount that was debited when the request was created.
    await tx.live_streamer_wallet.update({
      where: { streamer_id: payout.streamer_id },
      data: { balance: { increment: payout.amount } },
    });
    await tx.wallet_transaction.create({
      data: {
        user_id: payout.streamer.user_id,
        amount: payout.amount,
        type: 'credit',
        source: 'live_payout_refund',
        description: `Refund of rejected payout #${payout.payout_id}`,
      },
    });
    return tx.live_payout_request.update({
      where: { payout_id: payout.payout_id },
      data: { status: 'REJECTED', admin_note: note ?? payout.admin_note, resolved_at: new Date() },
    });
  });
}
