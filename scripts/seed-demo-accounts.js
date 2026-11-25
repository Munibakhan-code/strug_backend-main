/**
 * Seed 5 host + 5 guest demo accounts for local booking/reservation testing.
 *
 * Usage: node scripts/seed-demo-accounts.js
 *
 * All accounts share password: Strug2026!
 */
import bcrypt from 'bcrypt';
import prisma from '../utils/prisma-client.js';
import { encryptSearch } from '../utils/crypto.js';

const PASSWORD = 'Strug2026!';

const HOSTS = [
  { email: 'host1@strug.com', name: 'Host One', handle: 'hostone' },
  { email: 'host2@strug.com', name: 'Host Two', handle: 'hosttwo' },
  { email: 'host3@strug.com', name: 'Host Three', handle: 'hostthree' },
  { email: 'host4@strug.com', name: 'Host Four', handle: 'hostfour' },
  { email: 'host5@strug.com', name: 'Host Five', handle: 'hostfive' },
];

const GUESTS = [
  { email: 'guest1@strug.com', name: 'Guest One', handle: 'guestone' },
  { email: 'guest2@strug.com', name: 'Guest Two', handle: 'guesttwo' },
  { email: 'guest3@strug.com', name: 'Guest Three', handle: 'guestthree' },
  { email: 'guest4@strug.com', name: 'Guest Four', handle: 'guestfour' },
  { email: 'guest5@strug.com', name: 'Guest Five', handle: 'guestfive' },
];

async function upsertAccount({ email, name, handle, isSeller }) {
  const encryptedEmail = encryptSearch(email);
  const hashed = await bcrypt.hash(PASSWORD, 10);
  const refCode = `${isSeller ? 'HOST' : 'GUEST'}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const user = await prisma.user.upsert({
    where: { email: encryptedEmail },
    update: {
      name,
      password: hashed,
      is_seller: isSeller,
      has_seen_welcome: true,
    },
    create: {
      name,
      email: encryptedEmail,
      password: hashed,
      ref_code: refCode,
      is_seller: isSeller,
      has_seen_welcome: true,
    },
  });

  await prisma.social_profile.upsert({
    where: { handle },
    update: { user_id: user.user_id, display_name: name, accepted_terms: true },
    create: {
      user_id: user.user_id,
      handle,
      display_name: name,
      accepted_terms: true,
    },
  });

  return user;
}

async function main() {
  console.log('Seeding demo accounts...\n');

  console.log('=== HOSTS (can own listings) ===');
  for (const host of HOSTS) {
    const user = await upsertAccount({ ...host, isSeller: true });
    console.log(`  ${host.email}  |  password: ${PASSWORD}  |  user_id: ${user.user_id}`);
  }

  console.log('\n=== GUESTS (can book reservations) ===');
  for (const guest of GUESTS) {
    const user = await upsertAccount({ ...guest, isSeller: false });
    console.log(`  ${guest.email}  |  password: ${PASSWORD}  |  user_id: ${user.user_id}`);
  }

  console.log('\nLogin: POST http://localhost:5000/auth/login');
  console.log('Body:  { "login": "<email>", "password": "Strug2026!" }');
  console.log('\nIf locked after failed attempts: node scripts/clear-login-lock.js <email>');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
