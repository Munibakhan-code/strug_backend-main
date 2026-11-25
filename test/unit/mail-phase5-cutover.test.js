/**
 * Phase 5b: EMAIL_PASSWORD deprecation + SMTP cutover-status (no prod flip).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('mail Phase 5 cutover prep', () => {
  const envBackup = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...envBackup };
    delete process.env.MAIL_PROVIDER;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASSWORD;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.MAIL_OUTBOX_DISABLED;
    delete process.env.MAIL_WEBHOOK_SECRET;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('prefers SMTP_PASS over deprecated EMAIL_PASSWORD for generic SMTP', async () => {
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.EMAIL_USER = 'mail@strug.ca';
    process.env.SMTP_PASS = 'modern-pass';
    process.env.EMAIL_PASSWORD = 'legacy-pass';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    const { getSmtpConfig, __resetMailConfigWarningsForTests } = await import(
      '../../services/mail/config.js'
    );
    __resetMailConfigWarningsForTests();
    const smtp = getSmtpConfig();
    expect(smtp.pass).toBe('modern-pass');
    expect(smtp.legacy_email_password).toBe(false);
  });

  it('flags legacy EMAIL_PASSWORD when SMTP_PASS missing on generic host', async () => {
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.EMAIL_USER = 'mail@strug.ca';
    process.env.EMAIL_PASSWORD = 'legacy-pass';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    const { getSmtpConfig, __resetMailConfigWarningsForTests } = await import(
      '../../services/mail/config.js'
    );
    __resetMailConfigWarningsForTests();
    const smtp = getSmtpConfig();
    expect(smtp.pass).toBe('legacy-pass');
    expect(smtp.legacy_email_password).toBe(true);
  });

  it('does not treat empty EMAIL_PASSWORD as configured SMTP auth', async () => {
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.EMAIL_USER = 'mail@strug.ca';
    process.env.EMAIL_PASSWORD = '';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    delete process.env.SMTP_PASS;
    delete process.env.RESEND_API_KEY;
    const { isMailConfigured, getSmtpConfig, __resetMailConfigWarningsForTests } =
      await import('../../services/mail/config.js');
    __resetMailConfigWarningsForTests();
    expect(getSmtpConfig().pass).toBe('');
    expect(isMailConfigured()).toBe(false);
  });

  it('cutover status stays on resend default and reports code gates', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    process.env.MAIL_WEBHOOK_SECRET = 'whsec';
    const { getMailCutoverStatus } = await import(
      '../../services/mail/cutover-status.js'
    );
    const status = await getMailCutoverStatus();
    expect(status.production_default_provider).toBe('resend');
    expect(status.active_provider).toBe('resend');
    expect(status.gates.smtp_env_configured).toBe(true);
    expect(status.gates.bounce_webhook_secret).toBe(true);
    expect(status.code_ready).toBe(true);
    expect(status.checklist_doc).toMatch(/mail-smtp-cutover-gate/);
  });

  it('cutover code_ready is false when SMTP env missing', async () => {
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    process.env.RESEND_API_KEY = 're_test';
    process.env.SMTP_HOST = 'smtp.private.example';
    process.env.SMTP_USER = 'mail@strug.ca';
    process.env.SMTP_PASS = '';
    process.env.EMAIL_PASSWORD = '';
    const { __resetMailConfigWarningsForTests, isSmtpEnvConfigured } = await import(
      '../../services/mail/config.js'
    );
    __resetMailConfigWarningsForTests();
    expect(isSmtpEnvConfigured()).toBe(false);
    const { getMailCutoverStatus } = await import(
      '../../services/mail/cutover-status.js'
    );
    const status = await getMailCutoverStatus();
    expect(status.gates.smtp_env_configured).toBe(false);
    expect(status.code_ready).toBe(false);
  });

  it('cutover code_ready is false when outbox disabled', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'mail@strug.ca';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    process.env.MAIL_OUTBOX_DISABLED = 'true';
    const { getMailCutoverStatus } = await import(
      '../../services/mail/cutover-status.js'
    );
    const status = await getMailCutoverStatus();
    expect(status.gates.critical_outbox).toBe(false);
    expect(status.code_ready).toBe(false);
  });
});
