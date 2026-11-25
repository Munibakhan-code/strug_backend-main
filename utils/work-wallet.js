import prisma from './prisma-client.js';

// On-Demand Work money rail — mirrors the rideshare wallet pattern (atomic conditional
// debit + credit/refund, each with a wallet_transaction ledger row). Wallet-based for now;
// card/Stripe-Connect capture is a follow-up.
const CURRENCY = 'CAD';

async function ensureWallet(userId, client = prisma) {
  const existing = await client.strug_wallet.findUnique({ where: { user_id: Number(userId) } });
  if (existing) return existing;
  return client.strug_wallet.create({ data: { user_id: Number(userId), balance: 0, currency: CURRENCY } });
}

/**
 * Conditional debit against a Prisma client or interactive-transaction client.
 * Pass `client` when the debit must commit/rollback with sibling writes (e.g. talent boost).
 * Returns { ok, balance }.
 */
export async function debitWorkWallet(userId, amount, source, description, client = null) {
  if (!userId || !(amount > 0)) return { ok: false, balance: 0 };
  const uid = Number(userId);

  const runDebit = async (tx) => {
    await ensureWallet(uid, tx);
    const dec = await tx.strug_wallet.updateMany({
      where: { user_id: uid, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (dec.count === 0) return false;
    await tx.wallet_transaction.create({
      data: { user_id: uid, amount, type: 'debit', source, description },
    });
    return true;
  };

  if (client) {
    const ok = await runDebit(client);
    const fresh = await client.strug_wallet.findUnique({ where: { user_id: uid } });
    return { ok, balance: fresh ? parseFloat(fresh.balance) : 0 };
  }

  await ensureWallet(uid);
  const ok = await prisma.$transaction(async (tx) => runDebit(tx));
  const fresh = await prisma.strug_wallet.findUnique({ where: { user_id: uid } });
  return { ok, balance: fresh ? parseFloat(fresh.balance) : 0 };
}

// Credit the wallet + write a ledger row, atomically. When `externalRef` is supplied (e.g. a
// Stripe PaymentIntent id), it is stored on the ledger row under a UNIQUE column — so a second
// concurrent credit for the same event hits a unique-constraint violation and the whole
// transaction (including the increment) rolls back. Callers passing an externalRef should treat
// a thrown P2002 as "already credited" rather than an error.
export async function creditWorkWallet(userId, amount, source, description, externalRef = null) {
  if (!userId || !(amount > 0)) return;
  await ensureWallet(userId);
  await prisma.$transaction([
    prisma.strug_wallet.update({ where: { user_id: Number(userId) }, data: { balance: { increment: amount } } }),
    prisma.wallet_transaction.create({ data: { user_id: Number(userId), amount, type: 'credit', source, description, external_ref: externalRef } }),
  ]);
}

// Resolve a worker_profile_id → the worker's user_id (for crediting payouts/comp).
export async function workerUserId(workerProfileId) {
  if (!workerProfileId) return null;
  const p = await prisma.worker_profile.findUnique({ where: { worker_profile_id: Number(workerProfileId) }, select: { user_id: true } });
  return p?.user_id ?? null;
}
