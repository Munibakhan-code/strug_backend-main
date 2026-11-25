// Seed the Wedding shop with real product_listing rows (global bridal catalogue).
//
// Why: Wedding.jsx loads GET /wedding/products, which filters product_listing on
// product_type_name = 'Wedding' AND seller_id NOT NULL. With no such rows the
// boutique grid renders "No boutiques found." even though the page works.
//
// Sellers must NOT match the buyer-side test-name filter (/test|seed|demo|.../i in
// shopMappers.SHOP_TEST_NAME_PATTERN) or their storefront is hidden from browse.
//
// Idempotent: a listing is matched by (seller_id, name) and skipped if present.
// Product copy is market-agnostic (no Canada-only inventory).
//
//   node scripts/seed-wedding-shop.js

import prisma from '../utils/prisma-client.js';

const PRODUCT_TYPE_NAME = 'Wedding';

// vname drives the browse category chips (Dresses / Rings / Accessories / Decor / Stationery).
const BOUTIQUES = [
  {
    seller: 'StyleHaus Shop',
    products: [
      { name: 'Ivory A-Line Bridal Gown', category: 'Dresses', price: 1250, stock: 6, description: 'Classic A-line silhouette in ivory silk with a chapel train. Ships internationally.' },
      { name: 'Lace Mermaid Wedding Dress', category: 'Dresses', price: 1680, stock: 4, description: 'Fitted lace mermaid gown with an illusion back. Available for global shipping.' },
      { name: 'Silk Bridal Veil (2m)', category: 'Accessories', price: 180, stock: 20, description: 'Two-metre cathedral veil in soft silk tulle.' },
      { name: 'Pearl Drop Earrings', category: 'Accessories', price: 95, stock: 30, description: 'Freshwater pearl drops set in 14k gold.' },
    ],
  },
  {
    seller: 'Crafted Goods Co.',
    products: [
      { name: 'Classic Gold Wedding Band', category: 'Rings', price: 640, stock: 15, description: 'Hand-finished 14k gold comfort-fit band.' },
      { name: 'Diamond Solitaire Ring', category: 'Rings', price: 2400, stock: 5, description: 'Brilliant-cut solitaire on a slim platinum setting.' },
      { name: 'Letterpress Invitation Suite', category: 'Stationery', price: 220, stock: 40, description: 'Invitation, RSVP card and envelopes — 50 sets.' },
      { name: 'Gold Foil Place Cards (50pc)', category: 'Stationery', price: 65, stock: 50, description: 'Hand-lettered place cards with gold foil edging.' },
    ],
  },
  {
    seller: 'HomeDecor Hub',
    products: [
      { name: 'Eucalyptus Table Garland (3m)', category: 'Decor', price: 140, stock: 25, description: 'Preserved eucalyptus runner for head and guest tables.' },
      { name: 'Gold Arch Backdrop Frame', category: 'Decor', price: 380, stock: 8, description: 'Freestanding gold arch for ceremony and photo backdrops.' },
      { name: 'Glass Hurricane Centrepieces (Set of 6)', category: 'Decor', price: 210, stock: 12, description: 'Tall glass hurricanes with pillar candles included.' },
    ],
  },
];

/**
 * Rows imported with explicit ids leave the identity sequence behind max(id), so the
 * next insert collides with P2002 on the primary key. Push the sequence past the
 * current max before writing.
 */
async function resyncSequence(table, column) {
  await prisma.$executeRawUnsafe(
    `SELECT setval(
       pg_get_serial_sequence('${table}', '${column}'),
       COALESCE((SELECT MAX(${column}) FROM ${table}), 0) + 1,
       false
     )`,
  );
}

async function ensureProductType() {
  const existing = await prisma.product_type.findFirst({
    where: { product_type_name: { equals: PRODUCT_TYPE_NAME, mode: 'insensitive' } },
  });
  if (existing) return existing.product_type_id;
  const created = await prisma.product_type.create({
    data: { product_type_name: PRODUCT_TYPE_NAME },
  });
  console.log(`Created product_type '${PRODUCT_TYPE_NAME}' (id=${created.product_type_id})`);
  return created.product_type_id;
}

async function resolveSeller(name) {
  const byName = await prisma.user.findFirst({
    where: { name },
    select: { user_id: true, name: true },
  });
  if (byName) return byName;

  // Fall back to any seller whose display name won't be hidden by the buyer-side
  // test-name filter, so the seeded storefront is actually reachable in browse.
  const fallback = await prisma.user.findFirst({
    where: {
      is_seller: true,
      NOT: { name: { contains: 'test', mode: 'insensitive' } },
    },
    orderBy: { user_id: 'asc' },
    select: { user_id: true, name: true },
  });
  return fallback;
}

async function ensureProduct(sellerId, typeId, p) {
  const existing = await prisma.product_listing.findFirst({
    where: { seller_id: sellerId, name: p.name },
    select: { listing_id: true },
  });
  if (existing) return { created: false };

  const listing = await prisma.product_listing.create({
    data: {
      name: p.name,
      description: p.description,
      availability: p.stock,
      product_type_id: typeId,
      seller_id: sellerId,
    },
  });

  await prisma.product_variation.create({
    data: {
      listing_id: listing.listing_id,
      price: p.price,
      vname: p.category,
      description: 'Default',
      product_type_id: typeId,
    },
  });

  return { created: true };
}

async function main() {
  for (const [table, column] of [
    ['product_type', 'product_type_id'],
    ['product_listing', 'listing_id'],
    ['product_variation', 'variation_id'],
  ]) {
    await resyncSequence(table, column);
  }

  const typeId = await ensureProductType();
  let created = 0;
  let skipped = 0;

  for (const boutique of BOUTIQUES) {
    const seller = await resolveSeller(boutique.seller);
    if (!seller) {
      console.warn(`No seller available for "${boutique.seller}" — skipping.`);
      continue;
    }
    console.log(`Seeding ${boutique.products.length} items for ${seller.name} (user_id=${seller.user_id})`);
    for (const p of boutique.products) {
      const r = await ensureProduct(seller.user_id, typeId, p);
      r.created ? created++ : skipped++;
    }
  }

  console.log(`Done. created=${created} skipped=${skipped}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
