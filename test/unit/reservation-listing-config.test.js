import { describe, it, expect } from 'vitest';
import {
  validateReservationListingConfig,
  mergeReservationAttributes,
  stripComputedReservationAttributes,
} from '../../utils/reservation-listing-config.js';

describe('reservation listing config validation', () => {
  it('rejects missing party capacity', () => {
    const res = validateReservationListingConfig({
      capacity: null,
      attributes: { tables: 4, turn_time_minutes: 90 },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/party size capacity/i);
  });

  it('rejects capacity = 0 with an accurate message', () => {
    const res = validateReservationListingConfig({
      capacity: 0,
      attributes: { tables: 2, turn_time_minutes: 90 },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/greater than 0/i);
  });

  it('rejects missing concurrent capacity', () => {
    const res = validateReservationListingConfig({
      capacity: 6,
      attributes: { turn_time_minutes: 90 },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/seating_capacity or attributes\.tables/i);
  });

  it('rejects missing turn time', () => {
    const res = validateReservationListingConfig({
      capacity: 6,
      attributes: { tables: 3 },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/turn_time_minutes/i);
  });

  it('accepts a complete configuration', () => {
    const res = validateReservationListingConfig({
      capacity: 8,
      attributes: {
        tables: 4,
        seating_capacity: 24,
        turn_time_minutes: 90,
        time_slots: ['18:00', '19:00'],
        service_hours: { mon: { open: '11:00', close: '22:00' } },
        booked_today: 99,
      },
    });
    expect(res.ok).toBe(true);
    expect(res.capacity).toBe(8);
    expect(res.attributes.booked_today).toBeUndefined();
    expect(res.attributes.tables).toBe(4);
    expect(res.attributes.seating_capacity).toBe(24);
    expect(res.attributes.max_guests).toBe(8);
  });

  it('merges updates without erasing protected attributes or persisting booked_today', () => {
    const merged = mergeReservationAttributes(
      {
        time_slots: ['18:00'],
        food_vendor_id: 12,
        tables: 3,
        turn_time_minutes: 90,
        booked_today: 7,
      },
      {
        description_extra: 'patio',
        booked_today: 99,
        tables: null,
      },
    );
    expect(merged.booked_today).toBeUndefined();
    expect(merged.time_slots).toEqual(['18:00']);
    expect(merged.food_vendor_id).toBe(12);
    expect(merged.tables).toBe(3);
    expect(merged.description_extra).toBe('patio');
  });

  it('strips computed attributes', () => {
    expect(stripComputedReservationAttributes({ booked_today: 3, tables: 2 })).toEqual({ tables: 2 });
  });
});
