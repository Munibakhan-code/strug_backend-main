/**
 * Cleanup restaurant-related data for every user who created a Restaurant listing.
 *
 * A "restaurant listing" is a food_vendor whose vendor_type is "Restaurant" (resolved by
 * NAME via utils/vendor-type.js — ids are not stable across environments). Legacy vendors
 * with vendor_type_id = NULL are treated as restaurants by the app; they are reported
 * SEPARATELY and are only deleted when --include-untyped is passed.
 *
 * The script removes the whole dependent graph in FK-safe order inside a single transaction:
 *   food_order_rating -> food_order_items -> food_order
 *   food_item_modifier_option -> food_item_modifier_group -> food_item_pics -> food_cart
 *   -> food_item -> food_category
 *   reservation -> restaurant_table -> restaurant_seating
 *   saved_item (entity_type='restaurant') sweep
 *   dating_date_plan (vendor_id set NULL — the plan is preserved, only the link is dropped)
 *   food_vendor (the listing itself, last)
 *
 * PRESERVED: user accounts (owners AND customers), drivers, delivery_batch, promotions,
 * non-restaurant vendors, and every non-restaurant record. Uploaded images are removed at
 * the DB level only — the underlying Azure Blob files are left untouched.
 *
 * SAFETY: read-only by default (dry-run report). Refuses to run against a non-local
 * DATABASE_URL unless --force (or ALLOW_PROD_SCRIPTS=1) is set. Nothing is deleted without --apply.
 *
 * Usage:
 *   node scripts/cleanup-restaurant-data.js                 # dry-run report (no changes)
 *   node scripts/cleanup-restaurant-data.js --include-untyped
 *   node scripts/cleanup-restaurant-data.js --apply         # perform the deletion
 *   ALLOW_PROD_SCRIPTS=1 node scripts/cleanup-restaurant-data.js --apply --force
 */
import prisma from '../utils/prisma-client.js';
import { resolveRestaurantVendorTypeId } from '../utils/vendor-type.js';

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  return {
    apply,
    dryRun: !apply,
    includeUntyped: argv.includes('--include-untyped'),
    // Both are required, per the header and the refusal message below: the flag proves
    // intent at the keyboard, the env var proves intent about the environment. Either
    // one alone used to unlock a non-local target.
    force: argv.includes('--force') && process.env.ALLOW_PROD_SCRIPTS === '1',
  };
}

function describeDatabaseTarget() {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) return '(DATABASE_URL not set)';
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(DATABASE_URL set, unparseable)';
  }
}

function assertSafeEnvironment(args) {
  const dbUrl = process.env.DATABASE_URL || '';
  const looksLocal =
    /localhost|127\.0\.0\.1|0\.0\.0\.0|:5433\b|strug_test|\/test\b/i.test(dbUrl)
    || process.env.NODE_ENV === 'development'
    || process.env.NODE_ENV === 'test';

  if (args.apply) {
    console.warn('WARNING: --apply will permanently delete restaurant data from the database.');
  }
  if (!looksLocal && !args.force) {
    console.error(
      'Refusing to run against a non-local DATABASE_URL. Re-run with --force and ALLOW_PROD_SCRIPTS=1 if you really mean it.',
    );
    process.exit(1);
  }
  if (!looksLocal) {
    console.warn('Proceeding against a non-local database because --force/ALLOW_PROD_SCRIPTS was set.');
  }
}

/**
 * Ordered dependency graph. Each step shares ONE where-clause between the dry-run count,
 * the delete/detach, and the post-run orphan check — so what we report is exactly what we remove.
 * `action: 'delete'` => deleteMany; `action: 'detach'` => updateMany set vendor_id null.
 */
function buildSteps(vendorIds, vendorIdStrings) {
  const inV = { in: vendorIds };
  return [
    { key: 'food_order_rating', model: 'food_order_rating', action: 'delete',
      where: { OR: [{ food_order: { vendor_id: inV } }, { vendor_id: inV }] } },
    { key: 'food_order_items', model: 'food_order_items', action: 'delete',
      where: { OR: [{ food_order: { vendor_id: inV } }, { food_item: { vendor_id: inV } }] } },
    { key: 'food_order', model: 'food_order', action: 'delete',
      where: { vendor_id: inV } },
    { key: 'food_item_modifier_option', model: 'food_item_modifier_option', action: 'delete',
      where: { group: { food_item: { vendor_id: inV } } } },
    { key: 'food_item_modifier_group', model: 'food_item_modifier_group', action: 'delete',
      where: { food_item: { vendor_id: inV } } },
    { key: 'food_item_pics', model: 'food_item_pics', action: 'delete',
      where: { food_item: { vendor_id: inV } } },
    { key: 'food_cart', model: 'food_cart', action: 'delete',
      where: { vendor_id: inV } },
    { key: 'food_item', model: 'food_item', action: 'delete',
      where: { vendor_id: inV } },
    { key: 'food_category', model: 'food_category', action: 'delete',
      where: { vendor_id: inV } },
    { key: 'reservation', model: 'reservation', action: 'delete',
      where: { vendor_id: inV } },
    { key: 'restaurant_table', model: 'restaurant_table', action: 'delete',
      where: { vendor_id: inV } },
    { key: 'restaurant_seating', model: 'restaurant_seating', action: 'delete',
      where: { vendor_id: inV } },
    { key: 'saved_item', model: 'saved_item', action: 'delete',
      where: { entity_type: 'restaurant', entity_id: { in: vendorIdStrings } } },
    { key: 'dating_date_plan (detached)', model: 'dating_date_plan', action: 'detach',
      where: { vendor_id: inV } },
    { key: 'food_vendor', model: 'food_vendor', action: 'delete',
      where: { vendor_id: inV } },
  ];
}

function fmtVendor(v) {
  const type = v.vendor_type?.vendor_type ?? (v.vendor_type_id == null ? 'NULL (untyped)' : `#${v.vendor_type_id}`);
  return `  [vendor ${v.vendor_id}] ${v.vendor_name ?? '(no name)'} — type=${type}, owner=${v.owner_id ?? 'none'}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertSafeEnvironment(args);

  console.log('='.repeat(72));
  console.log(`Restaurant data cleanup — ${args.apply ? 'APPLY (deleting)' : 'DRY RUN (read-only report)'}`);
  console.log(`Database: ${describeDatabaseTarget()}`);
  console.log(`Include untyped (vendor_type_id = NULL) vendors: ${args.includeUntyped ? 'YES' : 'no'}`);
  console.log('='.repeat(72));

  const restaurantTypeId = await resolveRestaurantVendorTypeId(prisma);
  if (restaurantTypeId == null) {
    console.warn('No vendor_type named "Restaurant" was found in this database.');
    if (!args.includeUntyped) {
      console.error('Nothing to target (and --include-untyped not set). Aborting.');
      await prisma.$disconnect();
      process.exit(1);
    }
  } else {
    console.log(`Resolved Restaurant vendor_type_id = ${restaurantTypeId}`);
  }

  const vendorSelect = {
    vendor_id: true,
    vendor_name: true,
    owner_id: true,
    vendor_type_id: true,
    vendor_type: { select: { vendor_type: true } },
  };

  const restaurantVendors = restaurantTypeId == null
    ? []
    : await prisma.food_vendor.findMany({
        where: { vendor_type_id: restaurantTypeId },
        select: vendorSelect,
        orderBy: { vendor_id: 'asc' },
      });

  const untypedVendors = await prisma.food_vendor.findMany({
    where: { vendor_type_id: null },
    select: vendorSelect,
    orderBy: { vendor_id: 'asc' },
  });

  const targetVendors = args.includeUntyped
    ? [...restaurantVendors, ...untypedVendors]
    : restaurantVendors;
  const vendorIds = targetVendors.map((v) => v.vendor_id);
  const vendorIdStrings = vendorIds.map(String);

  // Users who created the targeted restaurant listings.
  const ownerIds = [...new Set(targetVendors.map((v) => v.owner_id).filter((id) => id != null))];
  const owners = ownerIds.length
    ? await prisma.user.findMany({
        where: { user_id: { in: ownerIds } },
        select: { user_id: true, name: true, email: true, username: true },
        orderBy: { user_id: 'asc' },
      })
    : [];

  console.log(`\nRestaurant-typed listings: ${restaurantVendors.length}`);
  console.log(`Untyped (vendor_type_id = NULL) listings: ${untypedVendors.length}${args.includeUntyped ? ' (INCLUDED)' : ' (excluded — pass --include-untyped to remove)'}`);
  console.log(`\nTargeted listings this run: ${targetVendors.length}`);
  targetVendors.forEach((v) => console.log(fmtVendor(v)));

  console.log(`\nUsers who created these restaurant listings: ${owners.length}`);
  // Identify owners by id/name/handle only. This output routinely ends up in a terminal
  // recording or pasted into a ticket, which is the same reason the banner above stopped
  // printing DATABASE_URL — look the address up in the admin tools if you actually need it.
  owners.forEach((u) =>
    console.log(`  [user ${u.user_id}] ${u.name ?? '(no name)'}${u.username ? ` @${u.username}` : ''}`),
  );

  if (untypedVendors.length && !args.includeUntyped) {
    console.log('\nUntyped vendors NOT targeted this run (review before including):');
    untypedVendors.forEach((v) => console.log(fmtVendor(v)));
  }

  if (vendorIds.length === 0) {
    console.log('\nNo restaurant listings match the current scope. Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  const steps = buildSteps(vendorIds, vendorIdStrings);

  // ---- Report the affected dependent records (read-only counts) ----
  console.log('\nDependent records in scope:');
  let totalRows = 0;
  for (const step of steps) {
    const n = await prisma[step.model].count({ where: step.where });
    if (step.action !== 'detach') totalRows += n;
    const note = step.action === 'detach' ? '  (link cleared, row kept)' : '';
    console.log(`  ${step.key.padEnd(30)} ${String(n).padStart(8)}${note}`);
  }
  console.log(`  ${'TOTAL rows to delete'.padEnd(30)} ${String(totalRows).padStart(8)}`);

  if (args.dryRun) {
    console.log('\nDRY RUN complete — no rows were changed. Re-run with --apply to delete.');
    await prisma.$disconnect();
    return;
  }

  // ---- Apply: delete/detach in dependency order, in one transaction ----
  console.log('\nApplying deletion inside a single transaction...');
  const deleted = await prisma.$transaction(
    async (tx) => {
      const result = {};
      for (const step of steps) {
        if (step.action === 'detach') {
          result[step.key] = (await tx[step.model].updateMany({ where: step.where, data: { vendor_id: null } })).count;
        } else {
          result[step.key] = (await tx[step.model].deleteMany({ where: step.where })).count;
        }
      }
      return result;
    },
    { timeout: 120_000, maxWait: 30_000 },
  );

  console.log('\nRows affected:');
  for (const step of steps) {
    console.log(`  ${step.key.padEnd(30)} ${String(deleted[step.key] ?? 0).padStart(8)}`);
  }

  // ---- Orphan verification: every delete step must now match zero rows ----
  console.log('\nVerifying no orphaned data remains...');
  let orphans = 0;
  for (const step of steps) {
    const remaining = await prisma[step.model].count({ where: step.where });
    if (remaining > 0) {
      orphans += remaining;
      console.error(`  FAIL ${step.key}: ${remaining} row(s) still reference the removed restaurants`);
    }
  }

  await prisma.$disconnect();

  if (orphans > 0) {
    console.error(`\nOrphan check FAILED — ${orphans} row(s) remain. Investigate before trusting the cleanup.`);
    process.exit(1);
  }
  console.log('\nOrphan check PASSED — no dangling restaurant references remain.');
  console.log('Cleanup complete.');
}

main().catch(async (err) => {
  console.error('Cleanup failed:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
