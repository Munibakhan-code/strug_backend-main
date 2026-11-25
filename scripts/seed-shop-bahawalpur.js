/**
 * Seed script: one Shop-vertical seller located in Bahawalpur, Punjab, Pakistan,
 * with a store_profile (lat/lng set so it surfaces in the geo-filtered public
 * storefront — see utils/shop-geo.js) and a batch of product listings.
 *
 * Usage:
 *   cd strug_backend-main
 *   node scripts/seed-shop-bahawalpur.js
 *
 * Idempotent: re-running reuses the existing seller/store/listings instead of
 * duplicating them (matched by email / store_name / listing name).
 * Requires the same .env as the backend (DATABASE_URL, ENCRYPTION_KEY).
 */

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { faker } from '@faker-js/faker';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const PASSWORD = process.env.TEST_ACCOUNT_PASSWORD || 'Strug2026!';

const SELLER_EMAIL = 'seller.bahawalpur@strug.com';
const SELLER_NAME = 'Bahawalpur General Store';
const SELLER_HANDLE = 'seller-bahawalpur';

// Bahawalpur, Punjab, Pakistan
const BAHAWALPUR_LAT = 29.3956;
const BAHAWALPUR_LNG = 71.6836;
const BAHAWALPUR_ADDRESS = 'Model Town, Bahawalpur, Punjab, Pakistan';

// `price` is in CAD — the platform is single-currency CAD only (see utils/tax-config.js:
// "Stripe settles in one currency", per-country tax rate applies on top but currency is
// always forced to CAD). A PKR face-value number here would get charged as that many CAD
// dollars with no conversion — these are already realistic CAD-equivalent prices.
const PRODUCTS = [
  { name: 'Cotton Kurta Shirt', price: 15 },
  { name: 'Handwoven Multani Khussa', price: 12 },
  { name: 'Wireless Earbuds', price: 30 },
  { name: 'Stainless Steel Tiffin Set', price: 10 },
  { name: 'Embroidered Cushion Cover (Set of 2)', price: 8 },
  { name: 'Solar-Powered LED Lantern', price: 18 },
  { name: 'Ceramic Tea Set (6-piece)', price: 22 },
  { name: 'Leather Wallet', price: 11 },
  { name: 'Portable Power Bank 10000mAh', price: 24 },
  { name: 'Hand-Painted Clay Pot', price: 7 },
  { name: 'Cotton Bedsheet Set (King Size)', price: 18 },
  { name: 'Traditional Multani Blue Pottery Vase', price: 14 },
];

function encryptEmail(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return enc;
}

async function ensureShopProductType() {
  const existing = await prisma.product_type.findFirst({ where: { product_type_name: 'Shop' } });
  if (existing) return existing.product_type_id;
  const created = await prisma.product_type.create({ data: { product_type_name: 'Shop' } });
  console.log(`  + product_type 'Shop' = ${created.product_type_id}`);
  return created.product_type_id;
}

async function ensureSellerUser() {
  const encryptedEmail = encryptEmail(SELLER_EMAIL);
  const existing = await prisma.user.findUnique({ where: { email: encryptedEmail } });
  if (existing) {
    console.log(`  ↻ Seller account already exists: ${SELLER_EMAIL} (id: ${existing.user_id})`);
    return existing.user_id;
  }

  const hashed = await bcrypt.hash(PASSWORD, 10);
  const refCode = 'BWP' + Math.random().toString(36).slice(2, 8).toUpperCase();

  const user = await prisma.user.create({
    data: {
      name: SELLER_NAME,
      email: encryptedEmail,
      password: hashed,
      ref_code: refCode,
      is_seller: true,
      country: 'Pakistan',
      city: 'Bahawalpur',
      // The platform is single-currency CAD (tax-config.js forces it at checkout regardless
      // of country/user.currency), so this stays CAD rather than PKR to avoid implying a
      // conversion that doesn't actually happen anywhere downstream.
      currency: 'CAD',
      saved_address: BAHAWALPUR_ADDRESS,
    },
  });

  await prisma.social_profile.upsert({
    where: { handle: SELLER_HANDLE },
    update: {},
    create: { user_id: user.user_id, handle: SELLER_HANDLE, display_name: SELLER_NAME, accepted_terms: true },
  });

  console.log(`  + Created seller account: ${SELLER_EMAIL} (id: ${user.user_id})`);
  return user.user_id;
}

async function ensureStoreProfile(userId) {
  const existing = await prisma.store_profile.findUnique({ where: { user_id: userId } });
  if (existing) {
    await prisma.store_profile.update({
      where: { user_id: userId },
      data: {
        store_name: SELLER_NAME,
        address: BAHAWALPUR_ADDRESS,
        lat: BAHAWALPUR_LAT,
        lng: BAHAWALPUR_LNG,
        is_active: true,
        is_open: true,
      },
    });
    console.log(`  ↻ Updated existing store_profile (id: ${existing.store_id})`);
    return;
  }
  const created = await prisma.store_profile.create({
    data: {
      user_id: userId,
      store_name: SELLER_NAME,
      address: BAHAWALPUR_ADDRESS,
      lat: BAHAWALPUR_LAT,
      lng: BAHAWALPUR_LNG,
      prep_time: '1-2 days',
      bio: 'A general store in Bahawalpur, Punjab — local crafts, home goods, and everyday essentials.',
      is_active: true,
      is_open: true,
    },
  });
  console.log(`  + Created store_profile (id: ${created.store_id})`);
}

async function seedListings(userId, productTypeId) {
  for (const p of PRODUCTS) {
    const existing = await prisma.product_listing.findFirst({
      where: { seller_id: userId, name: p.name },
    });
    if (existing) {
      console.log(`  ↻ Listing already exists: ${p.name}`);
      continue;
    }
    const listing = await prisma.product_listing.create({
      data: {
        name: p.name,
        description: faker.commerce.productDescription(),
        availability: faker.number.int({ min: 15, max: 120 }),
        product_type_id: productTypeId,
        seller_id: userId,
      },
    });
    await prisma.product_variation.create({
      data: {
        listing_id: listing.listing_id,
        price: p.price,
        vname: 'Default',
        product_type_id: productTypeId,
      },
    });
    console.log(`  + ${p.name} — PKR ${p.price}`);
  }
}

async function main() {
  console.log(`\nSeeding Shop data for Bahawalpur, Pakistan (password: ${PASSWORD})\n`);
  console.log('─'.repeat(60));

  const productTypeId = await ensureShopProductType();
  const userId = await ensureSellerUser();
  await ensureStoreProfile(userId);
  await seedListings(userId, productTypeId);

  console.log('\n' + '─'.repeat(60));
  console.log(`\nDone. Seller: ${SELLER_EMAIL} / ${PASSWORD}`);
  console.log(`Store: ${SELLER_NAME} @ ${BAHAWALPUR_LAT}, ${BAHAWALPUR_LNG}`);
  console.log(`${PRODUCTS.length} product listings ready under the "Shop" vertical.\n`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
