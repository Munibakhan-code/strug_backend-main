/**
 * Seed script for Playwright E2E test data.
 * Run: node prisma/seed-test.js
 *
 * Creates:
 *   - Account A (testa@strug.ca) — customer
 *   - Account B (testb@strug.ca) — seller/provider
 *   - 1 approved product listing (Account B, $25) with variation
 *   - 1 approved rental listing (Account B, $89/night)
 *   - Referral code for Account B = their username "testseller"
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const hashA = await bcrypt.hash('TestA2026!', 10);
  const hashB = await bcrypt.hash('TestB2026!', 10);

  // Upsert Account A (customer)
  const userA = await prisma.user.upsert({
    where: { email: 'testa@strug.ca' },
    update: {},
    create: {
      email: 'testa@strug.ca',
      password: hashA,
      name: 'Test Customer',
      username: 'testcustomer',
    },
  });

  // Upsert Account B (seller)
  const userB = await prisma.user.upsert({
    where: { email: 'testb@strug.ca' },
    update: {},
    create: {
      email: 'testb@strug.ca',
      password: hashB,
      name: 'Test Seller',
      username: 'testseller',
    },
  });

  console.log('UserA id:', userA.user_id, ' UserB id:', userB.user_id);

  // Product listing for Account B — $25 with a variation
  try {
    const product = await prisma.product_listing.upsert({
      where: { listing_id: 999901 },
      update: {},
      create: {
        listing_id: 999901,
        seller_id: userB.user_id,
        listing_name: 'Seed Widget',
        listing_description: 'Test product for Playwright',
        listing_price: 25,
        listing_status: 'approved',
      },
    });

    await prisma.product_variation.upsert({
      where: { variation_id: 999901 },
      update: {},
      create: {
        variation_id: 999901,
        listing_id: product.listing_id,
        price: 25,
        stock: 10,
      },
    });
    console.log('Product seed complete:', product.listing_id);
  } catch (e) {
    console.warn('Product seed skipped (schema mismatch):', e.message);
  }

  // Rental listing for Account B
  try {
    await prisma.rental_listing.upsert({
      where: { rental_listing_id: 999901 },
      update: {},
      create: {
        rental_listing_id: 999901,
        owner_id: userB.user_id,
        rental_listing_name: 'Seed Apartment',
        amount: 89,
        duration: 'nightly',
        location: 'Toronto, ON',
        is_available: true,
      },
    });
    console.log('Rental listing seed complete');
  } catch (e) {
    console.warn('Rental listing seed skipped (schema mismatch):', e.message);
  }

  // Set ref_code for Account B to their username
  try {
    await prisma.user.update({
      where: { user_id: userB.user_id },
      data: { ref_code: 'testseller' },
    });
    console.log('Ref code set to "testseller" for Account B');
  } catch (e) {
    console.warn('ref_code update skipped:', e.message);
  }

  console.log('\nSeed complete.');
  console.log('Account A:', userA.user_id, '(testa@strug.ca / TestA2026!)');
  console.log('Account B:', userB.user_id, '(testb@strug.ca / TestB2026!)');
  console.log('\nFor Playwright, export:');
  console.log(`  export USER_B_ID="${userB.user_id}"`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
