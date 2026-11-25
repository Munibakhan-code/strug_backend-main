import { describe, it, expect } from 'vitest';
import {
  isSingleUnitVertical,
  capacityAttrFor,
  normalizeSingleUnitCapacity,
} from '../../utils/booking-capacity.js';
import { parseListingBrowseFilters } from '../../utils/booking-listing-filters.js';
import { checkAvailability, DATE_RANGE_UNITS } from '../../services/booking-engine.js';

describe('single-unit capacity verticals', () => {
  it('classifies the verticals whose capacity box counts PEOPLE, not inventory', () => {
    expect(isSingleUnitVertical('tempstay')).toBe(true);
    expect(isSingleUnitVertical('vehicle')).toBe(true);
    expect(isSingleUnitVertical('venue')).toBe(true);
    expect(isSingleUnitVertical('wedding')).toBe(true);
    // hotel capacity = "Default rooms available", equipment = copies — genuinely units.
    expect(isSingleUnitVertical('hotel')).toBe(false);
    expect(isSingleUnitVertical('equipment')).toBe(false);
    expect(isSingleUnitVertical(undefined)).toBe(false);
    expect(capacityAttrFor('tempstay')).toBe('max_guests');
    expect(capacityAttrFor('vehicle')).toBe('seats');
    expect(capacityAttrFor('venue')).toBe('max_attendees');
    expect(capacityAttrFor('wedding')).toBe('max_attendees');
  });

  it('pins capacity to 1 and rescues the guest count into attributes', () => {
    expect(normalizeSingleUnitCapacity('tempstay', { capacity: 4 })).toEqual({
      capacity: 1,
      attributes: { max_guests: 4 },
    });
  });

  it('does not overwrite a guest count the client already supplied', () => {
    expect(
      normalizeSingleUnitCapacity('tempstay', { capacity: 4, attributes: { max_guests: 6, beds: 2 } }),
    ).toEqual({ capacity: 1, attributes: { max_guests: 6, beds: 2 } });
  });

  it('merges into the stored attributes when the update omits them', () => {
    const out = normalizeSingleUnitCapacity('tempstay', { capacity: 5 }, { beds: 3 });
    expect(out).toEqual({ capacity: 1, attributes: { beds: 3, max_guests: 5 } });
  });

  it('still pins capacity when the write carries no capacity at all', () => {
    expect(normalizeSingleUnitCapacity('tempstay', {}, { max_guests: 4 })).toEqual({
      capacity: 1,
      attributes: { max_guests: 4 },
    });
  });

  it('does not invent a guest count from capacity 1 or 0', () => {
    expect(normalizeSingleUnitCapacity('tempstay', { capacity: 1 }).attributes).toEqual({});
    expect(normalizeSingleUnitCapacity('tempstay', { capacity: 0 }).attributes).toEqual({});
  });

  it('leaves multi-unit verticals alone', () => {
    expect(normalizeSingleUnitCapacity('hotel', { capacity: 12 })).toBeNull();
  });
});

describe('min_guests browse filter', () => {
  it('filters the attributes people-count for single-unit verticals', () => {
    expect(parseListingBrowseFilters({ min_guests: '4' }, 'tempstay')).toEqual({
      attributes: { path: ['max_guests'], gte: 4 },
    });
    expect(parseListingBrowseFilters({ min_guests: '5' }, 'vehicle')).toEqual({
      attributes: { path: ['seats'], gte: 5 },
    });
    expect(parseListingBrowseFilters({ min_guests: '80' }, 'venue')).toEqual({
      attributes: { path: ['max_attendees'], gte: 80 },
    });
  });

  it('still filters the capacity column for genuine multi-unit verticals', () => {
    expect(parseListingBrowseFilters({ min_guests: '3' }, 'hotel')).toEqual({
      capacity: { gte: 3 },
    });
    expect(parseListingBrowseFilters({ min_guests: '3' })).toEqual({ capacity: { gte: 3 } });
  });

  it('treats min_guests <= 1 as a no-op so NULL rows are not hidden', () => {
    expect(parseListingBrowseFilters({ min_guests: '1' }, 'tempstay')).toEqual({});
  });
});

describe('checkAvailability for a single-unit vertical', () => {
  const listing = {
    booking_listing_id: 7,
    vertical: 'tempstay',
    price_unit: 'night',
    capacity: 4, // the historical guests-as-units mistake, un-migrated
  };

  // Minimal Prisma stand-in: one active booking already covering Aug 1-4.
  const db = {
    availability: { findMany: async () => [] },
    booking: {
      findMany: async () => [
        { start_date: new Date('2026-08-01'), end_date: new Date('2026-08-04'), quantity: 1, status: 'confirmed' },
      ],
    },
  };

  it('rejects a second overlapping stay even when capacity says 4', async () => {
    expect(DATE_RANGE_UNITS.has('night')).toBe(true);
    const res = await checkAvailability(db, listing, {
      start_date: new Date('2026-08-02'),
      end_date: new Date('2026-08-03'),
      quantity: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/fully booked/i);
  });

  it('still allows a non-overlapping stay', async () => {
    const res = await checkAvailability(db, listing, {
      start_date: new Date('2026-08-04'),
      end_date: new Date('2026-08-06'),
      quantity: 1,
    });
    expect(res.ok).toBe(true);
  });

  it('leaves a genuine multi-unit hotel listing bookable up to capacity', async () => {
    const res = await checkAvailability(
      db,
      { ...listing, vertical: 'hotel' },
      { start_date: new Date('2026-08-02'), end_date: new Date('2026-08-03'), quantity: 1 },
    );
    expect(res.ok).toBe(true);
  });
});

describe('checkAvailability for venue (price_unit event)', () => {
  const listing = {
    booking_listing_id: 11,
    vertical: 'venue',
    price_unit: 'event',
    capacity: 200, // historical attendees-as-units mistake, un-migrated
  };

  const db = {
    availability: { findMany: async () => [] },
    booking: {
      findMany: async () => [
        { start_date: new Date('2026-09-10'), quantity: 1, status: 'confirmed' },
      ],
    },
  };

  it('rejects a second same-day event booking even when capacity says 200', async () => {
    const res = await checkAvailability(db, listing, {
      start_date: new Date('2026-09-10'),
      quantity: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/fully booked/i);
  });

  it('still allows a different date', async () => {
    const res = await checkAvailability(db, listing, {
      start_date: new Date('2026-09-11'),
      quantity: 1,
    });
    expect(res.ok).toBe(true);
  });

  it('still uses multi-unit capacity for non-venue event listings', async () => {
    const res = await checkAvailability(
      db,
      { ...listing, vertical: 'experience' },
      { start_date: new Date('2026-09-10'), quantity: 1 },
    );
    expect(res.ok).toBe(true);
  });

  it('pins venue normalize and rescues attendees into attributes', () => {
    expect(normalizeSingleUnitCapacity('venue', { capacity: 150 })).toEqual({
      capacity: 1,
      attributes: { max_attendees: 150 },
    });
  });

  it('pins wedding normalize and rescues attendees into attributes', () => {
    expect(normalizeSingleUnitCapacity('wedding', { capacity: 200 })).toEqual({
      capacity: 1,
      attributes: { max_attendees: 200 },
    });
  });
});

describe('validatePartySize', () => {
  it('rejects wedding guests above max_attendees', async () => {
    const { validatePartySize } = await import('../../utils/booking-capacity.js');
    expect(validatePartySize(
      { vertical: 'wedding', attributes: { max_attendees: 100 } },
      150,
    )).toMatch(/up to 100/i);
  });

  it('allows wedding guests within max_attendees', async () => {
    const { validatePartySize } = await import('../../utils/booking-capacity.js');
    expect(validatePartySize(
      { vertical: 'wedding', attributes: { max_attendees: 100 } },
      80,
    )).toBeNull();
  });

  it('ignores verticals without a people-capacity attribute', async () => {
    const { validatePartySize } = await import('../../utils/booking-capacity.js');
    expect(validatePartySize({ vertical: 'equipment', capacity: 4 }, 99)).toBeNull();
  });
});

describe('checkAvailability for wedding (price_unit event)', () => {
  const listing = {
    booking_listing_id: 21,
    vertical: 'wedding',
    price_unit: 'event',
    capacity: 200,
  };

  const db = {
    availability: { findMany: async () => [] },
    booking: {
      findMany: async () => [
        { start_date: new Date('2026-10-10'), quantity: 1, status: 'confirmed' },
      ],
    },
  };

  it('rejects a second same-day wedding booking even when capacity says 200', async () => {
    const res = await checkAvailability(db, listing, {
      start_date: new Date('2026-10-10'),
      quantity: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/fully booked/i);
  });
});

describe('checkAvailability venue blocked dates (continued)', () => {
  const listing = {
    booking_listing_id: 11,
    vertical: 'venue',
    price_unit: 'event',
    capacity: 200,
  };

  it('rejects an event booking on a host-blocked date', async () => {
    const blockedDb = {
      availability: {
        findMany: async () => [
          { date: new Date('2026-09-12'), is_blocked: true },
        ],
      },
      booking: { findMany: async () => [] },
    };
    const res = await checkAvailability(blockedDb, listing, {
      start_date: new Date('2026-09-12'),
      quantity: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/blocked/i);
  });

  it('allows an event booking when the blocked date is a different day', async () => {
    const blockedDb = {
      availability: {
        findMany: async () => [
          { date: new Date('2026-09-12'), is_blocked: true },
        ],
      },
      booking: { findMany: async () => [] },
    };
    const res = await checkAvailability(blockedDb, listing, {
      start_date: new Date('2026-09-13'),
      quantity: 1,
    });
    expect(res.ok).toBe(true);
  });
});

describe('checkAvailability for medical (appointment-style session)', () => {
  const listing = {
    booking_listing_id: 22,
    vertical: 'medical',
    price_unit: 'session',
    capacity: 1,
  };
  const db = {
    availability: { findMany: async () => [] },
    booking: {
      findMany: async () => [
        { start_date: new Date('2026-09-10'), start_time: '09:00', end_time: '10:00', quantity: 1, status: 'confirmed' },
      ],
    },
  };

  it('allows a later slot the same day', async () => {
    const res = await checkAvailability(db, listing, {
      start_date: new Date('2026-09-10'),
      start_time: '14:00',
      quantity: 1,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects an overlapping slot', async () => {
    const res = await checkAvailability(db, listing, {
      start_date: new Date('2026-09-10'),
      start_time: '09:30',
      quantity: 1,
    });
    expect(res.ok).toBe(false);
  });

  it('allows the next 30-minute medical slot when the booking has no end_time', async () => {
    const shortDb = {
      availability: { findMany: async () => [] },
      booking: {
        findMany: async () => [
          { start_date: new Date('2026-09-10'), start_time: '09:00', end_time: null, quantity: 1, status: 'confirmed' },
        ],
      },
    };
    const res = await checkAvailability(shortDb, listing, {
      start_date: new Date('2026-09-10'),
      start_time: '09:30',
      quantity: 1,
    });
    expect(res.ok).toBe(true);
  });
});
