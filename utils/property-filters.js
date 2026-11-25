/**
 * Shared public property list filters (browse + saved-search alerts).
 * Mirrors query keys used by GET /property/.
 */
export function asFloat(v) {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function asInt(v) {
  if (v == null || v === '') return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build a Prisma `where` for published property browse / alert matching.
 * @param {object} query - { vertical, city, q, type, listing_status, construction_status, min_price, max_price, beds, featured }
 * @param {object|null} viewer - optional auth user for unpublished access
 */
export function buildPublicPropertyWhere(query = {}, viewer = null) {
  const vertical = typeof query.vertical === 'string' ? query.vertical : undefined;
  const where = {};

  const wantsUnpublished = query.include_unpublished === 'true' || query.include_unpublished === true;
  const isAdmin = viewer?.role === 'ADMIN' || viewer?.permission === 'admin';
  if (wantsUnpublished && viewer && isAdmin) {
    // no is_published constraint
  } else if (wantsUnpublished && viewer) {
    where.AND = [...(where.AND || []), { OR: [{ is_published: true }, { user_id: viewer.user_id }] }];
  } else {
    where.is_published = true;
  }

  if (vertical === 'realestate') {
    where.AND = [...(where.AND || []), { OR: [{ vertical: 'realestate' }, { vertical: null }] }];
  } else if (vertical) {
    where.vertical = vertical;
  }

  if (query.city) where.city = { contains: String(query.city), mode: 'insensitive' };
  if (query.q) {
    const q = String(query.q);
    where.AND = [
      ...(where.AND || []),
      {
        OR: [
          { property_name: { contains: q, mode: 'insensitive' } },
          { address: { contains: q, mode: 'insensitive' } },
          { city: { contains: q, mode: 'insensitive' } },
          { developer_name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { neighborhood: { contains: q, mode: 'insensitive' } },
        ],
      },
    ];
  }
  if (query.type) where.type = String(query.type);
  if (query.listing_status) where.listing_status = String(query.listing_status);
  if (query.construction_status) where.construction_status = String(query.construction_status);

  const minPrice = asFloat(query.min_price);
  if (minPrice != null) where.price_min = { ...(where.price_min || {}), gte: minPrice };

  const maxPrice = asFloat(query.max_price);
  if (maxPrice != null) {
    where.AND = [
      ...(where.AND || []),
      {
        OR: [
          { price_max: { lte: maxPrice } },
          { estimated_value: { lte: maxPrice } },
          { price_min: { lte: maxPrice } },
        ],
      },
    ];
  }

  const beds = asInt(query.beds);
  if (beds != null) where.beds_min = { gte: beds };
  if (query.featured === 'true' || query.featured === true) where.is_featured = true;

  return where;
}

/**
 * Normalize saved-search filters JSON into buildPublicPropertyWhere query keys.
 */
export function filtersToPropertyQuery(filters = {}, vertical = null) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const q = {};
  if (vertical) q.vertical = vertical;
  if (f.q) q.q = String(f.q).trim();
  if (f.city) q.city = String(f.city).trim();
  if (f.type) q.type = String(f.type);
  if (f.listing_status) q.listing_status = String(f.listing_status);
  if (f.construction_status) q.construction_status = String(f.construction_status);
  if (f.min_price != null && f.min_price !== '' && Number(f.min_price) > 0) q.min_price = f.min_price;
  if (f.max_price != null && f.max_price !== '' && Number(f.max_price) > 0) q.max_price = f.max_price;
  if (f.beds != null && f.beds !== '' && Number(f.beds) > 0) q.beds = f.beds;
  if (f.featured != null) q.featured = f.featured;
  return q;
}

/** Human label for a saved search (notifications + UI fallback). */
export function describeSavedSearchFilters(filters = {}, vertical = null) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const bits = [];
  if (vertical === 'preconstruct') bits.push('Construct');
  else if (vertical === 'realestate') bits.push('Real Estate');
  if (f.q) bits.push(`“${String(f.q).trim()}”`);
  if (f.city) bits.push(String(f.city).trim());
  if (f.type) bits.push(String(f.type));
  if (f.beds) bits.push(`${f.beds}+ beds`);
  if (f.max_price) bits.push(`under $${Number(f.max_price).toLocaleString()}`);
  if (f.min_price) bits.push(`from $${Number(f.min_price).toLocaleString()}`);
  return bits.length ? bits.join(' · ') : 'your saved search';
}
