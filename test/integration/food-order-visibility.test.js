import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

/**
 * GET /food/orders/:id used to be unauthenticated, and the public vendor routes embedded whole
 * food_order rows. Between them, an anonymous caller could walk sequential order ids (or just
 * read GET /food/vendors) and harvest every customer's delivery address plus the otp_code that
 * authorises handover. These tests pin both surfaces shut.
 */
describe('food order visibility', () => {
  let customer;
  let vendorOwner;
  let driverUser;
  let outsider;
  let vendor;
  let order;

  beforeAll(async () => {
    await truncateAll();

    customer = await createUser({ name: 'Order Customer' });
    vendorOwner = await createUser({ name: 'Vendor Owner' });
    driverUser = await createUser({ name: 'Assigned Driver' });
    outsider = await createUser({ name: 'Unrelated User' });

    const vendorType = await db.vendor_type.create({ data: { vendor_type: 'Restaurant' } });

    vendor = await db.food_vendor.create({
      data: {
        owner_id: vendorOwner.user_id,
        vendor_name: 'Leak Test Kitchen',
        vendor_type_id: vendorType.vendor_type_id,
        is_active: true,
        is_paused: false,
      },
    });

    const driver = await db.driver_profile.create({
      data: {
        user_id: driverUser.user_id,
        is_online: true,
        accepts_food: true,
        driver_delivery_profile: { create: {} },
      },
    });

    order = await db.food_order.create({
      data: {
        user_id: customer.user_id,
        vendor_id: vendor.vendor_id,
        driver_id: driver.driver_profile_id,
        vendor_type_id: vendorType.vendor_type_id,
        total_amount: 42.5,
        order_status: 'confirmed',
        ispaid: true,
        otp_code: '1234',
        deliver_location: '221B Baker Street',
        delivery_instructions: 'Ring twice',
      },
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it('rejects an anonymous read of an order', async () => {
    const res = await request(app).get(`/food/orders/${order.food_order_id}`);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('221B Baker Street');
    expect(JSON.stringify(res.body)).not.toContain('1234');
  });

  it('hides the order from an authenticated user who is not a party to it', async () => {
    const res = await request(app)
      .get(`/food/orders/${order.food_order_id}`)
      .set(authHeader(outsider));

    // 404, not 403 — the endpoint must not confirm which order ids exist.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('221B Baker Street');
    expect(JSON.stringify(res.body)).not.toContain('1234');
  });

  it('lets the customer, the vendor owner and the assigned driver read it', async () => {
    for (const viewer of [customer, vendorOwner, driverUser]) {
      const res = await request(app)
        .get(`/food/orders/${order.food_order_id}`)
        .set(authHeader(viewer));

      expect(res.status).toBe(200);
      expect(res.body.food_order_id).toBe(order.food_order_id);
      expect(res.body.deliver_location).toBe('221B Baker Street');
    }
  });

  it('never embeds order PII in the public vendor list, even with ?all=1', async () => {
    const res = await request(app).get('/food/vendors?all=1');
    expect(res.status).toBe(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('221B Baker Street');
    expect(body).not.toContain('Ring twice');
    expect(body).not.toContain('1234');

    // The array shape is preserved so callers can still count orders.
    const row = res.body.find((v) => v.vendor_id === vendor.vendor_id);
    expect(row.food_order).toHaveLength(1);
    expect(Object.keys(row.food_order[0])).toEqual(['food_order_id']);
  });

  it('never embeds order PII in the public vendor detail route', async () => {
    const res = await request(app).get(`/food/vendors/${vendor.vendor_id}`);
    expect(res.status).toBe(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('221B Baker Street');
    expect(body).not.toContain('Ring twice');
    expect(body).not.toContain('1234');
    expect(Object.keys(res.body.food_order[0])).toEqual(['food_order_id']);
  });
});
