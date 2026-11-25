import prisma from './prisma-client.js';
import { buildRecruitShareDescription } from './recruit-visibility.js';

// Recruit revenue share (Invite & Earn).
//
// Pass ONLY users who **receive** work on the order (driver, seller, host, worker, artist, …).
// Never pass the paying customer alone — consumer spend must not credit a recruiter.
// Carve is taken from platform take only (buyer/provider payouts untouched), capped at
// `platformTake`. Graph: `shared_ref_code` (shared_to = recruit, ref_code = recruiter).
// Wallet rows use source:'recruit' (Phase S3). Legacy rows remain source:'referral'.
export const RECRUIT_WALLET_SOURCE = 'recruit';
/** Prisma filter: new Recruit credits + legacy Recruit credits still labeled referral. */
export const RECRUIT_WALLET_SOURCE_FILTER = { in: [RECRUIT_WALLET_SOURCE, 'referral'] };

const RECRUITER_SHARE_RATE = 0.02;
const CURRENCY = 'CAD';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Resolve the recruiter's user_id for a recruited user (or null). One recruiter per user is
// enforced at apply time; if duplicate rows ever exist, the earliest link wins.
async function recruiterUserIdFor(db, recruitedUserId) {
  if (!recruitedUserId) return null;
  const link = await db.shared_ref_code.findFirst({
    where: { shared_to: Number(recruitedUserId), ref_code: { not: null } },
    orderBy: { share_id: 'asc' },
    include: { user_shared_ref_code_ref_codeTouser: { select: { user_id: true } } },
  });
  return link?.user_shared_ref_code_ref_codeTouser?.user_id ?? null;
}

// Credit recruiters for receive-side participants on a settled order. Each receiver's
// recruiter (if any) earns `RECRUITER_SHARE_RATE` of `subtotal`, TOTAL carve capped at
// `platformTake`. Idempotent per (order, recruiter) via UNIQUE wallet_transaction.external_ref.
//
// Safe to call inside an existing prisma interactive transaction (pass `tx`) — in that case the
// caller's tx provides atomicity and we rely on a pre-check for idempotency (a P2002 inside a
// caller tx would poison it). When called standalone, each credit is wrapped in its own
// transaction so a race that slips past the pre-check rolls back cleanly.
//
// Never throws: a recruiter-share failure must not break settlement — errors are logged and
// swallowed (the recruiter simply isn't credited; the order still settles).
export async function creditRecruiterShares({
  participantUserIds = [],
  subtotal,
  platformTake,
  orderType,
  orderRef,
  tx = null,
} = {}) {
  try {
    const db = tx || prisma;
    const sub = Number(subtotal);
    let budget = round2(Number(platformTake));
    if (!(sub > 0) || !(budget > 0) || !orderType || orderRef == null) return;

    const participants = [...new Set(participantUserIds.filter((id) => id != null).map(Number))];
    const paid = new Set(); // recruiters already credited on this order (don't double-pay)

    for (const uid of participants) {
      if (budget <= 0) break;
      const recruiterId = await recruiterUserIdFor(db, uid);
      if (!recruiterId) continue;
      if (participants.includes(recruiterId)) continue; // no earning off your own transaction
      if (paid.has(recruiterId)) continue;

      const carve = round2(Math.min(sub * RECRUITER_SHARE_RATE, budget));
      if (!(carve > 0)) continue;

      const credited = await creditOne(db, recruiterId, carve, orderType, orderRef, uid, !!tx);
      if (credited) {
        paid.add(recruiterId);
        budget = round2(budget - carve);
      }
    }
  } catch (err) {
    console.error('[recruiter-share] credit failed', { orderType, orderRef, msg: err?.message });
  }
}

// Returns true if a credit row was written, false if it was already credited (idempotent no-op).
async function creditOne(db, recruiterUserId, amount, orderType, orderRef, recruitedUserId, insideCallerTx) {
  const externalRef = `recruiter:${orderType}:${orderRef}:${recruiterUserId}`;

  // Idempotency pre-check — safe inside a caller tx; the UNIQUE column is the backstop.
  const existing = await db.wallet_transaction.findFirst({
    where: { external_ref: externalRef },
    select: { transaction_id: true },
  });
  if (existing) return false;

  const ensureWallet = async (c) => {
    const w = await c.strug_wallet.findUnique({ where: { user_id: recruiterUserId } });
    if (!w) await c.strug_wallet.create({ data: { user_id: recruiterUserId, balance: 0, currency: CURRENCY } });
  };
  const write = async (c) => {
    await c.strug_wallet.update({ where: { user_id: recruiterUserId }, data: { balance: { increment: amount } } });
    await c.wallet_transaction.create({
      data: {
        user_id: recruiterUserId,
        amount,
        type: 'credit',
        source: RECRUIT_WALLET_SOURCE,
        description: buildRecruitShareDescription(orderType, recruitedUserId),
        external_ref: externalRef,
      },
    });
  };

  if (insideCallerTx) {
    // Already atomic under the caller's transaction.
    await ensureWallet(db);
    await write(db);
  } else {
    await ensureWallet(prisma);
    // Wrap increment + ledger together so a race that slips past the pre-check (P2002 on the
    // UNIQUE external_ref) rolls the increment back instead of double-crediting.
    try {
      await prisma.$transaction(async (t) => write(t));
    } catch (err) {
      if (err?.code === 'P2002') return false; // already credited (race)
      throw err;
    }
  }
  return true;
}

export const __private = { RECRUITER_SHARE_RATE, round2, recruiterUserIdFor, RECRUIT_WALLET_SOURCE };
