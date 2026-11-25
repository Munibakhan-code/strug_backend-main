import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifySocketToken, assertSocketUserAllowed } from '../../sockets/socket-auth.js';
import prisma from '../../utils/prisma-client.js';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
  },
}));

// The SAME JWT key signs both app-user and board (staff) tokens, so this classifier is the
// one place that keeps the two identity systems apart on a Socket.IO connection. The invariant
// under test: a board token can NEVER surface a userId (→ never joins user-<id>), and a user
// token can NEVER surface a memberId (→ never joins board rooms).
describe('classifySocketToken — staff/user identity isolation', () => {
  it('classifies a board token as board (memberId only, no userId)', () => {
    const r = classifySocketToken({ permission: 'board', member_id: 7 });
    expect(r.kind).toBe('board');
    expect(r.memberId).toBe(7);
    expect(r.userId).toBeUndefined();
  });

  it('classifies an app-user token as user (userId only, no memberId)', () => {
    const r = classifySocketToken({ user_id: 42 });
    expect(r.kind).toBe('user');
    expect(r.userId).toBe(42);
    expect(r.memberId).toBeUndefined();
  });

  it('SECURITY: a board token that also carries a user_id is still board, and never leaks a userId', () => {
    const r = classifySocketToken({ permission: 'board', member_id: 7, user_id: 999 });
    expect(r.kind).toBe('board');
    expect(r.memberId).toBe(7);
    expect(r.userId).toBeUndefined(); // must NOT fall into a user-<999> room
  });

  it('SECURITY: a user token that claims permission other than board never becomes a board session', () => {
    const r = classifySocketToken({ user_id: 42, permission: 'user' });
    expect(r.kind).toBe('user');
    expect(r.memberId).toBeUndefined();
  });

  it('treats permission:board WITHOUT member_id as a (harmless) user session, not board', () => {
    const r = classifySocketToken({ permission: 'board' });
    expect(r.kind).toBe('user');
    expect(r.memberId).toBeUndefined();
  });

  it('does not throw on null/undefined/garbage tokens', () => {
    for (const bad of [null, undefined, {}, 0, 'x']) {
      const r = classifySocketToken(bad);
      expect(r.kind).toBe('user');
      expect(r.memberId).toBeUndefined();
    }
  });
});

describe('assertSocketUserAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows board tokens without hitting the user table', async () => {
    const r = await assertSocketUserAllowed({ permission: 'board', member_id: 3, iat: 1 });
    expect(r.ok).toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects deleted app users', async () => {
    prisma.user.findUnique.mockResolvedValue({
      account_status: 'deleted',
      password_changed_at: null,
      sessions_invalidated_at: null,
      role: 'USER',
    });
    const r = await assertSocketUserAllowed({
      user_id: 9,
      iat: Math.floor(Date.now() / 1000),
    });
    expect(r.ok).toBe(false);
  });

  it('fails closed when the account lookup throws', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));
    const r = await assertSocketUserAllowed({ user_id: 9, iat: 1 });
    expect(r.ok).toBe(false);
  });
});
