import { describe, it, expect } from 'vitest';
import {
  KNOWN_BOOKING_VERTICALS,
  isKnownBookingVertical,
  parseBookingVertical,
  verticalWhereClause,
} from '../../utils/booking-vertical.js';

describe('booking-vertical isolation helpers', () => {
  it('lists known booking-engine verticals including tempstay', () => {
    expect(KNOWN_BOOKING_VERTICALS).toContain('tempstay');
    expect(KNOWN_BOOKING_VERTICALS).toContain('hotel');
    expect(KNOWN_BOOKING_VERTICALS).toContain('vehicle');
    expect(KNOWN_BOOKING_VERTICALS).toContain('wedding');
    expect(isKnownBookingVertical('tempstay')).toBe(true);
    expect(isKnownBookingVertical('not-a-vertical')).toBe(false);
    expect(isKnownBookingVertical('')).toBe(false);
  });

  it('parseBookingVertical accepts known values and null/empty as unscoped', () => {
    expect(parseBookingVertical('tempstay')).toEqual({ ok: true, vertical: 'tempstay' });
    expect(parseBookingVertical('  hotel  ')).toEqual({ ok: true, vertical: 'hotel' });
    expect(parseBookingVertical(null)).toEqual({ ok: true, vertical: null });
    expect(parseBookingVertical('')).toEqual({ ok: true, vertical: null });
  });

  it('parseBookingVertical rejects unknown verticals', () => {
    const bad = parseBookingVertical('ecommerce');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/unknown vertical/i);
  });

  it('verticalWhereClause only adds vertical when set', () => {
    expect(verticalWhereClause(null)).toEqual({});
    expect(verticalWhereClause('tempstay')).toEqual({ vertical: 'tempstay' });
  });

  it('tempstay and hotel scopes never collide in where clauses', () => {
    const stay = verticalWhereClause('tempstay');
    const hotel = verticalWhereClause('hotel');
    expect(stay).not.toEqual(hotel);
    expect(stay.vertical).toBe('tempstay');
    expect(hotel.vertical).toBe('hotel');
  });
});
