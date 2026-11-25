import { describe, it, expect } from 'vitest';
import {
  resolveReservationEndTime,
  resolveReservationQuantity,
  partySizeFromBookingLike,
  formatReservationSlotLabel,
  candidateReservationSlots,
  addMinutesToTime,
  DEFAULT_RESERVATION_TURN_MINUTES,
  resolveReservationMaxParty,
  evaluateAvailability,
} from '../../services/booking-engine.js';

describe('reservation availability helpers', () => {
  it('resolves end_time from 90-minute turn', () => {
    expect(resolveReservationEndTime('19:00', null)).toBe('20:30');
    expect(resolveReservationEndTime('19:00', '21:00')).toBe('21:00');
    expect(DEFAULT_RESERVATION_TURN_MINUTES).toBe(90);
  });

  it('maps guests to quantity when quantity omitted', () => {
    expect(resolveReservationQuantity({ guests: 4 })).toBe(4);
    expect(resolveReservationQuantity({ quantity: 2, guests: 4 })).toBe(2);
    expect(resolveReservationQuantity({})).toBe(1);
  });

  it('prefers guests over default quantity=1 for legacy rows', () => {
    expect(partySizeFromBookingLike({ quantity: 1, guests: 6 })).toBe(6);
    expect(partySizeFromBookingLike({ quantity: 3, guests: 6 })).toBe(3);
  });

  it('formats 12h labels', () => {
    expect(formatReservationSlotLabel('11:30')).toBe('11:30 AM');
    expect(formatReservationSlotLabel('19:00')).toBe('7:00 PM');
  });

  it('uses custom attributes.time_slots when present', () => {
    const slots = candidateReservationSlots({
      attributes: { time_slots: ['18:00', '6:30 PM', '19:00'] },
    });
    expect(slots).toEqual(['18:00', '18:30', '19:00']);
  });

  it('adds minutes across hour boundaries', () => {
    expect(addMinutesToTime('23:30', 90)).toBe('01:00');
  });
});

describe('reservation capacity validation', () => {
  it('rejects listings without configured party capacity', () => {
    const listing = { vertical: 'reservation', capacity: null, attributes: {} };
    expect(resolveReservationMaxParty(listing)).toEqual({
      ok: false,
      reason: 'Reservation party size capacity must be configured for this listing',
    });
  });

  it('rejects capacity = 0 with an accurate message', () => {
    expect(resolveReservationMaxParty({ vertical: 'reservation', capacity: 0 })).toEqual({
      ok: false,
      reason: 'Reservation party size capacity must be greater than 0',
    });
  });

  it('accepts listing.capacity as max party size', () => {
    expect(resolveReservationMaxParty({ vertical: 'reservation', capacity: 8 })).toEqual({
      ok: true,
      maxParty: 8,
    });
  });

  it('falls back to attributes.max_guests when capacity is unset', () => {
    expect(resolveReservationMaxParty({
      vertical: 'reservation',
      capacity: null,
      attributes: { max_guests: 6 },
    })).toEqual({ ok: true, maxParty: 6 });
  });
});

describe('evaluateAvailability (in-memory)', () => {
  const listing = {
    vertical: 'reservation',
    price_unit: 'session',
    capacity: 8,
    attributes: { tables: 1 },
  };
  const date = '2026-07-21';

  it('marks a slot unavailable when capacity is not configured', () => {
    const result = evaluateAvailability(
      { ...listing, capacity: null, attributes: {} },
      { start_date: date, start_time: '19:00', end_time: '20:30', quantity: 2 },
      { blocked: [], existing: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('capacity must be configured');
  });

  it('allows concurrent reservations up to configured seating capacity', () => {
    const multi = {
      ...listing,
      attributes: { seating_capacity: 10, turn_time_minutes: 90 },
    };
    const first = evaluateAvailability(
      multi,
      { start_date: date, start_time: '19:00', end_time: '20:30', quantity: 4 },
      { blocked: [], existing: [] },
    );
    expect(first.ok).toBe(true);

    const second = evaluateAvailability(
      multi,
      { start_date: date, start_time: '19:00', end_time: '20:30', quantity: 4 },
      {
        blocked: [],
        existing: [{
          start_date: new Date(`${date}T00:00:00.000Z`),
          start_time: '19:00',
          end_time: '20:30',
          quantity: 4,
          status: 'confirmed',
        }],
      },
    );
    expect(second.ok).toBe(true);

    const third = evaluateAvailability(
      multi,
      { start_date: date, start_time: '19:00', end_time: '20:30', quantity: 3 },
      {
        blocked: [],
        existing: [
          {
            start_date: new Date(`${date}T00:00:00.000Z`),
            start_time: '19:00',
            end_time: '20:30',
            quantity: 4,
            status: 'confirmed',
          },
          {
            start_date: new Date(`${date}T00:00:00.000Z`),
            start_time: '19:30',
            end_time: '21:00',
            quantity: 4,
            status: 'confirmed',
          },
        ],
      },
    );
    expect(third.ok).toBe(false);
    expect(third.reason).toMatch(/seat/i);
  });

  it('keeps tables as concurrent parties when seating_capacity is also set', () => {
    // Reviewer Issue 1 regression: seating must not replace tables.
    // tables=10 + seating=4 + one party of 2 → second party of 2 still fits.
    const maple = {
      ...listing,
      capacity: 6,
      attributes: { tables: 10, seating_capacity: 4, turn_time_minutes: 90 },
    };
    const afterOne = evaluateAvailability(
      maple,
      { start_date: date, start_time: '17:00', end_time: '18:30', quantity: 2 },
      {
        blocked: [],
        existing: [{
          start_date: new Date(`${date}T00:00:00.000Z`),
          start_time: '17:00',
          end_time: '18:30',
          quantity: 2,
          guests: 2,
          status: 'confirmed',
        }],
      },
    );
    expect(afterOne.ok).toBe(true);

    const afterTwoParties = evaluateAvailability(
      maple,
      { start_date: date, start_time: '17:00', end_time: '18:30', quantity: 2 },
      {
        blocked: [],
        existing: [
          {
            start_date: new Date(`${date}T00:00:00.000Z`),
            start_time: '17:00',
            end_time: '18:30',
            quantity: 2,
            status: 'confirmed',
          },
          {
            start_date: new Date(`${date}T00:00:00.000Z`),
            start_time: '17:30',
            end_time: '19:00',
            quantity: 2,
            status: 'confirmed',
          },
        ],
      },
    );
    expect(afterTwoParties.ok).toBe(false);
    expect(afterTwoParties.reason).toMatch(/fully booked|seat/i);
  });

  it('allows many concurrent parties when only tables are configured', () => {
    const multiTable = {
      ...listing,
      attributes: { tables: 5, turn_time_minutes: 90 },
    };
    const existing = Array.from({ length: 4 }, (_, i) => ({
      start_date: new Date(`${date}T00:00:00.000Z`),
      start_time: '19:00',
      end_time: '20:30',
      quantity: 2,
      status: 'confirmed',
      booking_id: i + 1,
    }));
    const fifth = evaluateAvailability(
      multiTable,
      { start_date: date, start_time: '19:00', end_time: '20:30', quantity: 2 },
      { blocked: [], existing },
    );
    expect(fifth.ok).toBe(true);

    const sixth = evaluateAvailability(
      multiTable,
      { start_date: date, start_time: '19:00', end_time: '20:30', quantity: 2 },
      {
        blocked: [],
        existing: [
          ...existing,
          {
            start_date: new Date(`${date}T00:00:00.000Z`),
            start_time: '19:00',
            end_time: '20:30',
            quantity: 2,
            status: 'confirmed',
          },
        ],
      },
    );
    expect(sixth.ok).toBe(false);
    expect(sixth.reason).toMatch(/fully booked/i);
  });

  it('detects overlap for turns that cross midnight', () => {
    const late = {
      ...listing,
      attributes: { tables: 1, turn_time_minutes: 90 },
    };
    const result = evaluateAvailability(
      late,
      { start_date: date, start_time: '23:30', end_time: '01:00', quantity: 2 },
      {
        blocked: [],
        existing: [{
          start_date: new Date(`${date}T00:00:00.000Z`),
          start_time: '23:00',
          end_time: '00:30',
          quantity: 2,
          status: 'confirmed',
        }],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fully booked/i);
  });

  it('marks a slot unavailable when a table is already booked for that window', () => {
    const result = evaluateAvailability(
      listing,
      { start_date: date, start_time: '19:00', end_time: '20:30', quantity: 2 },
      {
        blocked: [],
        existing: [{
          start_date: new Date(`${date}T00:00:00.000Z`),
          start_time: '19:00',
          end_time: '20:30',
          quantity: 2,
          status: 'confirmed',
        }],
      },
    );
    expect(result).toEqual({ ok: false, reason: 'That time slot is fully booked' });
  });

  it('marks a slot unavailable when the host blocked that time window', () => {
    const result = evaluateAvailability(
      listing,
      { start_date: date, start_time: '19:00', end_time: '20:30', quantity: 2 },
      {
        blocked: [{
          date: new Date(`${date}T00:00:00.000Z`),
          time_from: '18:00',
          time_to: '21:00',
          is_blocked: true,
        }],
        existing: [],
      },
    );
    expect(result).toEqual({ ok: false, reason: 'Host has blocked the selected time slot' });
  });
});
