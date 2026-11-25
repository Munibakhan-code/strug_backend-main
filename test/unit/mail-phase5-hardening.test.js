/**
 * Phase 5: suppression, rate limits, critical-mail outbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();
const mailLogCreate = vi.fn();
const mailLogCount = vi.fn();
const suppressionFindUnique = vi.fn();
const suppressionUpsert = vi.fn();
const outboxCreate = vi.fn();
const outboxUpdate = vi.fn();
const outboxFindUnique = vi.fn();
const outboxFindMany = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    constructor() {
      this.emails = { send: sendMock };
      this.domains = { list: vi.fn() };
    }
  },
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail: vi.fn() }),
  },
}));

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    mail_send_log: {
      create: (...a) => mailLogCreate(...a),
      count: (...a) => mailLogCount(...a),
      findMany: vi.fn(),
    },
    mail_suppression: {
      findUnique: (...a) => suppressionFindUnique(...a),
      upsert: (...a) => suppressionUpsert(...a),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    mail_outbox: {
      create: (...a) => outboxCreate(...a),
      update: (...a) => outboxUpdate(...a),
      findUnique: (...a) => outboxFindUnique(...a),
      findMany: (...a) => outboxFindMany(...a),
      count: vi.fn().mockResolvedValue(0),
    },
  },
}));

vi.mock('../../utils/crypto.js', () => ({
  encryptEmailForStorage: (e) => `enc:${e}`,
  decrypt: (c) => String(c).replace(/^enc:/, ''),
}));

describe('mail phase 5 hardening', () => {
  const envBackup = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    sendMock.mockReset();
    mailLogCreate.mockReset().mockResolvedValue({ id: 1 });
    mailLogCount.mockReset().mockResolvedValue(0);
    suppressionFindUnique.mockReset().mockResolvedValue(null);
    suppressionUpsert.mockReset();
    outboxCreate.mockReset();
    outboxUpdate.mockReset();
    outboxFindUnique.mockReset();
    outboxFindMany.mockReset().mockResolvedValue([]);
    process.env = { ...envBackup };
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    process.env.MAIL_PROVIDER = 'resend';
    delete process.env.MAIL_OUTBOX_DISABLED;
    delete process.env.MAIL_RATE_PER_RECIPIENT_HOUR;
    delete process.env.MAIL_RATE_PER_RECIPIENT_HOUR_CRITICAL;
    delete process.env.MAIL_RATE_PER_TEMPLATE_HOUR;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('rejects send when recipient is actively suppressed', async () => {
    suppressionFindUnique.mockResolvedValue({ active: true });
    const { sendEmail, __resetMailClientsForTests } = await import(
      '../../services/email-service.js'
    );
    __resetMailClientsForTests();
    await expect(
      sendEmail({
        to: 'blocked@example.com',
        subject: 'Hi',
        html: '<p>Hi</p>',
        tags: [{ name: 'template', value: 'welcome' }],
      }),
    ).rejects.toMatchObject({ code: 'MAIL_SUPPRESSED' });
    expect(sendMock).not.toHaveBeenCalled();
    expect(mailLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failure',
          error: expect.stringMatching(/MAIL_SUPPRESSED/),
        }),
      }),
    );
  });

  it('treats missing suppression row as not suppressed', async () => {
    suppressionFindUnique.mockResolvedValue(null);
    sendMock.mockResolvedValue({ data: { id: 'ok_1' }, error: null });
    process.env.MAIL_OUTBOX_DISABLED = 'true';
    const { sendEmail, __resetMailClientsForTests } = await import(
      '../../services/email-service.js'
    );
    __resetMailClientsForTests();
    const result = await sendEmail({
      to: 'ok@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
    });
    expect(result.id).toBe('ok_1');
  });

  it('rejects when per-recipient hourly rate is exceeded', async () => {
    process.env.MAIL_OUTBOX_DISABLED = 'true';
    process.env.MAIL_RATE_PER_RECIPIENT_HOUR = '2';
    mailLogCount.mockResolvedValue(2);
    const { sendEmail, __resetMailClientsForTests } = await import(
      '../../services/email-service.js'
    );
    __resetMailClientsForTests();
    await expect(
      sendEmail({
        to: 'busy@example.com',
        subject: 'Hi',
        html: '<p>Hi</p>',
        tags: [{ name: 'template', value: 'login-alert' }],
      }),
    ).rejects.toMatchObject({ code: 'MAIL_RATE_RECIPIENT' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does not treat 0 send-log count as over limit', async () => {
    process.env.MAIL_OUTBOX_DISABLED = 'true';
    process.env.MAIL_RATE_PER_RECIPIENT_HOUR = '2';
    mailLogCount.mockResolvedValue(0);
    sendMock.mockResolvedValue({ data: { id: 'ok_2' }, error: null });
    const { sendEmail, __resetMailClientsForTests } = await import(
      '../../services/email-service.js'
    );
    __resetMailClientsForTests();
    await expect(
      sendEmail({
        to: 'fresh@example.com',
        subject: 'Hi',
        html: '<p>Hi</p>',
      }),
    ).resolves.toMatchObject({ id: 'ok_2' });
  });

  it('write-ahead outbox for critical OTP then marks sent', async () => {
    outboxCreate.mockResolvedValue({ id: 42 });
    outboxUpdate.mockResolvedValue({ id: 42 });
    sendMock.mockResolvedValue({ data: { id: 'otp_1' }, error: null });
    const { sendEmail, __resetMailClientsForTests } = await import(
      '../../services/email-service.js'
    );
    __resetMailClientsForTests();
    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'OTP',
      html: '<p>123456</p>',
      tags: [{ name: 'template', value: 'otp' }],
    });
    expect(result.outbox_id).toBe(42);
    expect(outboxCreate).toHaveBeenCalledTimes(1);
    expect(outboxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 42 },
        data: expect.objectContaining({
          status: 'sent',
          provider_message_id: 'otp_1',
        }),
      }),
    );
  });

  it('marks outbox failed without provider success when send throws', async () => {
    process.env.MAIL_RETRY_MAX_ATTEMPTS = '1';
    outboxCreate.mockResolvedValue({ id: 7 });
    outboxUpdate.mockResolvedValue({ id: 7 });
    sendMock.mockResolvedValue({
      data: null,
      error: { message: 'provider down', statusCode: 500 },
    });
    const { sendEmail, __resetMailClientsForTests } = await import(
      '../../services/email-service.js'
    );
    __resetMailClientsForTests();
    await expect(
      sendEmail({
        to: 'user@example.com',
        subject: 'OTP',
        html: '<p>1</p>',
        tags: [{ name: 'template', value: 'otp' }],
      }),
    ).rejects.toThrow();
    expect(outboxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  it('drain skips non-stale pending rows (empty findMany)', async () => {
    outboxFindMany.mockResolvedValue([]);
    const { drainMailOutbox } = await import('../../services/mail/outbox.js');
    const deliver = vi.fn();
    const r = await drainMailOutbox({ deliver, limit: 5 });
    expect(r.scanned).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('isCriticalMailTemplate false for empty / unknown', async () => {
    const { isCriticalMailTemplate } = await import('../../services/mail/rate-limit.js');
    expect(isCriticalMailTemplate('')).toBe(false);
    expect(isCriticalMailTemplate(null)).toBe(false);
    expect(isCriticalMailTemplate('login-alert')).toBe(false);
    expect(isCriticalMailTemplate('otp')).toBe(true);
  });
});

describe('mail webhook payload parse', () => {
  it('maps Resend-ish bounce to suppression reason', async () => {
    const { parseMailWebhookPayload } = await import(
      '../../routes/mail-webhook-routes.js'
    );
    expect(
      parseMailWebhookPayload({
        type: 'email.bounced',
        data: { email: 'Bad@Example.com' },
      }),
    ).toMatchObject({ email: 'bad@example.com', reason: 'bounce' });
  });

  it('rejects missing email', async () => {
    const { parseMailWebhookPayload } = await import(
      '../../routes/mail-webhook-routes.js'
    );
    expect(parseMailWebhookPayload({ type: 'email.bounced' }).error).toMatch(
      /Missing/,
    );
  });

  it('rejects null body', async () => {
    const { parseMailWebhookPayload } = await import(
      '../../routes/mail-webhook-routes.js'
    );
    expect(parseMailWebhookPayload(null).error).toMatch(/JSON object/);
  });
});
