import { describe, it, expect } from 'vitest';
import { parseListingBrowseFilters } from '../../utils/booking-listing-filters.js';

describe('booking-listing-filters (Phase 4)', () => {
  it('parses min/max price and min guests', () => {
    expect(parseListingBrowseFilters({
      min_price: '80',
      max_price: '200',
      min_guests: '3',
    })).toEqual({
      price: { gte: 80, lte: 200 },
      capacity: { gte: 3 },
    });
  });

  it('ignores invalid / empty values', () => {
    expect(parseListingBrowseFilters({})).toEqual({});
    expect(parseListingBrowseFilters({ min_price: 'x', min_guests: '0' })).toEqual({});
  });

  it('treats min_guests <= 1 as a no-op so NULL capacity stays visible', () => {
    expect(parseListingBrowseFilters({ min_guests: '1' })).toEqual({});
    expect(parseListingBrowseFilters({ min_guests: 1 })).toEqual({});
    expect(parseListingBrowseFilters({ min_guests: '2' })).toEqual({ capacity: { gte: 2 } });
  });
});
