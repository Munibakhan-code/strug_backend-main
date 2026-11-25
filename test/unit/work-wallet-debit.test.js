/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const create = vi.fn();
const updateMany = vi.fn();
const walletTxCreate = vi.fn();
const transaction = vi.fn();

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    strug_wallet: {
      findUnique: (...args) => findUnique(...args),
      create: (...args) => create(...args),
      updateMany: (...args) => updateMany(...args),
    },
    wallet_transaction: {
      create: (...args) => walletTxCreate(...args),
    },
    $transaction: (...args) => transaction(...args),
  },
}));

const { debitWorkWallet } = await import('../../utils/work-wallet.js');

describe('debitWorkWallet', () => {
  beforeEach(() => {
    findUnique.mockReset();
    create.mockReset();
    updateMany.mockReset();
    walletTxCreate.mockReset();
    transaction.mockReset();
  });

  it('rejects missing user or non-positive amount', async () => {
    expect(await debitWorkWallet(null, 10, 'x', 'y')).toEqual({ ok: false, balance: 0 });
    expect(await debitWorkWallet(1, 0, 'x', 'y')).toEqual({ ok: false, balance: 0 });
    expect(await debitWorkWallet(1, -5, 'x', 'y')).toEqual({ ok: false, balance: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('uses an external tx client so sibling writes can share one transaction', async () => {
    const tx = {
      strug_wallet: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ user_id: 7, balance: 50 })
          .mockResolvedValueOnce({ user_id: 7, balance: 40.01 }),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      wallet_transaction: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    const res = await debitWorkWallet(7, 9.99, 'jobs_talent_boost', 'boost', tx);
    expect(res).toEqual({ ok: true, balance: 40.01 });
    expect(tx.strug_wallet.updateMany).toHaveBeenCalledWith({
      where: { user_id: 7, balance: { gte: 9.99 } },
      data: { balance: { decrement: 9.99 } },
    });
    expect(tx.wallet_transaction.create).toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('returns ok false inside external tx when balance is too low (no ledger write)', async () => {
    const tx = {
      strug_wallet: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ user_id: 7, balance: 1 })
          .mockResolvedValueOnce({ user_id: 7, balance: 1 }),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      wallet_transaction: {
        create: vi.fn(),
      },
    };

    const res = await debitWorkWallet(7, 9.99, 'jobs_talent_boost', 'boost', tx);
    expect(res).toEqual({ ok: false, balance: 1 });
    expect(tx.wallet_transaction.create).not.toHaveBeenCalled();
  });
});
