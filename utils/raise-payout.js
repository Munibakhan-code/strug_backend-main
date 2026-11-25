import prisma from './prisma-client.js';
import { settleRecruiterShare } from './recruiter-settlement.js';

// Raise creator-payout rail. Phase 1 used immediate wallet credits; the hardened
// flow below adds a reserve window + finance review before funds are released.
export const RAISE_PLATFORM_FEE_PCT = 0.05;
export const RAISE_RESERVE_WINDOW_DAYS = 7;
const CURRENCY = 'CAD';
const PAYOUT_COMMITTED_STATUSES = ['pending_review', 'approved', 'paid', 'completed'];
const PAYOUT_SETTLED_STATUSES = ['paid', 'completed'];

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

async function ensureWallet(userId) {
  const existing = await prisma.strug_wallet.findUnique({ where: { user_id: Number(userId) } });
  if (existing) return existing;
  return prisma.strug_wallet.create({ data: { user_id: Number(userId), balance: 0, currency: CURRENCY } });
}

async function projectLedger(projectId, db = prisma) {
  const project = await db.projects.findUnique({ where: { project_id: Number(projectId) } });
  if (!project) return null;
  const cutoff = new Date(Date.now() - (RAISE_RESERVE_WINDOW_DAYS * 86400000));
  const [
    paid,
    refunded,
    committed,
    settled,
    pending,
    reservePool,
  ] = await Promise.all([
    db.donations.aggregate({
      where: { project_id: Number(projectId), payment_status: 'paid' },
      _sum: { amount: true },
    }),
    db.donations.aggregate({
      where: { project_id: Number(projectId), refund_status: 'refunded' },
      _sum: { refund_amount: true },
    }),
    db.campaign_payout.aggregate({
      where: { project_id: Number(projectId), status: { in: PAYOUT_COMMITTED_STATUSES } },
      _sum: { gross_amount: true },
    }),
    db.campaign_payout.aggregate({
      where: { project_id: Number(projectId), status: { in: PAYOUT_SETTLED_STATUSES } },
      _sum: { gross_amount: true },
    }),
    db.campaign_payout.aggregate({
      where: { project_id: Number(projectId), status: { in: ['pending_review', 'approved'] } },
      _sum: { gross_amount: true },
    }),
    db.donations.aggregate({
      where: {
        project_id: Number(projectId),
        payment_status: 'paid',
        paid_at: { gte: cutoff },
        refund_status: { not: 'refunded' },
      },
      _sum: { amount: true },
    }),
  ]);
  const raised = round2(Number(paid._sum.amount || 0) - Number(refunded._sum.refund_amount || 0));
  const withdrawn = round2(Number(settled._sum.gross_amount || 0));
  const pendingGross = round2(Number(pending._sum.gross_amount || 0));
  const committedGross = round2(Number(committed._sum.gross_amount || 0));
  const reserve_amount = round2(Number(reservePool._sum.amount || 0));
  const available = Math.max(0, round2(raised - committedGross - reserve_amount));
  return { project, raised, withdrawn, committedGross, pendingGross, reserve_amount, available };
}

export async function campaignPayoutSummary(projectId) {
  const ledger = await projectLedger(projectId);
  if (!ledger) return null;
  const { project, raised, withdrawn, pendingGross, reserve_amount, available } = ledger;
  const fee_estimate = round2(available * RAISE_PLATFORM_FEE_PCT);
  return {
    project,
    raised,
    withdrawn,
    pending_review: pendingGross,
    reserved: reserve_amount,
    available,
    fee_pct: RAISE_PLATFORM_FEE_PCT,
    fee_estimate,
    net_estimate: round2(available - fee_estimate),
    currency: CURRENCY,
  };
}

// Queue a withdrawal request for review. Finance later approves/marks it paid,
// which is when the creator's wallet is credited.
export async function withdrawCampaign(projectId, ownerUserId) {
  const owner = await prisma.user.findUnique({
    where: { user_id: Number(ownerUserId) },
    select: { is_verified: true },
  });
  if (!owner?.is_verified) {
    return { ok: false, code: 403, message: 'Please verify your account before withdrawing campaign funds.' };
  }
  return prisma.$transaction(async (tx) => {
    // Serialise withdrawals for this campaign. Use the single-arg bigint lock (Prisma binds
    // a JS number as int8, so the two-arg int form errors), and wrap it so the only selected
    // column is an int — pg_advisory_xact_lock returns void, which $queryRaw can't
    // deserialize directly. Namespace 7327000_1xxxx keeps the key collision-free.
    const lockKey = 732700010000n + BigInt(Number(projectId));
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${lockKey})) AS _lock`;

    const ledger = await projectLedger(projectId, tx);
    if (!ledger) return { ok: false, code: 404, message: 'Campaign not found' };
    const { project, available } = ledger;
    const gross = round2(available);
    if (!(gross > 0)) return { ok: false, code: 400, message: 'No funds available to withdraw' };

    const fee = round2(gross * RAISE_PLATFORM_FEE_PCT);
    const net = round2(gross - fee);

    const payout = await tx.campaign_payout.create({
      data: {
        project_id: Number(projectId),
        owner_user_id: Number(ownerUserId),
        gross_amount: gross,
        fee_amount: fee,
        net_amount: net,
        status: 'pending_review',
      },
    });
    return { ok: true, payout, gross, fee, net, queued: true };
  });
}

export async function approveCampaignPayout(payoutId) {
  return prisma.$transaction(async (tx) => {
    const payout = await tx.campaign_payout.findUnique({ where: { payout_id: Number(payoutId) } });
    if (!payout) return { ok: false, code: 404, message: 'Payout not found' };
    if (payout.status !== 'pending_review') return { ok: false, code: 409, message: 'Payout is not pending review' };
    const updated = await tx.campaign_payout.update({
      where: { payout_id: payout.payout_id },
      data: { status: 'approved', reviewed_at: new Date(), approved_at: new Date() },
    });
    return { ok: true, payout: updated };
  });
}

export async function rejectCampaignPayout(payoutId, reason = null) {
  return prisma.$transaction(async (tx) => {
    const payout = await tx.campaign_payout.findUnique({ where: { payout_id: Number(payoutId) } });
    if (!payout) return { ok: false, code: 404, message: 'Payout not found' };
    if (!['pending_review', 'approved'].includes(String(payout.status || '').toLowerCase())) {
      return { ok: false, code: 409, message: 'Payout cannot be rejected in its current state' };
    }
    const updated = await tx.campaign_payout.update({
      where: { payout_id: payout.payout_id },
      data: {
        status: 'rejected',
        reviewed_at: new Date(),
        rejected_at: new Date(),
        rejection_reason: reason || null,
      },
    });
    return { ok: true, payout: updated };
  });
}

export async function markCampaignPayoutPaid(payoutId, reference = null) {
  await ensureWalletForPayout(payoutId);
  return prisma.$transaction(async (tx) => {
    const payout = await tx.campaign_payout.findUnique({
      where: { payout_id: Number(payoutId) },
      include: { projects: true },
    });
    if (!payout) return { ok: false, code: 404, message: 'Payout not found' };
    if (!['approved', 'pending_review'].includes(String(payout.status || '').toLowerCase())) {
      return { ok: false, code: 409, message: 'Payout must be approved before it can be paid' };
    }
    const external_ref = reference || `raise_campaign_payout:${payout.payout_id}`;
    const existingCredit = await tx.wallet_transaction.findUnique({ where: { external_ref } }).catch(() => null);
    if (!existingCredit) {
      await tx.strug_wallet.update({
        where: { user_id: Number(payout.owner_user_id) },
        data: { balance: { increment: payout.net_amount } },
      });
      await tx.wallet_transaction.create({
        data: {
          user_id: Number(payout.owner_user_id),
          amount: payout.net_amount,
          type: 'credit',
          source: 'raise_payout',
          status: 'completed',
          description: `Campaign payout for "${payout.projects?.title || payout.projects?.project_name || `#${payout.project_id}`}" (gross ${payout.gross_amount}, fee ${payout.fee_amount})`,
          external_ref,
        },
      });
    }
    const updated = await tx.campaign_payout.update({
      where: { payout_id: payout.payout_id },
      data: {
        status: 'paid',
        reviewed_at: payout.reviewed_at || new Date(),
        approved_at: payout.approved_at || new Date(),
        paid_at: new Date(),
        external_ref,
      },
    });

    // Recruiter Phase 2: platform fee is realized here — carve from fee_amount for owner’s recruiter.
    if (!existingCredit && Number(payout.fee_amount) > 0) {
      await settleRecruiterShare({
        orderType: 'raise_payout',
        orderRef: payout.payout_id,
        participantUserIds: [payout.owner_user_id],
        subtotal: payout.gross_amount,
        platformTake: payout.fee_amount,
        tx,
      });
    }

    return { ok: true, payout: updated };
  });
}

async function ensureWalletForPayout(payoutId) {
  const payout = await prisma.campaign_payout.findUnique({ where: { payout_id: Number(payoutId) } });
  if (payout?.owner_user_id) await ensureWallet(payout.owner_user_id);
}
