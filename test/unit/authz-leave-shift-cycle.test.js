/**
 * Leave/shift admin lock + cycle-prediction owner scope (#1285 follow-up, #1289).
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
  flo_user: { findMany: vi.fn() },
  cycle_prediction: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  leave: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  employees: {
    findFirst: vi.fn(),
  },
  shift: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
};

vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));
vi.mock('../../utils/mailer-event.js', () => ({ default: { emit: vi.fn() } }));
vi.mock('../../utils/crypto.js', () => ({ decrypt: (v) => v }));

const leaveRouter = (await import('../../routes/leave-routes.js')).default;
const shiftRouter = (await import('../../routes/shift-routes.js')).default;
const cycleRouter = (await import('../../routes/cycle-prediction-routes.js')).default;

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

describe('leave admin gate', () => {
  const app = mount('/leave', leaveRouter);

  it('401 unauthenticated', async () => {
    authUser.current = null;
    expect((await request(app).get('/leave')).status).toBe(401);
  });

  it('403 non-admin on list', async () => {
    expect((await request(app).get('/leave')).status).toBe(403);
  });

  it('200 admin list', async () => {
    authUser.current = { user_id: 1, role: 'ADMIN' };
    prismaMock.leave.findMany.mockResolvedValue([]);
    expect((await request(app).get('/leave')).status).toBe(200);
  });

  it('allows employee to POST own leave without admin', async () => {
    prismaMock.employees.findFirst.mockResolvedValue({ employee_id: 44 });
    prismaMock.leave.create.mockResolvedValue({ leave_id: 9, employee_id: 44, status: 'pending' });
    const res = await request(app).post('/leave').send({
      employee_id: 999,
      from_date: '2026-09-10',
      to_date: '2026-09-11',
      type: 'vacation',
      status: 'approved',
    });
    expect(res.status).toBe(201);
    expect(prismaMock.leave.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ employee_id: 44, status: 'pending' }),
      }),
    );
  });

  it('403 when employee has no linked profile on POST', async () => {
    prismaMock.employees.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/leave').send({ from_date: '2026-09-10' });
    expect(res.status).toBe(403);
  });

  it('403 non-admin on leave status PUT', async () => {
    expect((await request(app).put('/leave/1').send({ status: 'approved' })).status).toBe(403);
  });
});

describe('shift admin gate', () => {
  const app = mount('/shift', shiftRouter);

  it('401 unauthenticated', async () => {
    authUser.current = null;
    expect((await request(app).get('/shift')).status).toBe(401);
  });

  it('403 non-admin', async () => {
    expect((await request(app).get('/shift')).status).toBe(403);
  });

  it('200 admin list', async () => {
    authUser.current = { user_id: 1, role: 'ADMIN' };
    prismaMock.shift.findMany.mockResolvedValue([]);
    expect((await request(app).get('/shift')).status).toBe(200);
  });
});

describe('cycle-prediction owner scope (#1289)', () => {
  const app = mount('/cycle-prediction', cycleRouter);

  it('401 unauthenticated', async () => {
    authUser.current = null;
    expect((await request(app).get('/cycle-prediction')).status).toBe(401);
  });

  it('lists only caller-owned predictions', async () => {
    prismaMock.flo_user.findMany.mockResolvedValue([{ flo_user_id: 7 }]);
    prismaMock.cycle_prediction.findMany.mockResolvedValue([{ prediction_id: 1, flo_user_id: 7 }]);
    const res = await request(app).get('/cycle-prediction');
    expect(res.status).toBe(200);
    expect(prismaMock.cycle_prediction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { flo_user_id: { in: [7] } } }),
    );
  });

  it('403s cross-user GET by id', async () => {
    prismaMock.flo_user.findMany.mockResolvedValue([{ flo_user_id: 7 }]);
    prismaMock.cycle_prediction.findUnique.mockResolvedValue({ prediction_id: 2, flo_user_id: 99 });
    expect((await request(app).get('/cycle-prediction/2')).status).toBe(403);
  });

  it('403s create for unowned flo_user', async () => {
    prismaMock.flo_user.findMany.mockResolvedValue([{ flo_user_id: 7 }]);
    const res = await request(app).post('/cycle-prediction').send({
      flo_user_id: 99,
      cycle_start_date: '2026-01-01',
    });
    expect(res.status).toBe(403);
  });

  it('creates for owned flo_user without broadcasting sockets', async () => {
    prismaMock.flo_user.findMany.mockResolvedValue([{ flo_user_id: 7 }]);
    prismaMock.cycle_prediction.create.mockResolvedValue({ prediction_id: 3, flo_user_id: 7 });
    const emit = vi.fn();
    const app = express();
    app.set('io', { emit });
    app.use(express.json());
    app.use('/cycle-prediction', cycleRouter);
    const res = await request(app).post('/cycle-prediction').send({
      flo_user_id: 7,
      cycle_start_date: '2026-01-01',
    });
    expect(res.status).toBe(201);
    expect(emit).not.toHaveBeenCalled();
  });
});
