/**
 * Guest test account for hotel/booking flows (cannot be the listing owner).
 *
 * Usage: node scripts/seed-booking-user.js
 *
 * Login on frontend or:
 *   POST http://localhost:5000/auth/login
 *   { "login": "guest@strug.ca", "password": "Strug2026!" }
 */
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import prisma from '../utils/prisma-client.js';

const EMAIL = 'guest@strug.ca';
const PASSWORD = 'Strug2026!';
const NAME = 'Guest Booker';
const HANDLE = 'guestbooker';

function encryptEmail(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return enc;
}

async function main() {
  const encryptedEmail = encryptEmail(EMAIL);
  const hashed = await bcrypt.hash(PASSWORD, 10);
  const refCode = 'GUEST-' + Math.random().toString(36).slice(2, 8).toUpperCase();

  await prisma.user.deleteMany({ where: { email: EMAIL } });

  const user = await prisma.user.upsert({
    where: { email: encryptedEmail },
    update: {
      name: NAME,
      password: hashed,
      has_seen_welcome: true,
    },
    create: {
      name: NAME,
      email: encryptedEmail,
      password: hashed,
      ref_code: refCode,
      has_seen_welcome: true,
    },
  });

  await prisma.social_profile.upsert({
    where: { handle: HANDLE },
    update: { user_id: user.user_id, display_name: NAME, accepted_terms: true },
    create: {
      user_id: user.user_id,
      handle: HANDLE,
      display_name: NAME,
      accepted_terms: true,
    },
  });

  console.log('Guest booking user ready');
  console.log(`  Email:    ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);
  console.log(`  User ID:  ${user.user_id}`);
  console.log('');
  console.log('Use this account on the frontend to book hotels.');
  console.log('Hotels are owned by a different user — booking will work.');
  console.log('');
  console.log('Browse:  GET  http://localhost:5000/booking/listings?vertical=hotel');
  console.log('Quote:   POST http://localhost:5000/booking/quote');
  console.log('Book:    POST http://localhost:5000/booking/bookings  (requires login token)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
