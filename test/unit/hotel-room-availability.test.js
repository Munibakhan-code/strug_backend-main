import { describe, it, expect } from 'vitest';
import {
  soldOutNightsForRoomType,
  eachNight,
  checkHotelRoomAvailability,
  computeUnits,
} from '../../services/booking-engine.js';

describe('soldOutNightsForRoomType', () => {
  it('marks nights sold out when used >= quantity', () => {
    const room = { quantity: 1 };
    const bookings = [
      { start_date: '2026-08-03', end_date: '2026-08-05', quantity: 1 },
    ];
    expect(soldOutNightsForRoomType(room, bookings)).toEqual(['2026-08-03', '2026-08-04']);
  });

  it('allows overlapping bookings while used < quantity', () => {
    const room = { quantity: 2 };
    const bookings = [
      { start_date: '2026-08-03', end_date: '2026-08-05', quantity: 1 },
    ];
    expect(soldOutNightsForRoomType(room, bookings)).toEqual([]);
  });

  it('marks nights sold out once two quantity=1 bookings fill quantity=2', () => {
    const room = { quantity: 2 };
    const bookings = [
      { start_date: '2026-08-03', end_date: '2026-08-04', quantity: 1 },
      { start_date: '2026-08-03', end_date: '2026-08-04', quantity: 1 },
    ];
    expect(soldOutNightsForRoomType(room, bookings)).toEqual(['2026-08-03']);
  });
});

describe('eachNight', () => {
  it('uses half-open [start, end)', () => {
    const nights = eachNight('2026-08-03', '2026-08-05');
    expect(nights.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-08-03', '2026-08-04']);
  });
});

describe('checkHotelRoomAvailability', () => {
  it('rejects blocked inventory dates', async () => {
    const roomType = { room_type_id: 1, quantity: 2, nightly_price: 100 };
    const db = {
      hotel_room_inventory: {
        findMany: async () => ([
          { date: new Date('2026-08-01T00:00:00Z'), available: 2, is_blocked: true, price_override: null },
        ]),
      },
      booking: {
        findMany: async () => [],
      },
    };
    const result = await checkHotelRoomAvailability(db, roomType, {
      start_date: '2026-08-01',
      end_date: '2026-08-02',
      quantity: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/blocked/i);
  });

  it('allows booking when capacity remains', async () => {
    const roomType = { room_type_id: 1, quantity: 3, nightly_price: 180 };
    const db = {
      hotel_room_inventory: {
        findMany: async () => ([]),
      },
      booking: {
        findMany: async () => ([
          {
            room_type_id: 1,
            start_date: new Date('2026-08-01T00:00:00Z'),
            end_date: new Date('2026-08-03T00:00:00Z'),
            quantity: 1,
          },
        ]),
      },
    };
    const result = await checkHotelRoomAvailability(db, roomType, {
      start_date: '2026-08-01',
      end_date: '2026-08-03',
      quantity: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(2);
  });
});

describe('computeUnits', () => {
  it('bills wedding multi-day packages as inclusive event days', () => {
    expect(computeUnits('event', { startDate: '2026-08-01', vertical: 'wedding' }).units).toBe(1);
    expect(computeUnits('event', {
      startDate: '2026-08-01',
      endDate: '2026-08-03',
      vertical: 'wedding',
    }).units).toBe(3);
    expect(computeUnits('event', { startDate: '2026-08-01', endDate: '2026-08-01' }).units).toBe(1);
  });
});
