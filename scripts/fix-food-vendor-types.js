/**
 * Fix restaurant vendors saved with wrong vendor_type_id.
 *
 * SAFETY: refuses to run against non-local databases unless --force is passed.
 * Prefer --dry-run first.
 *
 * Usage:
 *   node scripts/fix-food-vendor-types.js --dry-run
 *   node scripts/fix-food-vendor-types.js
 *   ALLOW_PROD_SCRIPTS=1 node scripts/fix-food-vendor-types.js --force
 */
import prisma from '../utils/prisma-client.js';
import { resolveRestaurantVendorTypeId } from '../utils/vendor-type.js';

function assertSafeEnvironment(argv) {
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force') || process.env.ALLOW_PROD_SCRIPTS === '1';
  const dbUrl = process.env.DATABASE_URL || '';
  const looksLocal =
    /localhost|127\.0\.0\.1|0\.0\.0\.0|:5433\b|strug_test|\/test\b/i.test(dbUrl)
    || process.env.NODE_ENV === 'development'
    || process.env.NODE_ENV === 'test';

  console.warn('WARNING: This script mutates food_vendor.vendor_type_id rows.');
  if (!looksLocal && !force) {
    console.error(
      'Refusing to run against a non-local DATABASE_URL. Re-run with --force and ALLOW_PROD_SCRIPTS=1 if you really mean it.',
    );
    process.exit(1);
  }
  if (!looksLocal) {
    console.warn('Proceeding against a non-local database because --force/ALLOW_PROD_SCRIPTS was set.');
  }
  return { dryRun };
}

const { dryRun } = assertSafeEnvironment(process.argv);

const RESTAURANT_NAMES = [
  'Bella Vista Italian Kitchen',
  'Sunrise Grill & Cafe',
  'Maple Garden Bistro',
  'Lahori Tandoor & Grill',
];

const restaurantTypeId = await resolveRestaurantVendorTypeId(prisma);
if (!restaurantTypeId) {
  console.error('No vendor_type named Restaurant found. Aborting.');
  await prisma.$disconnect();
  process.exit(1);
}

const where = {
  OR: [
    { vendor_name: { in: RESTAURANT_NAMES } },
    { vendor_type_id: null },
    { vendor_name: { contains: 'Restaurant', mode: 'insensitive' } },
    { vendor_name: { contains: 'Grill', mode: 'insensitive' } },
    { vendor_name: { contains: 'Kitchen', mode: 'insensitive' } },
    { vendor_name: { contains: 'Bistro', mode: 'insensitive' } },
    { vendor_name: { contains: 'Cafe', mode: 'insensitive' } },
  ],
};

const matches = await prisma.food_vendor.findMany({
  where,
  select: { vendor_id: true, vendor_name: true, vendor_type_id: true },
  orderBy: { vendor_id: 'asc' },
});

console.log(`Matched ${matches.length} vendor(s). Target Restaurant vendor_type_id=${restaurantTypeId}.`);
for (const v of matches) {
  console.log(`  [${v.vendor_id}] ${v.vendor_name} (current type=${v.vendor_type_id})`);
}

if (dryRun) {
  console.log('Dry run only — no rows updated.');
} else {
  const updated = await prisma.food_vendor.updateMany({
    where,
    data: { vendor_type_id: restaurantTypeId },
  });
  console.log(`Updated ${updated.count} vendor(s) to vendor_type_id=${restaurantTypeId} (Restaurant by name).`);
}

const list = await prisma.food_vendor.findMany({
  where: { is_active: true, is_paused: false, vendor_type_id: restaurantTypeId },
  select: { vendor_id: true, vendor_name: true, vendor_type_id: true },
  orderBy: { vendor_id: 'asc' },
});
console.log('\nActive restaurants now visible on GET /food/vendors:');
for (const v of list) console.log(`  [${v.vendor_id}] ${v.vendor_name}`);

await prisma.$disconnect();
