/**
 * Shop-family product_listing vertical types (Phase 8).
 *
 * Only names that truly live on product_listing / product_type.
 * Books + DigitalProducts are dg_category / dg_content — not product types.
 * Discounts is a discount_pct feed, not a product type.
 */

export const VERTICAL_PRODUCT_TYPE = Object.freeze({
  shop: 'Shop',
  secondhand: 'SecondHand',
  wedding: 'Wedding',
  decor: 'Decor',
});

export const VERTICAL_PRODUCT_TYPE_NAMES = Object.freeze(
  Object.values(VERTICAL_PRODUCT_TYPE),
);

/** Must never be used as product_listing type filters or auto-mint names. */
export const NON_PRODUCT_LISTING_TYPE_NAMES = Object.freeze([
  'Books',
  'DigitalProducts',
  'Discounts',
]);

export function normalizeProductTypeKey(name) {
  return String(name ?? '').replace(/\s+/g, '').toLowerCase();
}

export function isKnownVerticalProductType(name) {
  const n = normalizeProductTypeKey(name);
  if (!n) return false;
  return VERTICAL_PRODUCT_TYPE_NAMES.some(
    (t) => normalizeProductTypeKey(t) === n,
  );
}

export function isNonProductListingTypeName(name) {
  const n = normalizeProductTypeKey(name);
  if (!n) return false;
  return NON_PRODUCT_LISTING_TYPE_NAMES.some(
    (t) => normalizeProductTypeKey(t) === n,
  );
}

/**
 * Resolve product_type_id for listing create/update.
 *
 * - Explicit product_type_id wins when provided
 * - product_type_name: look up existing row (Clothing, Beauty, …)
 * - Missing name only auto-mints for known verticals (Shop / SecondHand / Wedding / Decor)
 * - Rejects dg-content / discounts labels and unknown typos (no silent mint)
 *
 * @returns {{ product_type_id: number|null } | { error: string, status: number }}
 */
export async function resolveProductTypeIdForListing(
  prisma,
  { product_type_id = null, product_type_name = null } = {},
) {
  if (product_type_id != null && product_type_id !== '') {
    const id = Number(product_type_id);
    if (!Number.isFinite(id)) {
      return { error: 'product_type_id must be a number', status: 400 };
    }
    return { product_type_id: id };
  }

  if (product_type_name == null || product_type_name === '') {
    return { product_type_id: null };
  }

  const typeName = String(product_type_name).trim();
  if (!typeName) return { product_type_id: null };

  if (isNonProductListingTypeName(typeName)) {
    return {
      error:
        `${typeName} is not a product_listing type (use dg-content for Books/Digital Products; Discounts is a sale feed)`,
      status: 400,
    };
  }

  let pType = await prisma.product_type.findFirst({
    where: { product_type_name: { equals: typeName, mode: 'insensitive' } },
  });

  if (!pType) {
    if (!isKnownVerticalProductType(typeName)) {
      return {
        error:
          `Unknown product type "${typeName}". Use an existing product_type_id or a known vertical name (Shop, SecondHand, Wedding, Decor).`,
        status: 400,
      };
    }
    pType = await prisma.product_type.create({
      data: { product_type_name: typeName },
    });
  }

  return { product_type_id: pType.product_type_id };
}
