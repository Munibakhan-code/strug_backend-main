import { describe, it, expect } from 'vitest';
import {
  buildPublicPropertyWhere,
  filtersToPropertyQuery,
  describeSavedSearchFilters,
} from '../../utils/property-filters.js';

describe('property-filters', () => {
  it('maps saved filters to query keys', () => {
    expect(filtersToPropertyQuery({
      q: 'condo',
      city: 'Toronto',
      max_price: 800000,
      beds: 2,
      type: 'Condo',
    }, 'realestate')).toEqual({
      vertical: 'realestate',
      q: 'condo',
      city: 'Toronto',
      type: 'Condo',
      max_price: 800000,
      beds: 2,
    });
  });

  it('builds published where with max price and beds', () => {
    const where = buildPublicPropertyWhere({
      vertical: 'preconstruct',
      max_price: 500000,
      beds: 2,
      city: 'Toronto',
    });
    expect(where.is_published).toBe(true);
    expect(where.vertical).toBe('preconstruct');
    expect(where.city).toEqual({ contains: 'Toronto', mode: 'insensitive' });
    expect(where.beds_min).toEqual({ gte: 2 });
    expect(Array.isArray(where.AND)).toBe(true);
  });

  it('describes filters for notifications', () => {
    const label = describeSavedSearchFilters({
      q: 'harbour',
      city: 'Toronto',
      beds: 2,
      max_price: 800000,
    }, 'realestate');
    expect(label).toContain('Real Estate');
    expect(label).toContain('Toronto');
    expect(label).toContain('2+ beds');
  });
});
