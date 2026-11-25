import { describe, it, expect } from 'vitest';
import { driverOfferCloseReason } from '../../utils/ride-dispatch.js';

describe('driverOfferCloseReason', () => {
  it('maps passenger cancel to driver-facing reason', () => {
    expect(driverOfferCloseReason('cancelled_by_passenger')).toBe('cancelled_by_passenger');
  });

  it('keeps generic close reason for system cancels', () => {
    expect(driverOfferCloseReason('no_driver_found')).toBe('no_longer_available');
    expect(driverOfferCloseReason('all_drivers_declined')).toBe('no_longer_available');
  });
});
