import { describe, it, expect, vi } from 'vitest';
import { loadReservationDayContext } from '../../services/booking-engine.js';

describe('loadReservationDayContext date filtering', () => {
  it('queries bookings/blocks with a half-open day range', async () => {
    const findBlocked = vi.fn(async () => []);
    const findBookings = vi.fn(async () => []);
    const db = {
      availability: { findMany: findBlocked },
      booking: { findMany: findBookings },
    };

    await loadReservationDayContext(db, { booking_listing_id: 9 }, '2026-07-21');

    const blockedArg = findBlocked.mock.calls[0][0];
    const bookingArg = findBookings.mock.calls[0][0];
    expect(blockedArg.where.date.gte).toEqual(new Date(Date.UTC(2026, 6, 21)));
    expect(blockedArg.where.date.lt).toEqual(new Date(Date.UTC(2026, 6, 22)));
    expect(bookingArg.where.start_date.gte).toEqual(new Date(Date.UTC(2026, 6, 21)));
    expect(bookingArg.where.start_date.lt).toEqual(new Date(Date.UTC(2026, 6, 22)));
  });
});
