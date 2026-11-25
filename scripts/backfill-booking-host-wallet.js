/**
 * Backfill booking_host_wallet credits for completed paid stays (e.g. host2@strug.com).
 * Usage: node scripts/backfill-booking-host-wallet.js [user_id|email]
 */
import prisma from '../utils/prisma-client.js';
import { reconcileBookingHostWallet, pendingBalanceForHost, ensureBookingHostWallet } from '../services/booking-host-payout.js';

async function resolveUserId(arg) {
  if (!arg) {
    const u = await prisma.user.findUnique({ where: { email: 'host2@strug.com' }, select: { user_id: true, email: true } });
    return u;
  }
  if (/^\d+$/.test(arg)) {
    const u = await prisma.user.findUnique({ where: { user_id: Number(arg) }, select: { user_id: true, email: true } });
    return u;
  }
  return prisma.user.findUnique({ where: { email: arg }, select: { user_id: true, email: true } });
}

const arg = process.argv[2];
const user = await resolveUserId(arg);
if (!user) {
  console.error('User not found');
  process.exit(1);
}

const { credited } = await reconcileBookingHostWallet(user.user_id);
const wallet = await ensureBookingHostWallet(prisma, user.user_id);
const pending = await pendingBalanceForHost(user.user_id);

console.log(JSON.stringify({
  email: user.email,
  user_id: user.user_id,
  newly_credited: credited,
  available_balance: Number(wallet.available_balance),
  total_earned: Number(wallet.total_earned),
  pending_balance: pending,
}, null, 2));

await prisma.$disconnect();
