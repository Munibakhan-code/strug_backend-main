import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../utils/prisma-client.js';
import { refundMechanicBookingToWallet, payoutMechanicOnComplete } from '../../utils/mechanic-booking-settlement.js';
import { PLATFORM_FEE_PERCENTAGE, platformTakeFromPct } from '../../utils/recruiter-settlement.js';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    $transaction: vi.fn(),
    booking: { updateMany: vi.fn() },
    strug_wallet: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    wallet_transaction: { create: vi.fn(), findFirst: vi.fn() },
  },
}));

const mechanicBooking = (overrides = {}) => ({
  booking_id: 42,
  vertical: 'mechanic',
  guest_id: 11,
  host_id: 22,
  total: 100,
  service_fee: 15,
  currency: 'CAD',
  payment_status: 'paid',
  ...overrides,
});

describe('refundMechanicBookingToWallet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
  });

  it('credits the guest wallet and flips payment_status once', async () => {
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    prisma.strug_wallet.findUnique.mockResolvedValue({ user_id: 11, balance: 0 });
    prisma.strug_wallet.update.mockResolvedValue({});
    prisma.wallet_transaction.create.mockResolvedValue({});

    const result = await refundMechanicBookingToWallet(mechanicBooking());

    expect(result).toEqual({ refunded: true, amount: 100 });
    expect(prisma.strug_wallet.update).toHaveBeenCalledWith({
      where: { user_id: 11 },
      data: { balance: { increment: 100 } },
    });
    expect(prisma.wallet_transaction.create).toHaveBeenCalledWith({
      data: { user_id: 11, amount: 100, type: 'credit', source: 'mechanic_booking_refund', description: 'Refund — mechanic booking #42' },
    });
  });

  it('no-ops for a non-mechanic booking', async () => {
    const result = await refundMechanicBookingToWallet(mechanicBooking({ vertical: 'hotel' }));
    expect(result).toEqual({ refunded: false });
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it('no-ops when the booking was never paid', async () => {
    const result = await refundMechanicBookingToWallet(mechanicBooking({ payment_status: 'unpaid' }));
    expect(result).toEqual({ refunded: false });
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it('does not double-refund when the row was already flipped concurrently', async () => {
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });
    const result = await refundMechanicBookingToWallet(mechanicBooking());
    expect(result).toEqual({ refunded: false, amount: 100 });
    expect(prisma.wallet_transaction.create).not.toHaveBeenCalled();
  });
});

describe('payoutMechanicOnComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
  });

  it('credits the mechanic wallet with total minus service_fee', async () => {
    prisma.wallet_transaction.findFirst.mockResolvedValue(null);
    prisma.strug_wallet.findUnique.mockResolvedValue(null);
    prisma.strug_wallet.create.mockResolvedValue({});
    prisma.wallet_transaction.create.mockResolvedValue({});

    const result = await payoutMechanicOnComplete(mechanicBooking());

    expect(result).toEqual({ paid: true, amount: 85 });
    expect(prisma.strug_wallet.create).toHaveBeenCalledWith({
      data: { user_id: 22, balance: 85, currency: 'CAD' },
    });
    expect(prisma.wallet_transaction.create).toHaveBeenCalledWith({
      data: { user_id: 22, amount: 85, type: 'credit', source: 'mechanic_booking_payout', description: 'Mechanic payout — booking #42' },
    });
  });

  it('falls back to the platform default fee when the listing never set service_fee', async () => {
    prisma.wallet_transaction.findFirst.mockResolvedValue(null);
    prisma.strug_wallet.findUnique.mockResolvedValue(null);
    prisma.strug_wallet.create.mockResolvedValue({});
    prisma.wallet_transaction.create.mockResolvedValue({});

    const result = await payoutMechanicOnComplete(mechanicBooking({ service_fee: 0 }));

    const expectedCut = platformTakeFromPct(100, PLATFORM_FEE_PERCENTAGE);
    const expectedAmount = Math.round((100 - expectedCut) * 100) / 100;
    expect(result).toEqual({ paid: true, amount: expectedAmount });
    expect(prisma.strug_wallet.create).toHaveBeenCalledWith({
      data: { user_id: 22, balance: expectedAmount, currency: 'CAD' },
    });
  });

  it('is idempotent: skips when already paid out', async () => {
    prisma.wallet_transaction.findFirst.mockResolvedValue({ transaction_id: 1 });

    const result = await payoutMechanicOnComplete(mechanicBooking());

    expect(result).toEqual({ paid: false, already_paid: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('no-ops for a non-mechanic booking', async () => {
    const result = await payoutMechanicOnComplete(mechanicBooking({ vertical: 'hotel' }));
    expect(result).toEqual({ paid: false });
  });

  it('no-ops when unpaid', async () => {
    const result = await payoutMechanicOnComplete(mechanicBooking({ payment_status: 'unpaid' }));
    expect(result).toEqual({ paid: false });
  });
});
