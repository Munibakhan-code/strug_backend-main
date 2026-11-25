import { describe, it, expect } from 'vitest';
import {
  bookingRequiresPayment,
  isPrepaidCardStay,
  isHostVisibleBooking,
  filterHostVisibleBookings,
  hostCanActOnPaidStay,
  shouldNotifyHostOfNewBooking,
  shouldNotifyCounterpartyOfCancel,
} from '../../services/booking-engine.js';

describe('booking host visibility (card create-then-pay)', () => {
  it('requires payment only when total is positive', () => {
    expect(bookingRequiresPayment({ total: 180 })).toBe(true);
    expect(bookingRequiresPayment({ total: 0 })).toBe(false);
  });

  it('detects card holds via payment_method or payment_intent_id', () => {
    expect(isPrepaidCardStay({ payment_method: 'card' })).toBe(true);
    expect(isPrepaidCardStay({ payment_intent_id: 'pi_abc' })).toBe(true);
    expect(isPrepaidCardStay({ payment_method: null, total: 90 })).toBe(false);
  });

  it('hides unpaid card stays from the host and blocks accept until paid', () => {
    const unpaid = { total: 220, payment_method: 'card', payment_status: 'unpaid' };
    const processing = { ...unpaid, payment_status: 'processing', payment_intent_id: 'pi_1' };
    const paid = { ...unpaid, payment_status: 'paid' };
    expect(isHostVisibleBooking(unpaid)).toBe(false);
    expect(isHostVisibleBooking(processing)).toBe(false);
    expect(isHostVisibleBooking(paid)).toBe(true);
    expect(hostCanActOnPaidStay(unpaid)).toBe(false);
    expect(hostCanActOnPaidStay(paid)).toBe(true);
    expect(shouldNotifyHostOfNewBooking(unpaid)).toBe(false);
    expect(shouldNotifyHostOfNewBooking(paid)).toBe(true);
  });

  it('keeps restaurant / non-card unpaid requests visible and acceptable', () => {
    const table = { total: 40, payment_method: null, payment_status: 'unpaid' };
    expect(isHostVisibleBooking(table)).toBe(true);
    expect(hostCanActOnPaidStay(table)).toBe(true);
    expect(shouldNotifyHostOfNewBooking(table)).toBe(true);
    expect(shouldNotifyCounterpartyOfCancel(table, false)).toBe(true);
  });

  it('does not ping the host when a guest cancels an unpaid card hold', () => {
    const unpaidCard = { total: 180, payment_method: 'card', payment_status: 'unpaid' };
    expect(shouldNotifyCounterpartyOfCancel(unpaidCard, false)).toBe(false);
    expect(shouldNotifyCounterpartyOfCancel(unpaidCard, true)).toBe(true);
  });

  it('filters host lists without dropping paid or non-card rows', () => {
    const rows = [
      { booking_id: 1, total: 180, payment_method: 'card', payment_status: 'unpaid' },
      { booking_id: 2, total: 180, payment_method: 'card', payment_status: 'paid' },
      { booking_id: 3, total: 40, payment_method: null, payment_status: 'unpaid' },
    ];
    expect(filterHostVisibleBookings(rows).map((r) => r.booking_id)).toEqual([2, 3]);
  });
});
