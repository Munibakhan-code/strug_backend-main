import { describe, it, expect } from 'vitest';
import {
  RIDE_STATUS_EMAIL_EVENT,
  buildRideStatusEmailVars,
} from '../../utils/ride-status-email.js';

const sampleRide = {
  ride_request_id: 96,
  pickup_address: '55 York St, Toronto',
  drop_address: '2 Inwood Ave, East York',
};

const sampleTrip = { trip_id: 42, request_id: 96 };

describe('buildRideStatusEmailVars', () => {
  it('builds assigned email variables', () => {
    const vars = buildRideStatusEmailVars(RIDE_STATUS_EMAIL_EVENT.ASSIGNED, {
      ride: sampleRide,
      trip: sampleTrip,
      driverName: 'Baqar driver',
      vehicleType: 'Economy',
      plate: 'ABC 123',
      eta: '~5 min',
    });
    expect(vars.status_title).toBe('Driver Assigned');
    expect(vars.status_message).toContain('accepted your ride');
    expect(vars.ride_id_label).toBe('#96');
    expect(vars.trip_id_label).toBe('#42');
    expect(vars.driver_name).toBe('Baqar driver');
    expect(vars.vehicle_type).toBe('Economy');
    expect(vars.plate_number).toBe('ABC 123');
    expect(vars.eta).toBe('~5 min');
    expect(vars.pickup_address).toBe(sampleRide.pickup_address);
    expect(vars.track_url).toMatch(/\/ride$/);
  });

  it('builds arrived email variables', () => {
    const vars = buildRideStatusEmailVars(RIDE_STATUS_EMAIL_EVENT.ARRIVED, {
      ride: sampleRide,
      trip: sampleTrip,
      driverName: 'Baqar driver',
      vehicleType: 'Comfort',
    });
    expect(vars.status_title).toBe('Driver Arrived');
    expect(vars.status_message).toContain('pickup point');
    expect(vars.driver_name).toBe('Baqar driver');
  });

  it('returns null for unknown events', () => {
    expect(buildRideStatusEmailVars('unknown', {})).toBeNull();
  });
});
