import { describe, it, expect } from 'vitest';
import {
  RIDE_STATUS,
  normalizeRideStatus,
  rideTransitionError,
  assertCanAcceptRide,
  assertCanCancelRide,
  assertCanModifyRide,
  assertCanVerifyOtp,
  assertCanCompleteTrip,
} from '../../utils/ride-state-machine.js';

describe('normalizeRideStatus', () => {
  it('lowercases', () => {
    expect(normalizeRideStatus('ACCEPTED')).toBe('accepted');
    expect(normalizeRideStatus('Ongoing')).toBe('ongoing');
  });
  it('maps nullish to empty string', () => {
    expect(normalizeRideStatus(null)).toBe('');
    expect(normalizeRideStatus(undefined)).toBe('');
  });
});

describe('rideTransitionError', () => {
  it('409 for cancelled / completed / accepted / ongoing with a tailored message', () => {
    expect(rideTransitionError('cancelled', 'accept'))
      .toEqual({ status: 409, message: 'Cannot accept — ride was cancelled.' });
    expect(rideTransitionError('completed', 'accept'))
      .toEqual({ status: 409, message: 'Cannot accept — ride is already completed.' });
    expect(rideTransitionError('accepted', 'accept'))
      .toEqual({ status: 409, message: 'Cannot accept — ride is already accepted.' });
    expect(rideTransitionError('ongoing', 'modify'))
      .toEqual({ status: 409, message: 'Cannot modify — ride is already ongoing.' });
  });
  it('400 for pending / unknown states', () => {
    expect(rideTransitionError('pending', 'accept'))
      .toEqual({ status: 400, message: 'Cannot accept in current ride state.' });
    expect(rideTransitionError('whatever', 'accept'))
      .toEqual({ status: 400, message: 'Cannot accept in current ride state.' });
  });
});

describe('assertCanAcceptRide', () => {
  it('null on a pending ride (the only acceptable state)', () => {
    expect(assertCanAcceptRide({ status: RIDE_STATUS.PENDING })).toBeNull();
    expect(assertCanAcceptRide({ status: 'PENDING' })).toBeNull();
  });
  it('404 when the ride is missing', () => {
    expect(assertCanAcceptRide(null)).toEqual({ status: 404, message: 'Ride not found' });
  });
  it('409 for already-accepted / ongoing / completed / cancelled', () => {
    expect(assertCanAcceptRide({ status: 'accepted' }).status).toBe(409);
    expect(assertCanAcceptRide({ status: 'ongoing' }).status).toBe(409);
    expect(assertCanAcceptRide({ status: 'completed' }).status).toBe(409);
    expect(assertCanAcceptRide({ status: 'cancelled' }).status).toBe(409);
  });
});

describe('assertCanCancelRide', () => {
  it('null for pending or accepted (cancellable)', () => {
    expect(assertCanCancelRide({ status: 'pending' })).toBeNull();
    expect(assertCanCancelRide({ status: 'accepted' })).toBeNull();
  });
  it('404 when missing', () => {
    expect(assertCanCancelRide(null)).toEqual({ status: 404, message: 'Ride request not found' });
  });
  it('400 when already cancelled', () => {
    expect(assertCanCancelRide({ status: 'cancelled' }))
      .toEqual({ status: 400, message: 'Ride is already cancelled' });
  });
  it('400 when ongoing or completed', () => {
    expect(assertCanCancelRide({ status: 'ongoing' }))
      .toEqual({ status: 400, message: 'Cannot cancel an ongoing or completed ride' });
    expect(assertCanCancelRide({ status: 'completed' }))
      .toEqual({ status: 400, message: 'Cannot cancel an ongoing or completed ride' });
  });
});

describe('assertCanModifyRide', () => {
  it('null only when pending', () => {
    expect(assertCanModifyRide({ status: 'pending' })).toBeNull();
  });
  it('404 when missing', () => {
    expect(assertCanModifyRide(null)).toEqual({ status: 404, message: 'Ride request not found' });
  });
  it('409 for terminal states (completed / cancelled)', () => {
    expect(assertCanModifyRide({ status: 'completed' }).status).toBe(409);
    expect(assertCanModifyRide({ status: 'cancelled' }).status).toBe(409);
  });
  it('400 once accepted/ongoing (no longer modifiable)', () => {
    expect(assertCanModifyRide({ status: 'accepted' }))
      .toEqual({ status: 400, message: 'Cannot modify ride after it has been accepted' });
    expect(assertCanModifyRide({ status: 'ongoing' }))
      .toEqual({ status: 400, message: 'Cannot modify ride after it has been accepted' });
  });
});

describe('assertCanVerifyOtp', () => {
  it('404 when ride or trip is missing', () => {
    expect(assertCanVerifyOtp(null, { otp_code: '1234' }))
      .toEqual({ status: 404, message: 'Ride request not found' });
    expect(assertCanVerifyOtp({ status: 'accepted' }, null))
      .toEqual({ status: 404, message: 'Trip not found' });
  });
  it('null when accepted and an OTP is set (the happy path)', () => {
    expect(assertCanVerifyOtp({ status: 'accepted' }, { otp_code: '1234' })).toBeNull();
  });
  it('null when ongoing with the OTP already consumed (idempotent restart)', () => {
    expect(assertCanVerifyOtp({ status: 'ongoing' }, { otp_code: null })).toBeNull();
  });
  it('400 when accepted but the OTP was already used / unset', () => {
    expect(assertCanVerifyOtp({ status: 'accepted' }, { otp_code: null }))
      .toEqual({ status: 400, message: 'OTP already used or not set' });
  });
  it('409 for terminal rides', () => {
    expect(assertCanVerifyOtp({ status: 'completed' }, { otp_code: '1234' }).status).toBe(409);
    expect(assertCanVerifyOtp({ status: 'cancelled' }, { otp_code: '1234' }).status).toBe(409);
  });
  it('400 when not yet accepted (still pending)', () => {
    expect(assertCanVerifyOtp({ status: 'pending' }, { otp_code: '1234' }))
      .toEqual({ status: 400, message: 'Ride must be accepted before verifying OTP' });
  });
});

describe('assertCanCompleteTrip', () => {
  it('404 when the trip is missing', () => {
    expect(assertCanCompleteTrip({ status: 'ongoing' }, null))
      .toEqual({ status: 404, message: 'Trip not found' });
  });
  it('null (idempotent) when the trip already ended, regardless of ride state', () => {
    expect(assertCanCompleteTrip({ status: 'cancelled' }, { ended_at: new Date() })).toBeNull();
    expect(assertCanCompleteTrip(null, { ended_at: new Date() })).toBeNull();
  });
  it('400 when the trip is open but the ride is missing', () => {
    expect(assertCanCompleteTrip(null, { ended_at: null }))
      .toEqual({ status: 400, message: 'Ride request not found' });
  });
  it('null when accepted / ongoing / completed', () => {
    expect(assertCanCompleteTrip({ status: 'accepted' }, { ended_at: null })).toBeNull();
    expect(assertCanCompleteTrip({ status: 'ongoing' }, { ended_at: null })).toBeNull();
    expect(assertCanCompleteTrip({ status: 'completed' }, { ended_at: null })).toBeNull();
  });
  it('409 when the ride was cancelled', () => {
    expect(assertCanCompleteTrip({ status: 'cancelled' }, { ended_at: null }).status).toBe(409);
  });
  it('400 when the ride is still pending', () => {
    expect(assertCanCompleteTrip({ status: 'pending' }, { ended_at: null }))
      .toEqual({ status: 400, message: 'Ride cannot be completed in current state' });
  });
});
