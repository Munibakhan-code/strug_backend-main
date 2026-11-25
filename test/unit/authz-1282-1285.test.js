/**
 * #1282–#1285 authz: flo-user, rental-listing-pics, service-cv, employee, emergency-contact.
 * Mocked prisma + auth — no live DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const authUser = { current: { user_id: 10, role: 'USER' } };

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    if (!authUser.current) return res.status(401).json({ message: 'Unauthorized' });
    req.user = { ...authUser.current };
    next();
  },
}));

vi.mock('../../middleware/require-admin.js', async () => {
  const actual = await vi.importActual('../../middleware/require-admin.js');
  return actual;
});

const prismaMock = {
  flo_user: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  rental_listing: { findUnique: vi.fn() },
  rental_listing_pics: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  user_service_provider: { findUnique: vi.fn() },
  service_cv: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  employees: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  emergency_contact: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
};

vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));

const floRouter = (await import('../../routes/flo-user-routes.js')).default;
const picsRouter = (await import('../../routes/rental-listing-pics-routes.js')).default;
const cvRouter = (await import('../../routes/service-cv-routes.js')).default;
const empRouter = (await import('../../routes/employee-routes.js')).default;
const emergRouter = (await import('../../routes/emergency-contact-routes.js')).default;

function mount(path, router) {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  return app;
}

beforeEach(() => {
  authUser.current = { user_id: 10, role: 'USER' };
  vi.clearAllMocks();
});

describe('flo-user (#1282)', () => {
  const app = mount('/flo-user', floRouter);

  it('401 when unauthenticated', async () => {
    authUser.current = null;
    expect((await request(app).get('/flo-user')).status).toBe(401);
  });

  it('lists only caller-owned flo profiles', async () => {
    prismaMock.flo_user.findMany.mockResolvedValue([{ flo_user_id: 1, user_id: 10 }]);
    const res = await request(app).get('/flo-user');
    expect(res.status).toBe(200);
    expect(prismaMock.flo_user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 10 } }),
    );
  });

  it('403s cross-user GET by id', async () => {
    prismaMock.flo_user.findUnique.mockResolvedValue({ flo_user_id: 2, user_id: 99 });
    expect((await request(app).get('/flo-user/2')).status).toBe(403);
  });

  it('creates with JWT user_id, ignores body user_id', async () => {
    prismaMock.flo_user.findUnique.mockResolvedValue(null);
    prismaMock.flo_user.create.mockResolvedValue({ flo_user_id: 3, user_id: 10 });
    const res = await request(app).post('/flo-user').send({ user_id: 999, avg_cycle_length: 30 });
    expect(res.status).toBe(201);
    expect(prismaMock.flo_user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ user_id: 10 }),
      }),
    );
  });

  it('409 when flo profile already exists', async () => {
    prismaMock.flo_user.findUnique.mockResolvedValue({ flo_user_id: 1, user_id: 10 });
    const res = await request(app).post('/flo-user').send({ avg_cycle_length: 30 });
    expect(res.status).toBe(409);
    expect(prismaMock.flo_user.create).not.toHaveBeenCalled();
  });

  it('admin can list all', async () => {
    authUser.current = { user_id: 1, role: 'ADMIN' };
    prismaMock.flo_user.findMany.mockResolvedValue([]);
    await request(app).get('/flo-user');
    expect(prismaMock.flo_user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });
});

describe('rental-listing-pics (#1283)', () => {
  const app = mount('/rental-listing-pics', picsRouter);

  it('401 on list-all without auth', async () => {
    authUser.current = null;
    expect((await request(app).get('/rental-listing-pics')).status).toBe(401);
  });

  it('403 list-all for non-admin', async () => {
    expect((await request(app).get('/rental-listing-pics')).status).toBe(403);
  });

  it('allows public GET by listing id', async () => {
    authUser.current = null;
    prismaMock.rental_listing_pics.findMany.mockResolvedValue([{ rental_pics_id: 1 }]);
    expect((await request(app).get('/rental-listing-pics/listing/5')).status).toBe(200);
  });

  it('403s create when not listing owner', async () => {
    prismaMock.rental_listing.findUnique.mockResolvedValue({
      rental_listing_id: 5,
      owner_id: 99,
    });
    const res = await request(app).post('/rental-listing-pics').send({
      rental_listing_id: 5,
      url: 'https://cdn/x.jpg',
    });
    expect(res.status).toBe(403);
  });

  it('owner can create pic', async () => {
    prismaMock.rental_listing.findUnique.mockResolvedValue({
      rental_listing_id: 5,
      owner_id: 10,
    });
    prismaMock.rental_listing_pics.create.mockResolvedValue({ rental_pics_id: 9 });
    const res = await request(app).post('/rental-listing-pics').send({
      rental_listing_id: 5,
      url: 'https://cdn/x.jpg',
    });
    expect(res.status).toBe(201);
  });
});

describe('service-cv (#1284)', () => {
  const app = mount('/service-cv', cvRouter);

  it('401 unauthenticated list', async () => {
    authUser.current = null;
    expect((await request(app).get('/service-cv')).status).toBe(401);
  });

  it('403 create for provider owned by another user', async () => {
    prismaMock.user_service_provider.findUnique.mockResolvedValue({
      provider_id: 7,
      user_id: 99,
    });
    const res = await request(app).post('/service-cv').send({
      provider_id: 7,
      url: 'https://cv.example/me.pdf',
    });
    expect(res.status).toBe(403);
  });

  it('400 when provider_id or url missing', async () => {
    expect((await request(app).post('/service-cv').send({})).status).toBe(400);
  });
});

describe('employee + emergency-contact (#1285)', () => {
  const empApp = mount('/employee', empRouter);
  const emergApp = mount('/emergency-contact', emergRouter);

  it('401 unauthenticated employee list', async () => {
    authUser.current = null;
    expect((await request(empApp).get('/employee')).status).toBe(401);
  });

  it('403 non-admin employee list', async () => {
    expect((await request(empApp).get('/employee')).status).toBe(403);
  });

  it('200 admin employee list', async () => {
    authUser.current = { user_id: 1, role: 'ADMIN', permission: 'admin' };
    prismaMock.employees.findMany.mockResolvedValue([]);
    expect((await request(empApp).get('/employee')).status).toBe(200);
  });

  it('403 non-admin emergency-contact list', async () => {
    expect((await request(emergApp).get('/emergency-contact')).status).toBe(403);
  });

  it('200 admin emergency-contact list', async () => {
    authUser.current = { user_id: 1, permission: 'admin' };
    prismaMock.emergency_contact.findMany.mockResolvedValue([]);
    expect((await request(emergApp).get('/emergency-contact')).status).toBe(200);
  });
});
