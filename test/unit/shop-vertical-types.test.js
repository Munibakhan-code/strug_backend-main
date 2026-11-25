import { describe, it, expect, vi } from 'vitest';
import {
  VERTICAL_PRODUCT_TYPE,
  VERTICAL_PRODUCT_TYPE_NAMES,
  NON_PRODUCT_LISTING_TYPE_NAMES,
  isKnownVerticalProductType,
  isNonProductListingTypeName,
  resolveProductTypeIdForListing,
} from '../../utils/shop-vertical-types.js';

describe('shop-vertical-types', () => {
  it('lists only real product_listing verticals', () => {
    expect(VERTICAL_PRODUCT_TYPE.decor).toBe('Decor');
    expect(VERTICAL_PRODUCT_TYPE.secondhand).toBe('SecondHand');
    expect(VERTICAL_PRODUCT_TYPE_NAMES).toEqual(
      expect.arrayContaining(['Shop', 'SecondHand', 'Wedding', 'Decor']),
    );
    expect(VERTICAL_PRODUCT_TYPE_NAMES).toHaveLength(4);
    expect(VERTICAL_PRODUCT_TYPE.books).toBeUndefined();
    expect(VERTICAL_PRODUCT_TYPE.discounts).toBeUndefined();
  });

  it('recognizes known types case-insensitively', () => {
    expect(isKnownVerticalProductType('decor')).toBe(true);
    expect(isKnownVerticalProductType('SecondHand')).toBe(true);
    expect(isKnownVerticalProductType('Unknown')).toBe(false);
  });

  it('flags dg-content / discounts labels as non-listing types', () => {
    expect(isNonProductListingTypeName('Books')).toBe(true);
    expect(isNonProductListingTypeName('digitalproducts')).toBe(true);
    expect(isNonProductListingTypeName('Discounts')).toBe(true);
    expect(isNonProductListingTypeName('Decor')).toBe(false);
    expect(NON_PRODUCT_LISTING_TYPE_NAMES).toContain('Books');
  });
});

describe('resolveProductTypeIdForListing', () => {
  it('rejects Books / DigitalProducts / Discounts', async () => {
    const prisma = { product_type: { findFirst: vi.fn(), create: vi.fn() } };
    const res = await resolveProductTypeIdForListing(prisma, {
      product_type_name: 'Books',
    });
    expect(res.status).toBe(400);
    expect(prisma.product_type.create).not.toHaveBeenCalled();
  });

  it('reuses an existing custom category without minting', async () => {
    const prisma = {
      product_type: {
        findFirst: vi.fn().mockResolvedValue({
          product_type_id: 1,
          product_type_name: 'Clothing',
        }),
        create: vi.fn(),
      },
    };
    const res = await resolveProductTypeIdForListing(prisma, {
      product_type_name: 'Clothing',
    });
    expect(res).toEqual({ product_type_id: 1 });
    expect(prisma.product_type.create).not.toHaveBeenCalled();
  });

  it('auto-mints only known vertical types when missing', async () => {
    const prisma = {
      product_type: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          product_type_id: 77,
          product_type_name: 'Decor',
        }),
      },
    };
    const res = await resolveProductTypeIdForListing(prisma, {
      product_type_name: 'Decor',
    });
    expect(res).toEqual({ product_type_id: 77 });
    expect(prisma.product_type.create).toHaveBeenCalledOnce();
  });

  it('rejects unknown typo names instead of silent mint', async () => {
    const prisma = {
      product_type: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
    };
    const res = await resolveProductTypeIdForListing(prisma, {
      product_type_name: 'SecndHand',
    });
    expect(res.status).toBe(400);
    expect(prisma.product_type.create).not.toHaveBeenCalled();
  });
});
