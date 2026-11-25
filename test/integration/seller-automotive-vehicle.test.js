import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

// Route image uploads through the real storeImageBuffer() path but stub the Azure blob call
// itself, so the test suite never depends on (or writes to) a real Azure storage account and
// never falls back to writing files under ./uploads on disk.
vi.mock('../../utils/azure-storage.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isAzureStorageConfigured: () => true,
    uploadPublicBlob: vi.fn(async (container, objectName) => `https://test-blob.example/${container}/${objectName}`),
  };
});

const { app } = await import('../../app.js');

// Seller automotive dashboard listing CRUD: POST/PUT /vehicle/automotive, DELETE/GET /vehicle,
// GET /vehicle/automotive/all. Covers the bicycle-conditional required fields, the image/video
// upload contract, and the ownership split between automotive (user_id) and rideshare
// (driver_id -> driver_profile.user_id) vehicles that assertVehicleOwnedByUser enforces.

// sniffImageType only checks magic bytes (never decodes pixels), so a signature plus padding
// to 12+ bytes is enough to exercise the real upload path.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8, 0),
]);
const NOT_AN_IMAGE = Buffer.from('plain text pretending to be an image, padded past 12 bytes');

function baseFields(overrides = {}) {
  const fields = {
    vehicle_type: 'Cars',
    price: '15000',
    make: 'Toyota',
    model: 'Corolla',
    year: '2020',
    color: 'Blue',
    condition: 'Used',
    mileage: '40000',
    fuel: 'Petrol',
    transmission: 'Automatic',
    engine: '1.8L I4',
  };
  Object.assign(fields, overrides);
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) delete fields[key];
  }
  return fields;
}

describe('seller automotive dashboard — vehicle listing CRUD', () => {
  let seller, otherUser;

  beforeEach(async () => {
    await truncateAll();
    seller = await createUser({ name: 'Automotive Seller' });
    otherUser = await createUser({ name: 'Other User' });
  });

  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  describe('POST /vehicle/automotive', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await request(app).post('/vehicle/automotive').send(baseFields());
      expect(res.status).toBe(401);
    });

    it('rejects when core required fields are missing', async () => {
      const res = await request(app)
        .post('/vehicle/automotive')
        .set(authHeader(seller))
        .send(baseFields({ model: undefined, price: undefined }));

      expect(res.status).toBe(400);
      expect(res.body.successful).toBe(false);
      expect(res.body.message).toMatch(/vehicle_type, make, model, year, price, color, and condition/);
    });

    it('rejects a non-bicycle vehicle missing mileage/fuel/transmission/engine', async () => {
      const res = await request(app)
        .post('/vehicle/automotive')
        .set(authHeader(seller))
        .send(baseFields({ mileage: undefined, fuel: undefined, transmission: undefined, engine: undefined }));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/mileage, fuel, transmission, and engine are required/);
    });

    it('accepts a bicycle listing without mileage/fuel/transmission/engine', async () => {
      const res = await request(app)
        .post('/vehicle/automotive')
        .set(authHeader(seller))
        .send(baseFields({
          vehicle_type: 'Bicycles',
          mileage: undefined,
          fuel: undefined,
          transmission: undefined,
          engine: undefined,
        }));

      expect(res.status).toBe(201);
      expect(res.body.data.vehicle_type).toBe('Bicycles');
      expect(res.body.data.mileage).toBeNull();
      expect(res.body.data.fuel).toBeNull();
      expect(res.body.data.transmission).toBeNull();
    });

    it('creates a listing owned by the caller, with no driver profile attached', async () => {
      const res = await request(app)
        .post('/vehicle/automotive')
        .set(authHeader(seller))
        .send(baseFields());

      expect(res.status).toBe(201);
      expect(res.body.successful).toBe(true);
      expect(res.body.data.user_id).toBe(seller.user_id);
      expect(res.body.data.driver_id).toBeNull();
      expect(res.body.data.is_negotiable).toBe(false);
      expect(res.body.data.images).toBeNull();
      expect(res.body.data.video_url).toBeNull();
    });

    it('coerces is_negotiable from the string "true" sent by multipart form fields', async () => {
      const res = await request(app)
        .post('/vehicle/automotive')
        .set(authHeader(seller))
        .send(baseFields({ is_negotiable: 'true' }));

      expect(res.status).toBe(201);
      expect(res.body.data.is_negotiable).toBe(true);
    });

    it('uploads valid images and stores the first one as vehicle_pic_url', async () => {
      const fields = baseFields();
      let req = request(app).post('/vehicle/automotive').set(authHeader(seller));
      for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
      const res = await req.attach('images', PNG_BYTES, 'car-front.png');

      expect(res.status).toBe(201);
      const images = JSON.parse(res.body.data.images);
      expect(images).toHaveLength(1);
      expect(res.body.data.vehicle_pic_url).toBe(images[0]);
    });

    it('rejects an image file whose bytes do not match a known image signature', async () => {
      const fields = baseFields();
      let req = request(app).post('/vehicle/automotive').set(authHeader(seller));
      for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
      const res = await req.attach('images', NOT_AN_IMAGE, { filename: 'fake.png', contentType: 'image/png' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Invalid image file');
    });
  });

  describe('PUT /vehicle/automotive/:vehicle_id', () => {
    async function createListing(owner, overrides = {}) {
      const res = await request(app)
        .post('/vehicle/automotive')
        .set(authHeader(owner))
        .send(baseFields(overrides));
      return res.body.data;
    }

    it('returns 404 for a vehicle that does not exist', async () => {
      const res = await request(app)
        .put('/vehicle/automotive/999999')
        .set(authHeader(seller))
        .send(baseFields());
      expect(res.status).toBe(404);
    });

    it('returns 403 when a different user tries to update the listing', async () => {
      const vehicle = await createListing(seller);
      const res = await request(app)
        .put(`/vehicle/automotive/${vehicle.vehicle_id}`)
        .set(authHeader(otherUser))
        .send(baseFields());
      expect(res.status).toBe(403);
    });

    it('rejects update when required fields are missing', async () => {
      const vehicle = await createListing(seller);
      const res = await request(app)
        .put(`/vehicle/automotive/${vehicle.vehicle_id}`)
        .set(authHeader(seller))
        .send(baseFields({ color: undefined }));
      expect(res.status).toBe(400);
    });

    it('updates scalar fields and keeps existing images when none are sent', async () => {
      const fields = baseFields();
      let createReq = request(app).post('/vehicle/automotive').set(authHeader(seller));
      for (const [k, v] of Object.entries(fields)) createReq = createReq.field(k, v);
      const created = (await createReq.attach('images', PNG_BYTES, 'car.png')).body.data;
      const originalImages = created.images;

      const res = await request(app)
        .put(`/vehicle/automotive/${created.vehicle_id}`)
        .set(authHeader(seller))
        .send(baseFields({ price: '17500' }));

      expect(res.status).toBe(200);
      expect(res.body.data.price).toBe(17500);
      expect(res.body.data.images).toBe(originalImages);
    });

    it('nulls out fuel/transmission (not the string "undefined") when updating to a bicycle without them', async () => {
      const created = await createListing(seller);
      const res = await request(app)
        .put(`/vehicle/automotive/${created.vehicle_id}`)
        .set(authHeader(seller))
        .send(baseFields({
          vehicle_type: 'Bicycles',
          mileage: undefined,
          fuel: undefined,
          transmission: undefined,
          engine: undefined,
        }));

      expect(res.status).toBe(200);
      expect(res.body.data.fuel).toBeNull();
      expect(res.body.data.transmission).toBeNull();
    });

    it('replaces images with the existing_images list sent from the client', async () => {
      const created = await createListing(seller);
      const keepUrls = JSON.stringify(['/uploads/vehicles/kept-1.png']);

      const res = await request(app)
        .put(`/vehicle/automotive/${created.vehicle_id}`)
        .set(authHeader(seller))
        .send(baseFields({ existing_images: keepUrls }));

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body.data.images)).toEqual(['/uploads/vehicles/kept-1.png']);
    });

    it('rejects a malformed existing_images payload', async () => {
      const created = await createListing(seller);
      const res = await request(app)
        .put(`/vehicle/automotive/${created.vehicle_id}`)
        .set(authHeader(seller))
        .send(baseFields({ existing_images: 'not-json' }));

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Invalid existing_images format');
    });

    it('clears video_url when the update omits both a new video and keep_existing_video', async () => {
      // Documents current behavior: the client must explicitly send keep_existing_video="true"
      // to retain a video on update; omitting it (e.g. a client bug) silently deletes it.
      const created = await createListing(seller);
      await db.vehicle.update({
        where: { vehicle_id: created.vehicle_id },
        data: { video_url: 'https://blob.example/vehicle-videos/existing.mp4' },
      });

      const res = await request(app)
        .put(`/vehicle/automotive/${created.vehicle_id}`)
        .set(authHeader(seller))
        .send(baseFields());

      expect(res.status).toBe(200);
      expect(res.body.data.video_url).toBeNull();
    });

    it('keeps video_url when keep_existing_video is sent as "true"', async () => {
      const created = await createListing(seller);
      await db.vehicle.update({
        where: { vehicle_id: created.vehicle_id },
        data: { video_url: 'https://blob.example/vehicle-videos/existing.mp4' },
      });

      const res = await request(app)
        .put(`/vehicle/automotive/${created.vehicle_id}`)
        .set(authHeader(seller))
        .send(baseFields({ keep_existing_video: 'true' }));

      expect(res.status).toBe(200);
      expect(res.body.data.video_url).toBe('https://blob.example/vehicle-videos/existing.mp4');
    });
  });

  describe('DELETE /vehicle/:vehicle_id — automotive ownership', () => {
    it('returns 403 when a non-owner tries to delete an automotive listing', async () => {
      const created = await db.vehicle.create({
        data: { user_id: seller.user_id, make: 'Honda', model: 'Civic', year: 2019, price: 12000, vehicle_type: 'Cars' },
      });

      const res = await request(app).delete(`/vehicle/${created.vehicle_id}`).set(authHeader(otherUser));
      expect(res.status).toBe(403);
      expect(await db.vehicle.findUnique({ where: { vehicle_id: created.vehicle_id } })).not.toBeNull();
    });

    it('lets the owner delete their automotive listing', async () => {
      const created = await db.vehicle.create({
        data: { user_id: seller.user_id, make: 'Honda', model: 'Civic', year: 2019, price: 12000, vehicle_type: 'Cars' },
      });

      const res = await request(app).delete(`/vehicle/${created.vehicle_id}`).set(authHeader(seller));
      expect(res.status).toBe(200);
      expect(await db.vehicle.findUnique({ where: { vehicle_id: created.vehicle_id } })).toBeNull();
    });

    it('rejects deleting a vehicle_id that does not exist', async () => {
      const res = await request(app).delete('/vehicle/999999').set(authHeader(seller));
      expect(res.status).toBe(404);
    });
  });

  describe('ownership boundary between automotive (user_id) and rideshare (driver_id) vehicles', () => {
    it('does not let an automotive-listing owner (user_id) manage a rideshare vehicle owned via driver_profile', async () => {
      const rideshareOwner = await createUser({ name: 'Rideshare Driver' });
      const profile = await db.driver_profile.create({ data: { user_id: rideshareOwner.user_id } });
      const rideshareVehicle = await db.vehicle.create({
        data: { driver_id: profile.driver_profile_id, plate_number: 'ABC123', model: 'Prius' },
      });

      const res = await request(app)
        .put(`/vehicle/automotive/${rideshareVehicle.vehicle_id}`)
        .set(authHeader(seller))
        .send(baseFields());

      expect(res.status).toBe(403);
    });
  });

  describe('GET /vehicle — scoped to the caller', () => {
    it('only returns vehicles owned by the authenticated user', async () => {
      await db.vehicle.create({ data: { user_id: seller.user_id, make: 'Toyota', model: 'Yaris', vehicle_type: 'Cars' } });
      await db.vehicle.create({ data: { user_id: otherUser.user_id, make: 'Ford', model: 'Focus', vehicle_type: 'Cars' } });

      const res = await request(app).get('/vehicle').set(authHeader(seller));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].make).toBe('Toyota');
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/vehicle');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /vehicle/automotive/all — public marketplace listing', () => {
    it('requires no auth and includes only vehicles with a user_id (excludes driver-only rideshare vehicles)', async () => {
      const profile = await db.driver_profile.create({ data: { user_id: otherUser.user_id } });
      await db.vehicle.create({ data: { user_id: seller.user_id, make: 'Mazda', model: 'CX-5', vehicle_type: 'Cars' } });
      await db.vehicle.create({ data: { driver_id: profile.driver_profile_id, plate_number: 'XYZ999', model: 'Camry' } });

      const res = await request(app).get('/vehicle/automotive/all');
      expect(res.status).toBe(200);
      expect(res.body.every((v) => v.user_id !== null)).toBe(true);
      expect(res.body.some((v) => v.make === 'Mazda')).toBe(true);
    });
  });
});
