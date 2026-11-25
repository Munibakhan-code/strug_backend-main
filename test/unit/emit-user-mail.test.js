/**
 * emit-user-mail: recipient load edges.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const emit = vi.fn();

vi.mock('../../utils/prisma-client.js', () => ({
  default: { user: { findUnique: (...a) => findUnique(...a) } },
}));

vi.mock('../../utils/crypto.js', () => ({
  decrypt: (v) => (String(v).startsWith('enc:') ? String(v).slice(4) : v),
}));

vi.mock('../../utils/mailer-event.js', () => ({
  default: { emit: (...a) => emit(...a), on: vi.fn() },
}));

describe('emit-user-mail', () => {
  beforeEach(() => {
    vi.resetModules();
    findUnique.mockReset();
    emit.mockReset();
  });

  it('emits mail when user has decryptable email', async () => {
    findUnique.mockResolvedValue({
      user_id: 7,
      email: 'enc:a@b.com',
      language: 'en',
      name: 'Ada',
    });
    const { emitUserMail } = await import('../../utils/emit-user-mail.js');
    const r = await emitUserMail({
      userId: 7,
      templateName: 'dating-match',
      subjectKey: 'emails.dating_match.subject',
      variables: { cta_url: 'https://app.strug.ca/dating' },
    });
    expect(r.ok).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      'send_email',
      expect.objectContaining({
        to: 'a@b.com',
        templateName: 'dating-match',
        variables: expect.objectContaining({ name: 'Ada' }),
      }),
    );
  });

  it('returns no_email when user missing', async () => {
    findUnique.mockResolvedValue(null);
    const { emitUserMail } = await import('../../utils/emit-user-mail.js');
    const r = await emitUserMail({
      userId: 99,
      templateName: 'dating-match',
      subjectKey: 'emails.dating_match.subject',
    });
    expect(r).toEqual({ ok: false, reason: 'no_email' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects non-positive user id', async () => {
    const { loadMailRecipient } = await import('../../utils/emit-user-mail.js');
    expect(await loadMailRecipient(0)).toBeNull();
    expect(await loadMailRecipient('x')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
