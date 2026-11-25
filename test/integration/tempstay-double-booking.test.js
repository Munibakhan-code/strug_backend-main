import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

/**
 * `booking_listing.capacity` means concurrent bookable UNITS to the availability engine, but
 * the tempstay host form labelled it "Max guests" — so a cottage listed for 4 guests accepted
 * four overlapping bookings for the same dates, all returning 201.
 *
 * This drives the real route (advisory lock, transaction, checkAvailability, 409) with two
 * different guests, which is the shape of the production bug. The listing is seeded with
 * `capacity: 4` on purpose: that is what an UN-MIGRATED production row looks like, and the fix
 * keys off the vertical rather than the migrated value so those rows are safe too.
 */
describe('tempstay double-booking', () => {
  let host, guestA, guestB, listing;
  const day = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    await truncateAll();
    host = await createUser({ name: 'Cottage Host' });
    guestA = await createUser({ name: 'Guest A' });
    guestB = await createUser({ name: 'Guest B' });

    listing = await db.booking_listing.create({
      data: {
        vertical: 'tempstay',
        owner_id: host.user_id,
        title: 'Lakeside Cottage',
        price: 100,
        price_unit: 'night',
        is_active: true,
        instant_book: true,
        capacity: 4, // the historical guests-as-units mistake, deliberately un-migrated
      },
    });
  });

  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  it('accepts the first booking', async () => {
    const res = await request(app)
      .post('/booking/bookings')
      .set(authHeader(guestA))
      .send({
        booking_listing_id: listing.booking_listing_id,
        start_date: day(10),
        end_date: day(13),
        quantity: 1,
        payment_method: 'wallet',
      });

    expect(res.status).toBe(201);
  });

  it('rejects a second guest overlapping those dates', async () => {
    const res = await request(app)
      .post('/booking/bookings')
      .set(authHeader(guestB))
      .send({
        booking_listing_id: listing.booking_listing_id,
        start_date: day(11),
        end_date: day(12),
        quantity: 1,
        payment_method: 'wallet',
      });

    expect(res.status).toBe(409);

    // and nothing was written
    const active = await db.booking.count({
      where: {
        booking_listing_id: listing.booking_listing_id,
        status: { in: ['requested', 'awaiting_host', 'confirmed', 'in_progress'] },
      },
    });
    expect(active).toBe(1);
  });

  it('still accepts a non-overlapping booking', async () => {
    const res = await request(app)
      .post('/booking/bookings')
      .set(authHeader(guestB))
      .send({
        booking_listing_id: listing.booking_listing_id,
        start_date: day(13), // checkout day of the first booking — half-open [start, end)
        end_date: day(15),
        quantity: 1,
        payment_method: 'wallet',
      });

    expect(res.status).toBe(201);
  });

  it('pins capacity to 1 and rescues the guest count when a listing is created', async () => {
    const res = await request(app)
      .post('/booking/listings')
      .set(authHeader(host))
      .send({
        vertical: 'tempstay',
        title: 'Second Cottage',
        location: 'Muskoka, ON', // #305 — tempstay/hotel/venue require an address
        price: 120,
        price_unit: 'night',
        capacity: 6, // an older client still posting guests-as-capacity
        attributes: { beds: 3 },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.capacity).toBe(1);
    expect(res.body.data.attributes).toEqual({ beds: 3, max_guests: 6 });
  });

  it('re-pins capacity on update so an older client cannot reopen the hole', async () => {
    const res = await request(app)
      .put(`/booking/listings/${listing.booking_listing_id}`)
      .set(authHeader(host))
      .send({ capacity: 8 });

    expect(res.status).toBe(200);
    expect(res.body.data.capacity).toBe(1);
    expect(res.body.data.attributes).toMatchObject({ max_guests: 8 });
  });

  it('leaves a genuine multi-unit vertical alone', async () => {
    const hotel = await db.booking_listing.create({
      data: {
        vertical: 'hotel',
        owner_id: host.user_id,
        title: 'City Hotel',
        price: 90,
        price_unit: 'night',
        is_active: true,
        capacity: 5, // 5 identical rooms — genuinely units
      },
    });

    const res = await request(app)
      .post('/booking/listings')
      .set(authHeader(host))
      .send({
        vertical: 'hotel',
        title: 'Another Hotel',
        location: 'Toronto, ON',
        price: 90,
        price_unit: 'night',
        capacity: 5,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.capacity).toBe(5); // not pinned
    expect(hotel.capacity).toBe(5);
  });
});
