import { describe, it, expect } from 'vitest';
import {
  vendorTypeNamesForAlias,
  findVendorTypeIdsByNames,
  resolveRestaurantVendorTypeId,
  restaurantVendorTypeWhere,
} from '../../utils/vendor-type.js';

describe('vendor-type name lookup', () => {
  it('maps aliases to canonical names', () => {
    expect(vendorTypeNamesForAlias('restaurant')).toEqual(['Restaurant']);
    expect(vendorTypeNamesForAlias('food')).toEqual(['Restaurant']);
    expect(vendorTypeNamesForAlias('Grocery')).toEqual(['Grocery']);
    expect(vendorTypeNamesForAlias('floral')).toEqual(['Floral']);
    expect(vendorTypeNamesForAlias('florist')).toEqual(['Floral']);
    expect(vendorTypeNamesForAlias('flowers')).toEqual(['Floral']);
  });

  it('resolves restaurant ids by name, never assuming id=1', async () => {
    const db = {
      vendor_type: {
        findMany: async ({ where }) => {
          expect(where.OR[0].vendor_type.equals).toBe('Restaurant');
          return [{ vendor_type_id: 42, vendor_type: 'Restaurant' }];
        },
      },
    };
    expect(await findVendorTypeIdsByNames(db, ['Restaurant'])).toEqual([42]);
    expect(await resolveRestaurantVendorTypeId(db)).toBe(42);
    expect(await restaurantVendorTypeWhere(db)).toEqual({
      OR: [{ vendor_type_id: 42 }, { vendor_type_id: null }],
    });
  });
});
