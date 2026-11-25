import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const prismaMock = {};
vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));

const overviewMock = vi.fn(async () => ({ days: 30, kpis: {} }));
const catalogMock = vi.fn(() => ({ version: 1, metrics: [] }));
vi.mock('../../services/board-analytics-overview.js', () => ({
  buildAnalyticsOverview: (...args) => overviewMock(...args),
  buildMetricsCatalog: (...args) => catalogMock(...args),
}));

vi.mock('../../middleware/authenticate-board.js', () => ({
  authenticateBoard: (req, res, next) => {
    if (!req.headers.authorization) {
      return res.status(401).json({ successful: false, message: 'Access denied' });
    }
    if (req.headers.authorization === 'Bearer forbidden') {
      req.access = {};
      return next();
    }
    req.access = { analytics: 'read' };
    req.member = { member_id: 1 };
    return next();
  },
  requireDashboard: (id, level = 'read') => (req, res, next) => {
    const have = req.access?.[id];
    if (have === 'write' || (level === 'read' && (have === 'read' || have === 'write'))) {
      return next();
    }
    return res.status(403).json({ successful: false, message: 'Forbidden' });
  },
}));

const { default: router } = await import('../../routes/board-admin-analytics-routes.js');

function app() {
  const a = express();
  a.use('/board-admin/analytics', router);
  return a;
}

describe('board-admin analytics routes (phase 0)', () => {
  beforeEach(() => {
    overviewMock.mockClear();
    catalogMock.mockClear();
  });

  it('returns 401 when no JWT is sent', async () => {
    const res = await request(app()).get('/board-admin/analytics/overview');
    expect(res.status).toBe(401);
  });

  it('returns 403 when the member lacks analytics access', async () => {
    const res = await request(app())
      .get('/board-admin/analytics/overview')
      .set('Authorization', 'Bearer forbidden');
    expect(res.status).toBe(403);
  });

  it('returns overview for an allowed member and forwards days', async () => {
    overviewMock.mockResolvedValueOnce({ days: 7, kpis: {} });
    const res = await request(app())
      .get('/board-admin/analytics/overview?days=7')
      .set('Authorization', 'Bearer ok');
    expect(res.status).toBe(200);
    expect(overviewMock).toHaveBeenCalledWith(prismaMock, { days: 7 });
    expect(res.body.days).toBe(7);
  });

  it('returns metrics catalog for an allowed member', async () => {
    const res = await request(app())
      .get('/board-admin/analytics/metrics')
      .set('Authorization', 'Bearer ok');
    expect(res.status).toBe(200);
    expect(catalogMock).toHaveBeenCalled();
    expect(res.body.version).toBe(1);
  });
});
