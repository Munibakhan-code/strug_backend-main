import { describe, it, expect, vi } from 'vitest';
import { checkAvailability } from '../../services/booking-engine.js';

function mockDb({ blocked = [], booked = [] } = {}) {
  return {
    availability: {
      findMany: vi.fn(async () => blocked),
    },
    booking: {
      findMany: vi.fn(async () => booked),
    },
  };
}

describe('vehicle capacity is concurrent units, not seats', () => {
  it('rejects a second overlapping vehicle rental even when capacity was stored as seats', async () => {
    const db = mockDb({
      booked: [{
        start_date: '2026-08-01',
        end_date: '2026-08-04',
        quantity: 1,
        status: 'confirmed',
      }],
    });
    const listing = {
      booking_listing_id: 42,
      vertical: 'vehicle',
      price_unit: 'day',
      capacity: 5, // historical seats mistake
    };
    const result = await checkAvailability(db, listing, {
      start_date: '2026-08-01',
      end_date: '2026-08-04',
      quantity: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fully booked/i);
  });

  it('allows a non-overlapping vehicle rental', async () => {
    const db = mockDb({
      booked: [{
        start_date: '2026-08-01',
        end_date: '2026-08-04',
        quantity: 1,
        status: 'confirmed',
      }],
    });
    const listing = {
      booking_listing_id: 42,
      vertical: 'vehicle',
      price_unit: 'day',
      capacity: 5,
    };
    const result = await checkAvailability(db, listing, {
      start_date: '2026-08-04',
      end_date: '2026-08-06',
      quantity: 1,
    });
    expect(result.ok).toBe(true);
  });

  it('still uses multi-unit capacity for non-vehicle day rentals', async () => {
    const db = mockDb({
      booked: [{
        start_date: '2026-08-01',
        end_date: '2026-08-04',
        quantity: 1,
        status: 'confirmed',
      }],
    });
    const listing = {
      booking_listing_id: 9,
      vertical: 'equipment',
      price_unit: 'day',
      capacity: 5,
    };
    const result = await checkAvailability(db, listing, {
      start_date: '2026-08-01',
      end_date: '2026-08-04',
      quantity: 1,
    });
    expect(result.ok).toBe(true);
  });
});
