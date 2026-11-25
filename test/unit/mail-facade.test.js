/**
 * Phase 1 mail facade: provider selection, config fail-fast, attachment mapping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();
const domainsListMock = vi.fn();
const sendMailMock = vi.fn();
const mailLogCreate = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    constructor() {
      this.emails = { send: sendMock };
      this.domains = { list: domainsListMock };
    }
  },
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail: sendMailMock }),
  },
}));

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    mail_send_log: {
      create: (...args) => mailLogCreate(...args),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn(),
    },
    mail_suppression: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    mail_outbox: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn().mockResolvedValue({ id: 1 }),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  },
}));

vi.mock('../../utils/crypto.js', () => ({
  encryptEmailForStorage: (e) => `enc:${e}`,
  decrypt: (c) => String(c).replace(/^enc:/, ''),
}));

describe('mail config + facade', () => {
  const envBackup = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    sendMock.mockReset();
    domainsListMock.mockReset();
    sendMailMock.mockReset();
    mailLogCreate.mockReset();
    mailLogCreate.mockResolvedValue({ id: 1 });
    process.env = { ...envBackup };
    delete process.env.MAIL_PROVIDER;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASSWORD;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.MAIL_RETRY_MAX_ATTEMPTS;
    delete process.env.MAIL_RETRY_BASE_DELAY_MS;
    // Keep Phase 1 facade tests off the critical outbox path unless a case opts in.
    process.env.MAIL_OUTBOX_DISABLED = 'true';
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('defaults provider to resend and reports configured when key + from set', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    const { getMailProvider, isMailConfigured, resolveFromAddress } = await import(
      '../../services/mail/config.js'
    );
    expect(getMailProvider()).toBe('resend');
    expect(isMailConfigured()).toBe(true);
    expect(resolveFromAddress()).toBe('"Strug" <mail@strug.ca>');
  });

  it('fail-fast: unknown MAIL_PROVIDER throws', async () => {
    process.env.MAIL_PROVIDER = 'sendgrid';
    const { getMailProvider } = await import('../../services/mail/config.js');
    expect(() => getMailProvider()).toThrow(/Unknown MAIL_PROVIDER/);
  });

  it('isMailConfigured is false when Resend key missing', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    const { isMailConfigured } = await import('../../services/mail/config.js');
    expect(isMailConfigured()).toBe(false);
  });

  it('smtp is configured only with user + password + from', async () => {
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.EMAIL_USER = 'mail@strug.ca';
    process.env.EMAIL_PASSWORD = 'secret';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    const { isMailConfigured, getMailProvider } = await import(
      '../../services/mail/config.js'
    );
    expect(getMailProvider()).toBe('smtp');
    expect(isMailConfigured()).toBe(true);
  });

  it('Resend SMTP defaults auth to username resend + RESEND_API_KEY', async () => {
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.RESEND_API_KEY = 're_smtp_key';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    process.env.EMAIL_USER = 'mail@strug.ca';
    delete process.env.EMAIL_PASSWORD;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    const { getSmtpConfig, isMailConfigured } = await import(
      '../../services/mail/config.js'
    );
    const smtp = getSmtpConfig();
    expect(smtp.host).toBe('smtp.resend.com');
    expect(smtp.user).toBe('resend');
    expect(smtp.pass).toBe('re_smtp_key');
    expect(smtp.user).not.toBe('mail@strug.ca');
    expect(isMailConfigured()).toBe(true);
  });

  it('Resend SMTP ignores legacy EMAIL_PASSWORD in favor of RESEND_API_KEY', async () => {
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.RESEND_API_KEY = 're_smtp_key';
    process.env.EMAIL_PASSWORD = 'legacy-smtp-password';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_HOST;
    const { getSmtpConfig } = await import('../../services/mail/config.js');
    const smtp = getSmtpConfig();
    expect(smtp.user).toBe('resend');
    expect(smtp.pass).toBe('re_smtp_key');
    expect(smtp.pass).not.toBe('legacy-smtp-password');
  });

  it('SMTP_USER / SMTP_PASS override Resend SMTP defaults', async () => {
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.resend.com';
    process.env.SMTP_USER = 'custom-user';
    process.env.SMTP_PASS = 'custom-pass';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    const { getSmtpConfig } = await import('../../services/mail/config.js');
    const smtp = getSmtpConfig();
    expect(smtp.user).toBe('custom-user');
    expect(smtp.pass).toBe('custom-pass');
  });

  it('sendEmail rejects missing to/subject/html before provider call', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    const { sendEmail } = await import('../../services/email-service.js');
    await expect(sendEmail({ to: '', subject: 'x', html: '<p>x</p>' })).rejects.toThrow(
      /requires to, subject, and html/,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sendEmail fail-fast when not configured', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    const { sendEmail } = await import('../../services/email-service.js');
    await expect(
      sendEmail({ to: 'a@b.com', subject: 'Hi', html: '<p>Hi</p>' }),
    ).rejects.toThrow(/not configured/);
    expect(sendMock).not.toHaveBeenCalled();
    expect(mailLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failure' }),
      }),
    );
  });

  it('routes to Resend and returns provider message id', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    sendMock.mockResolvedValue({ data: { id: 're_msg_1' }, error: null });
    const { sendEmail, __resetMailClientsForTests } = await import(
      '../../services/email-service.js'
    );
    __resetMailClientsForTests();
    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      tags: [{ name: 'template', value: 'otp' }],
    });
    expect(result).toEqual(
      expect.objectContaining({ id: 're_msg_1', provider: 'resend' }),
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(mailLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'success',
          provider_message_id: 're_msg_1',
          template: 'otp',
        }),
      }),
    );
  });

  it('routes to SMTP when MAIL_PROVIDER=smtp', async () => {
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.EMAIL_USER = 'mail@strug.ca';
    process.env.EMAIL_PASSWORD = 'secret';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    sendMailMock.mockResolvedValue({ messageId: '<smtp-1@localhost>' });
    const { sendEmail, __resetMailClientsForTests } = await import(
      '../../services/email-service.js'
    );
    __resetMailClientsForTests();
    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
    });
    expect(result.provider).toBe('smtp');
    expect(result.id).toBe('<smtp-1@localhost>');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('records failure when provider send throws', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    process.env.MAIL_RETRY_MAX_ATTEMPTS = '1';
    sendMock.mockResolvedValue({
      data: null,
      error: { message: 'quota exceeded', statusCode: 429 },
    });
    const { sendEmail, __resetMailClientsForTests } = await import(
      '../../services/email-service.js'
    );
    __resetMailClientsForTests();
    await expect(
      sendEmail({ to: 'user@example.com', subject: 'Hi', html: '<p>Hi</p>' }),
    ).rejects.toThrow();
    expect(mailLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failure' }),
      }),
    );
  });

  it('maps CID attachments for Resend', async () => {
    const { mapAttachmentsForResend } = await import(
      '../../services/mail/providers/resend.js'
    );
    const mapped = mapAttachmentsForResend([
      {
        filename: 'logo.png',
        content: 'YWJj',
        contentType: 'image/png',
        contentId: 'struglogo',
      },
    ]);
    expect(mapped).toEqual([
      {
        filename: 'logo.png',
        content: 'YWJj',
        contentType: 'image/png',
        contentId: 'struglogo',
      },
    ]);
  });

  it('maps CID attachments for SMTP (contentId → cid)', async () => {
    const { mapAttachmentsForSmtp } = await import(
      '../../services/mail/providers/smtp.js'
    );
    const mapped = mapAttachmentsForSmtp([
      {
        filename: 'logo.png',
        content: Buffer.from('abc').toString('base64'),
        content_id: 'struglogo',
      },
    ]);
    expect(mapped[0].cid).toBe('struglogo');
    expect(mapped[0].filename).toBe('logo.png');
    expect(Buffer.isBuffer(mapped[0].content)).toBe(true);
  });

  it('isResendConfigured aliases isMailConfigured', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    const { isResendConfigured, isMailConfigured } = await import(
      '../../services/email-service.js'
    );
    expect(isResendConfigured()).toBe(isMailConfigured());
    expect(isResendConfigured()).toBe(true);
  });
});

describe('mail registry re-export', () => {
  it('exposes EMAIL_TEMPLATE_REGISTRY with template + subjectKey', async () => {
    const { EMAIL_TEMPLATE_REGISTRY } = await import('../../services/mail/registry.js');
    expect(EMAIL_TEMPLATE_REGISTRY.length).toBeGreaterThanOrEqual(20);
    expect(EMAIL_TEMPLATE_REGISTRY[0]).toEqual(
      expect.objectContaining({
        template: expect.any(String),
        subjectKey: expect.any(String),
        trigger: expect.any(String),
      }),
    );
  });
});
