/**
 * One-time / maintenance: align every driver_profile row for a user
 * with that user's canonical (lowest driver_profile_id) is_online value.
 *
 * Usage: node scripts/sync-driver-profile-online-status.js
 */
import 'dotenv/config';
import prisma from '../utils/prisma-client.js';

async function main() {
  const profiles = await prisma.driver_profile.findMany({
    select: { driver_profile_id: true, user_id: true, is_online: true },
    orderBy: { driver_profile_id: 'asc' },
  });

  const canonicalByUser = new Map();
  for (const p of profiles) {
    if (!p.user_id || canonicalByUser.has(p.user_id)) continue;
    canonicalByUser.set(p.user_id, p.is_online === true);
  }

  let updated = 0;
  for (const [userId, isOnline] of canonicalByUser) {
    const result = await prisma.driver_profile.updateMany({
      where: { user_id: userId },
      data: { is_online: isOnline },
    });
    updated += result.count;
  }

  console.log(`Synced is_online for ${canonicalByUser.size} user(s), ${updated} profile row(s) touched.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
