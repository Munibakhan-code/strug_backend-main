/**
 * Resolve vendor_type rows by name. IDs are not stable across seeds/environments,
 * so production code must never hardcode vendor_type_id = 1 for Restaurant.
 */

const TYPE_ALIASES = Object.freeze({
  restaurant: ['Restaurant'],
  restaurants: ['Restaurant'],
  food: ['Restaurant'],
  grocery: ['Grocery'],
  groceries: ['Grocery'],
  pharmacy: ['Pharmacy'],
  liquor: ['Liquor'],
  floral: ['Floral'],
  flowers: ['Floral'],
  florist: ['Floral'],
  catering: ['Catering'],
  mealkit: ['Meal Kit'],
  meal_kit: ['Meal Kit'],
});

export function vendorTypeNamesForAlias(aliasOrName) {
  const key = String(aliasOrName || '').trim().toLowerCase();
  if (!key) return [];
  return TYPE_ALIASES[key] || [String(aliasOrName).trim()];
}

/**
 * Canonical vendor_type NAME → promo/discount vertical slug.
 *
 * The food-vendor family (Restaurant, Liquor, Grocery, Pharmacy, Floral, Catering, Meal Kit)
 * all share the same food_vendor / food_order / food-analytics machinery, but each type
 * creates, redeems and surfaces promotions under its OWN vertical — so a Grocery seller's
 * promo never leaks onto a Restaurant card (and a Restaurant promo is never redeemable at a
 * Grocery checkout). Keep this in sync with the frontend FOOD_VERTICAL_SLUG_BY_NAV /
 * resolvePromoVertical vocabulary.
 */
export const VENDOR_TYPE_TO_VERTICAL = Object.freeze({
  restaurant: 'food',
  liquor: 'liquor',
  grocery: 'grocery',
  pharmacy: 'pharmacy',
  floral: 'floral',
  catering: 'catering',
  'meal kit': 'mealkit',
});

/** Canonical promo vertical slug for a vendor_type name (null when unknown). */
export function verticalForVendorTypeName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return VENDOR_TYPE_TO_VERTICAL[key] || null;
}

/**
 * Build a Map<vendor_type_id, vertical> for the whole vendor_type table so browse mappers
 * can resolve a vendor's vertical without hardcoding ids (which are not stable across DBs).
 * @param {import('@prisma/client').PrismaClient} db
 */
export async function buildVendorTypeVerticalMap(db) {
  const rows = await db.vendor_type.findMany({
    select: { vendor_type_id: true, vendor_type: true },
  });
  const map = new Map();
  for (const r of rows) {
    const vertical = verticalForVendorTypeName(r.vendor_type);
    if (vertical) map.set(Number(r.vendor_type_id), vertical);
  }
  return map;
}

/**
 * Resolve the canonical promo vertical for a single vendor_type_id (null when unknown).
 * @param {import('@prisma/client').PrismaClient} db
 */
export async function resolveVerticalForVendorTypeId(db, vendorTypeId) {
  if (vendorTypeId == null) return null;
  const row = await db.vendor_type.findFirst({
    where: { vendor_type_id: Number(vendorTypeId) },
    select: { vendor_type: true },
  });
  return verticalForVendorTypeName(row?.vendor_type);
}

/** @param {import('@prisma/client').PrismaClient} db */
export async function findVendorTypeIdsByNames(db, names) {
  const list = (names || []).map((n) => String(n).trim()).filter(Boolean);
  if (!list.length) return [];
  const rows = await db.vendor_type.findMany({
    where: { OR: list.map((n) => ({ vendor_type: { equals: n, mode: 'insensitive' } })) },
    select: { vendor_type_id: true, vendor_type: true },
  });
  return rows.map((r) => r.vendor_type_id);
}

/** @param {import('@prisma/client').PrismaClient} db */
export async function resolveRestaurantVendorTypeId(db) {
  const ids = await findVendorTypeIdsByNames(db, ['Restaurant']);
  return ids[0] ?? null;
}

/**
 * Prisma where fragment for public restaurant browse:
 * Restaurant-named types + legacy null vendor_type_id rows.
 * @param {import('@prisma/client').PrismaClient} db
 */
export async function restaurantVendorTypeWhere(db) {
  const restaurantIds = await findVendorTypeIdsByNames(db, ['Restaurant']);
  return {
    OR: [
      ...restaurantIds.map((id) => ({ vendor_type_id: id })),
      { vendor_type_id: null },
    ],
  };
}
