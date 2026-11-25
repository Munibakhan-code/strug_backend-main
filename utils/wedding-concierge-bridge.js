/**
 * Map wedding booking_listing.attributes.vendor_type → event_need checklist category.
 * Checklist presets live in event-concierge-routes NEED_PRESETS.wedding.
 */
const VENDOR_TYPE_TO_NEED = {
  venue: { category: 'venue', linked_nav: 'venues', title: 'Venue' },
  florist: { category: 'flowers', linked_nav: 'floral', title: 'Flowers' },
  floral: { category: 'flowers', linked_nav: 'floral', title: 'Flowers' },
  flowers: { category: 'flowers', linked_nav: 'floral', title: 'Flowers' },
  catering: { category: 'catering', linked_nav: 'catering', title: 'Catering' },
  photography: { category: 'photographer', linked_nav: 'ondemand', title: 'Photographer' },
  photographer: { category: 'photographer', linked_nav: 'ondemand', title: 'Photographer' },
  videography: { category: 'videographer', linked_nav: 'ondemand', title: 'Videographer' },
  videographer: { category: 'videographer', linked_nav: 'ondemand', title: 'Videographer' },
  rental: { category: 'rental', linked_nav: 'equipment', title: 'Rentals' },
  rentals: { category: 'rental', linked_nav: 'equipment', title: 'Rentals' },
};

/**
 * @param {unknown} vendorType
 * @param {{ listingTitle?: string|null }} [opts]
 * @returns {{ category: string, linked_nav: string|null, title: string }}
 */
export function mapWeddingVendorToNeed(vendorType, { listingTitle } = {}) {
  const key = String(vendorType || '').trim().toLowerCase();
  const mapped = VENDOR_TYPE_TO_NEED[key];
  if (mapped) {
    return {
      category: mapped.category,
      linked_nav: mapped.linked_nav,
      title: listingTitle?.trim() ? String(listingTitle).slice(0, 200) : mapped.title,
    };
  }
  const fallbackTitle = listingTitle?.trim()
    ? String(listingTitle).slice(0, 200)
    : (key ? key.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 200) : 'Wedding vendor');
  return {
    category: key || 'custom',
    linked_nav: 'wedding',
    title: fallbackTitle,
  };
}

/**
 * Prefer an existing checklist row for this category that is not already tied to another booking.
 * @param {Array<{ category?: string, booking_id?: number|null, status?: string, event_need_id?: number }>} needs
 * @param {string} category
 */
export function pickNeedForWeddingVendor(needs, category) {
  const list = Array.isArray(needs) ? needs : [];
  const same = list.filter((n) => String(n.category || '').toLowerCase() === String(category || '').toLowerCase());
  const open = same.find((n) => n.booking_id == null && n.status !== 'skipped');
  if (open) return open;
  return same.find((n) => n.booking_id == null) || null;
}
