import { describe, it, expect, vi, beforeEach } from 'vitest';

const mailLogCreate = vi.fn();
const mailLogCount = vi.fn();
const mailLogFindMany = vi.fn();

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    mail_send_log: {
      create: (...a) => mailLogCreate(...a),
      count: (...a) => mailLogCount(...a),
      findMany: (...a) => mailLogFindMany(...a),
    },
  },
}));

describe('mail send-log helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mailLogCreate.mockResolvedValue({ id: 1 });
  });

  it('hashes and hints recipients without storing the full address', async () => {
    const { hashMailRecipient, hintMailRecipient, recordMailSend } = await import(
      '../../services/mail/send-log.js'
    );
    const hash = hashMailRecipient('User@Example.com');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashMailRecipient('user@example.com'));
    expect(hintMailRecipient('user@example.com')).toBe('u***@example.com');
    expect(hintMailRecipient('user@example.com')).not.toContain('user@');

    await recordMailSend({
      provider: 'resend',
      to: 'user@example.com',
      subject: 'OTP',
      template: 'otp',
      status: 'success',
      provider_message_id: 'msg_1',
    });

    const data = mailLogCreate.mock.calls[0][0].data;
    expect(data.to_hash).toBe(hash);
    expect(data.to_hint).toBe('u***@example.com');
    expect(JSON.stringify(data)).not.toMatch(/user@example\.com/i);
  });

  it('recordMailSend swallows prisma errors (best-effort)', async () => {
    mailLogCreate.mockRejectedValueOnce(new Error('db down'));
    const { recordMailSend } = await import('../../services/mail/send-log.js');
    await expect(
      recordMailSend({
        provider: 'resend',
        to: 'a@b.com',
        status: 'failure',
        error: 'boom',
      }),
    ).resolves.toBeUndefined();
  });

  it('getMailHealthSummary returns 24h counts and recent rows', async () => {
    mailLogCount
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(3);
    mailLogFindMany
      .mockResolvedValueOnce([{ id: 1, status: 'failure', error: 'quota' }])
      .mockResolvedValueOnce([{ id: 2, status: 'success' }]);
    const { getMailHealthSummary } = await import('../../services/mail/send-log.js');
    const summary = await getMailHealthSummary({ hours: 24, recentLimit: 10 });
    expect(summary.counts).toEqual({ total: 10, success: 7, failure: 3 });
    expect(summary.recent_failures[0].error).toBe('quota');
    expect(summary.recent).toHaveLength(1);
  });

  it('templateFromTags / verticalFromTags handle empty and malformed', async () => {
    const { templateFromTags, verticalFromTags } = await import(
      '../../services/mail/send-log.js'
    );
    expect(templateFromTags(undefined)).toBeNull();
    expect(templateFromTags([])).toBeNull();
    expect(templateFromTags([{ name: 'template', value: 'otp' }])).toBe('otp');
    expect(verticalFromTags([{ name: 'vertical', value: 'auth' }])).toBe('auth');
  });

  it('sanitizeMailSubject redacts embedded emails before storage', async () => {
    const { sanitizeMailSubject, sanitizeMailText, recordMailSend } = await import(
      '../../services/mail/send-log.js'
    );
    expect(sanitizeMailSubject('New support message from alice@strug.ca')).toBe(
      'New support message from [redacted-email]',
    );
    expect(sanitizeMailSubject(null)).toBeNull();
    expect(sanitizeMailSubject('')).toBeNull();
    expect(sanitizeMailText('SMTP failed for bob@example.com', 1000)).toBe(
      'SMTP failed for [redacted-email]',
    );

    await recordMailSend({
      provider: 'resend',
      to: 'ops@strug.ca',
      subject: 'Alert for bob@example.com',
      status: 'failure',
      error: 'Delivery failed: bob@example.com mailbox unavailable',
    });
    const stored = mailLogCreate.mock.calls.at(-1)[0].data;
    expect(stored.subject).toBe('Alert for [redacted-email]');
    expect(stored.error).toBe('Delivery failed: [redacted-email] mailbox unavailable');
    expect(JSON.stringify(stored)).not.toMatch(/bob@example\.com/i);
  });
});
