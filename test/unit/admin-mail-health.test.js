import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const getMailHealthSummary = vi.fn();
const getMailCatalog = vi.fn();
const sendEmail = vi.fn();
const getMailConfigSnapshot = vi.fn();
const isMailConfigured = vi.fn();
const getMailOutboxSummary = vi.fn();
const listMailSuppressions = vi.fn();
const upsertMailSuppression = vi.fn();
const deactivateMailSuppression = vi.fn();
const getMailCutoverStatus = vi.fn();

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    if (!req.headers.authorization) {
      return res.status(401).json('Access denied');
    }
    req.user = req._testUser || { user_id: 1, role: 'USER' };
    if (req.user.role !== 'ADMIN' && req.user.permission !== 'admin') {
      // fall through to requireAdmin mock below when we wire both
    }
    next();
  },
  requireAdmin: (req, res, next) => {
    if (req.user?.role === 'ADMIN' || req.user?.permission === 'admin') {
      return next();
    }
    return res.status(403).json({ message: 'Forbidden: Admins only' });
  },
}));

vi.mock('../../services/email-service.js', () => ({
  sendEmail: (...a) => sendEmail(...a),
  getMailConfigSnapshot: (...a) => getMailConfigSnapshot(...a),
  isMailConfigured: (...a) => isMailConfigured(...a),
}));

vi.mock('../../services/mail/send-log.js', () => ({
  getMailHealthSummary: (...a) => getMailHealthSummary(...a),
  getMailCatalog: (...a) => getMailCatalog(...a),
}));

vi.mock('../../services/mail/outbox.js', () => ({
  getMailOutboxSummary: (...a) => getMailOutboxSummary(...a),
}));

vi.mock('../../services/mail/suppression.js', () => ({
  SUPPRESSION_REASONS: ['bounce', 'complaint', 'manual', 'unsubscribe'],
  listMailSuppressions: (...a) => listMailSuppressions(...a),
  upsertMailSuppression: (...a) => upsertMailSuppression(...a),
  deactivateMailSuppression: (...a) => deactivateMailSuppression(...a),
}));

vi.mock('../../services/mail/rate-limit.js', () => ({
  getMailRateLimits: () => ({
    perRecipientHour: 40,
    perRecipientHourCritical: 20,
    perTemplateHour: 2000,
    windowMs: 3600000,
  }),
}));

vi.mock('../../services/mail/cutover-status.js', () => ({
  getMailCutoverStatus: (...a) => getMailCutoverStatus(...a),
}));

async function buildApp(user) {
  const { default: adminMailRoutes } = await import('../../routes/admin-mail-routes.js');
  const app = express();
  app.use(express.json());
  app.use('/admin/mail', (req, _res, next) => {
    req._testUser = user;
    next();
  }, adminMailRoutes);
  return app;
}

describe('admin mail health routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    getMailConfigSnapshot.mockReturnValue({
      provider: 'resend',
      from: '"Strug" <mail@strug.ca>',
      configured: true,
    });
    isMailConfigured.mockReturnValue(true);
    getMailHealthSummary.mockResolvedValue({
      window_hours: 24,
      counts: { total: 2, success: 1, failure: 1 },
      recent_failures: [{ id: 9, error: 'quota', provider_message_id: null }],
      recent: [],
    });
    getMailOutboxSummary.mockResolvedValue({
      window_hours: 24,
      counts: { pending: 1, sent: 3, failed: 0, suppressed: 0 },
    });
    getMailCutoverStatus.mockResolvedValue({
      production_default_provider: 'resend',
      code_ready: true,
      checklist_doc: 'docs/mail-smtp-cutover-gate.md',
    });
    process.env.MAIL_PROBE_ALLOWLIST = 'ops@strug.ca';
  });

  it('returns 401 when unauthenticated', async () => {
    const app = await buildApp({ role: 'ADMIN' });
    const res = await request(app).get('/admin/mail/health');
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated non-admin', async () => {
    const app = await buildApp({ user_id: 2, role: 'USER' });
    const res = await request(app)
      .get('/admin/mail/health')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(403);
  });

  it('returns health summary for admin including failure visibility', async () => {
    const app = await buildApp({ user_id: 1, role: 'ADMIN' });
    const res = await request(app)
      .get('/admin/mail/health')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.counts.failure).toBe(1);
    expect(res.body.recent_failures[0].error).toBe('quota');
    expect(res.body.config.provider).toBe('resend');
    expect(res.body.outbox.counts.pending).toBe(1);
    expect(res.body.rate_limits.perRecipientHour).toBe(40);
  });

  it('returns cutover status for admin', async () => {
    const app = await buildApp({ user_id: 1, role: 'ADMIN' });
    const res = await request(app)
      .get('/admin/mail/cutover-status')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.production_default_provider).toBe('resend');
    expect(res.body.code_ready).toBe(true);
  });

  it('cutover status returns 403 for non-admin', async () => {
    const app = await buildApp({ user_id: 2, role: 'USER' });
    const res = await request(app)
      .get('/admin/mail/cutover-status')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(403);
    expect(getMailCutoverStatus).not.toHaveBeenCalled();
  });

  it('lists suppressions for admin', async () => {
    listMailSuppressions.mockResolvedValue([
      {
        id: 1,
        to_hash: 'a'.repeat(64),
        to_hint: 'b***@x.com',
        reason: 'bounce',
        active: true,
      },
    ]);
    const app = await buildApp({ user_id: 1, role: 'ADMIN' });
    const res = await request(app)
      .get('/admin/mail/suppressions')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.suppressions).toHaveLength(1);
    expect(res.body.reasons).toContain('bounce');
  });

  it('adds suppression with valid email', async () => {
    upsertMailSuppression.mockResolvedValue({
      id: 2,
      to_hash: 'b'.repeat(64),
      to_hint: 'c***@y.com',
      reason: 'manual',
      active: true,
    });
    const app = await buildApp({ user_id: 1, role: 'ADMIN' });
    const res = await request(app)
      .post('/admin/mail/suppressions')
      .set('Authorization', 'Bearer t')
      .send({ to: 'c@y.com', reason: 'manual' });
    expect(res.status).toBe(201);
    expect(upsertMailSuppression).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'c@y.com', reason: 'manual', source: 'admin' }),
    );
  });

  it('rejects suppression without email', async () => {
    const app = await buildApp({ user_id: 1, role: 'ADMIN' });
    const res = await request(app)
      .post('/admin/mail/suppressions')
      .set('Authorization', 'Bearer t')
      .send({ reason: 'manual' });
    expect(res.status).toBe(400);
    expect(upsertMailSuppression).not.toHaveBeenCalled();
  });

  it('deactivates suppression by hash', async () => {
    const hash = 'c'.repeat(64);
    deactivateMailSuppression.mockResolvedValue({
      to_hash: hash,
      active: false,
    });
    const app = await buildApp({ user_id: 1, role: 'ADMIN' });
    const res = await request(app)
      .delete(`/admin/mail/suppressions/${hash}`)
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  it('probe rejects recipients outside allowlist', async () => {
    const app = await buildApp({ user_id: 1, role: 'ADMIN' });
    const res = await request(app)
      .post('/admin/mail/probe')
      .set('Authorization', 'Bearer t')
      .send({ to: 'attacker@evil.com' });
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('probe sends to allowlisted inbox and returns message id', async () => {
    sendEmail.mockResolvedValue({ id: 'probe_1', provider: 'resend' });
    const app = await buildApp({ user_id: 1, role: 'ADMIN' });
    const res = await request(app)
      .post('/admin/mail/probe')
      .set('Authorization', 'Bearer t')
      .send({ to: 'ops@strug.ca' });
    expect(res.status).toBe(200);
    expect(res.body.message_id).toBe('probe_1');
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ops@strug.ca',
        tags: expect.arrayContaining([
          expect.objectContaining({ name: 'template', value: 'mail-health-probe' }),
        ]),
      }),
    );
  });

  it('returns catalog for admin with vertical metadata', async () => {
    getMailCatalog.mockResolvedValue({
      window_hours: 168,
      total: 1,
      by_vertical: { auth: 1 },
      templates: [
        {
          template: 'otp',
          vertical: 'auth',
          owner: 'platform',
          audience: 'user',
          priority: 'critical',
          last_send: null,
        },
      ],
    });
    const app = await buildApp({ user_id: 1, role: 'ADMIN' });
    const res = await request(app)
      .get('/admin/mail/catalog')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body.templates[0].vertical).toBe('auth');
    expect(res.body.by_vertical.auth).toBe(1);
  });

  it('catalog returns 403 for non-admin', async () => {
    const app = await buildApp({ user_id: 2, role: 'USER' });
    const res = await request(app)
      .get('/admin/mail/catalog')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(403);
    expect(getMailCatalog).not.toHaveBeenCalled();
  });
});
