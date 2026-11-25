/**
 * Property route helpers / shape sanity — keeps the Livabl-style enrichment
 * fields documented for future route tests.
 */
import { describe, it, expect } from 'vitest';

const RICH_FIELDS = [
  'city', 'neighborhood', 'province', 'country', 'postal_code',
  'latitude', 'longitude', 'price_min', 'price_max',
  'beds_min', 'beds_max', 'baths_min', 'baths_max', 'sqft_min', 'sqft_max',
  'total_units', 'listing_status', 'construction_status', 'completion_date', 'sales_start',
  'deposit_info', 'maintenance_fee', 'developer_name', 'builder_website',
  'virtual_tour_url', 'video_url', 'sales_center_address', 'sales_center_phone',
  'sales_center_email', 'sales_center_hours', 'amenities', 'highlights',
  // Trust flags are admin/publish-gate only — not owner-writable via RICH_FIELDS.
];

describe('property enrichment contract', () => {
  it('includes Livabl-style community fields', () => {
    expect(RICH_FIELDS).toContain('price_min');
    expect(RICH_FIELDS).toContain('developer_name');
    expect(RICH_FIELDS).toContain('sales_center_hours');
    expect(RICH_FIELDS).toContain('virtual_tour_url');
    expect(RICH_FIELDS).toContain('listing_status');
  });

  it('does not expose trust flags as owner-writable enrichment fields', () => {
    expect(RICH_FIELDS).not.toContain('is_verified');
    expect(RICH_FIELDS).not.toContain('is_featured');
    expect(RICH_FIELDS).not.toContain('is_published');
  });
});
