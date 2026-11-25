/**
 * Seed script: creates one pre-approved test account per seller dashboard.
 *
 * Usage:
 *   cd strug_backend-main
 *   TEST_ACCOUNT_PASSWORD="YourPassword123!" node scripts/seed-seller-accounts.js
 *
 * If TEST_ACCOUNT_PASSWORD is not set it defaults to Strug2026!
 * Requires the same .env as the backend (DATABASE_URL, ENCRYPTION_KEY).
 */

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const PASSWORD = process.env.TEST_ACCOUNT_PASSWORD || 'Strug2026!';

function encryptEmail(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return enc;
}

// ── Flag-based seller accounts ───────────────────────────────────────────────

const FLAG_ACCOUNTS = [
  { email: 'test-drive@strug.ca',         name: 'Test Driver',           handle: 'test-drive',         flag: 'is_driver' },
  { email: 'test-courier@strug.ca',        name: 'Test Courier',          handle: 'test-courier',        flag: 'is_courier' },
  { email: 'test-ecommerce@strug.ca',      name: 'Test Seller',           handle: 'test-ecommerce',      flag: 'is_seller' },
  { email: 'test-flowers@strug.ca',        name: 'Test Floral Seller',    handle: 'test-flowers',        flag: 'is_floral_seller' },
  { email: 'test-usedproducts@strug.ca',   name: 'Test Used Seller',      handle: 'test-usedproducts',   flag: 'is_used_seller' },
  { email: 'test-discounts@strug.ca',      name: 'Test Discount Seller',  handle: 'test-discounts',      flag: 'is_discount_seller' },
  { email: 'test-authors@strug.ca',        name: 'Test Author',           handle: 'test-authors',        flag: 'is_author' },
  { email: 'test-digital@strug.ca',        name: 'Test Digital Seller',   handle: 'test-digital',        flag: 'is_digital_seller' },
  { email: 'test-host@strug.ca',           name: 'Test Host',             handle: 'test-host',           flag: 'is_host' },
  { email: 'test-vehicle@strug.ca',        name: 'Test Vehicle Provider', handle: 'test-vehicle',        flag: 'is_vehicle_provider' },
  { email: 'test-events@strug.ca',         name: 'Test Event Host',       handle: 'test-events',         flag: 'is_event_host' },
  { email: 'test-hotel@strug.ca',          name: 'Test Hotel Owner',      handle: 'test-hotel',          flag: 'is_hotel_owner' },
  { email: 'test-venue@strug.ca',          name: 'Test Venue Owner',      handle: 'test-venue',          flag: 'is_venue_owner' },
  { email: 'test-equipment@strug.ca',      name: 'Test Equipment Owner',  handle: 'test-equipment',      flag: 'is_equipment_owner' },
  { email: 'test-realestate@strug.ca',     name: 'Test Realtor',          handle: 'test-realestate',     flag: 'is_realtor' },
  { email: 'test-precon@strug.ca',         name: 'Test Precon Developer', handle: 'test-precon',         flag: 'is_precon_developer' },
  { email: 'test-experiences@strug.ca',    name: 'Test Experience Host',  handle: 'test-experiences',    flag: 'is_experience_provider' },
  { email: 'test-celebrity@strug.ca',      name: 'Test Celebrity',        handle: 'test-celebrity',      flag: 'is_celebrity' },
  { email: 'test-services@strug.ca',       name: 'Test Service Provider', handle: 'test-services',       flag: 'is_service_provider' },
  { email: 'test-instructor@strug.ca',     name: 'Test Instructor',       handle: 'test-instructor',     flag: 'is_instructor' },
  { email: 'test-proservices@strug.ca',    name: 'Test Professional',     handle: 'test-proservices',    flag: 'is_professional' },
  { email: 'test-freelancer@strug.ca',     name: 'Test Freelancer',       handle: 'test-freelancer',     flag: 'is_freelancer' },
  { email: 'test-artist@strug.ca',         name: 'Test Artist',           handle: 'test-artist',         flag: 'is_artist' },
  { email: 'test-doctors@strug.ca',        name: 'Test Doctor',           handle: 'test-doctors',        flag: 'is_doctor' },
  { email: 'test-wedding@strug.ca',        name: 'Test Wedding Provider', handle: 'test-wedding',        flag: 'is_wedding_provider' },
  { email: 'test-creator@strug.ca',        name: 'Test Creator',          handle: 'test-creator',        flag: 'is_creator' },
  { email: 'test-streamer@strug.ca',       name: 'Test Streamer',         handle: 'test-streamer',       flag: 'is_streamer' },
  { email: 'test-decor@strug.ca',          name: 'Test Decor Provider',   handle: 'test-decor',          flag: 'is_decor_provider' },
  { email: 'test-auto@strug.ca',           name: 'Test Auto Provider',    handle: 'test-auto',           flag: 'is_mechanic' },
  { email: 'test-influencer@strug.ca',     name: 'Test Influencer',       handle: 'test-influencer',     flag: 'is_influencer' },
  { email: 'test-jobs@strug.ca',           name: 'Test Employer',         handle: 'test-jobs',           flag: 'is_employer' },
];

// ── Vendor-based accounts (food_vendor table) ────────────────────────────────

const VENDOR_ACCOUNTS = [
  { email: 'test-food@strug.ca',           name: 'Test Food Vendor',           handle: 'test-food',          vendorName: 'Test Restaurant',          cuisine: 'General' },
  { email: 'test-groceries@strug.ca',      name: 'Test Grocery Vendor',        handle: 'test-groceries',     vendorName: 'Test Grocery Store',       cuisine: 'Grocery' },
  { email: 'test-catering@strug.ca',       name: 'Test Catering Vendor',       handle: 'test-catering',      vendorName: 'Test Catering Co.',         cuisine: 'Catering' },
  { email: 'test-restbookings@strug.ca',   name: 'Test Restaurant Bookings',   handle: 'test-restbookings',  vendorName: 'Test Dining Room',          cuisine: 'Dining' },
  { email: 'test-mealkit@strug.ca',        name: 'Test Meal Kit Vendor',       handle: 'test-mealkit',       vendorName: 'Test Meal Kits',            cuisine: 'Meal Kit' },
  { email: 'test-insurance@strug.ca',      name: 'Test Insurance Provider',    handle: 'test-insurance',     vendorName: 'Test Insurance Co.',        cuisine: 'Insurance' },
  { email: 'test-mortgage@strug.ca',       name: 'Test Mortgage Provider',     handle: 'test-mortgage',      vendorName: 'Test Mortgage Co.',         cuisine: 'Mortgage' },
];

async function upsertUser(email, name, handle) {
  const encryptedEmail = encryptEmail(email);
  const hashed = await bcrypt.hash(PASSWORD, 10);
  const refCode = 'TEST' + Math.random().toString(36).slice(2, 8).toUpperCase();

  // Remove any stale plaintext record
  await prisma.user.deleteMany({ where: { email } });

  const existing = await prisma.user.findUnique({ where: { email: encryptedEmail } });
  if (existing) {
    console.log(`  ↻ Account already exists: ${email}`);
    return existing.user_id;
  }

  // Note: seller flags (is_driver, is_host, etc.) are not DB columns — they live in
  // localStorage only. Accounts are created here; flags are set client-side after login.
  const user = await prisma.user.create({
    data: { name, email: encryptedEmail, password: hashed, ref_code: refCode },
  });

  await prisma.social_profile.upsert({
    where: { handle },
    update: {},
    create: { user_id: user.user_id, handle, display_name: name, accepted_terms: true },
  });

  return user.user_id;
}

async function main() {
  console.log(`\nSeeding seller test accounts (password: ${PASSWORD})\n`);
  console.log('─'.repeat(60));

  // ── Flag-based accounts ──────────────────────────────────────────
  console.log('\n[1/2] Flag-based accounts\n');
  for (const acct of FLAG_ACCOUNTS) {
    const userId = await upsertUser(acct.email, acct.name, acct.handle);
    console.log(`  ✓  ${acct.email.padEnd(38)}  dashboard: ${acct.flag}  (id: ${userId})`);
  }

  // ── Vendor-based accounts ────────────────────────────────────────
  console.log('\n[2/2] Vendor-based accounts\n');
  for (const acct of VENDOR_ACCOUNTS) {
    const userId = await upsertUser(acct.email, acct.name, acct.handle);

    // Create or reuse an active vendor record for this user
    const existing = await prisma.food_vendor.findFirst({ where: { owner_id: userId } });
    if (!existing) {
      await prisma.food_vendor.create({
        data: {
          owner_id: userId,
          vendor_name: acct.vendorName,
          cuisine_type: acct.cuisine,
          is_open: true,
          is_active: true,
          location: 'Toronto, ON',
        },
      });
    } else if (!existing.is_active) {
      await prisma.food_vendor.update({
        where: { vendor_id: existing.vendor_id },
        data: { is_active: true },
      });
      console.log(`  ↻ Activated existing vendor for ${acct.email}`);
    }

    console.log(`  ✓  ${acct.email.padEnd(38)}  active food_vendor`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`\nDone. ${FLAG_ACCOUNTS.length + VENDOR_ACCOUNTS.length} accounts ready.\n`);
  console.log('Password for all accounts:', PASSWORD);
  console.log('');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
