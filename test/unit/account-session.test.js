import { describe, it, expect } from 'vitest';
import {
  isBlockedAccountStatus,
  isTokenStaleAgainstAccount,
  evaluateAccountSession,
} from '../../utils/account-session.js';

describe('account-session gate', () => {
  it('blocks suspended, banned, and deleted', () => {
    expect(isBlockedAccountStatus('suspended')).toBe(true);
    expect(isBlockedAccountStatus('banned')).toBe(true);
    expect(isBlockedAccountStatus('deleted')).toBe(true);
    expect(isBlockedAccountStatus('active')).toBe(false);
    expect(isBlockedAccountStatus(null)).toBe(false);
  });

  it('treats missing account as invalid', () => {
    const gate = evaluateAccountSession(null, 100);
    expect(gate.ok).toBe(false);
    expect(gate.status).toBe(401);
  });

  it('rejects deleted accounts', () => {
    const gate = evaluateAccountSession(
      { account_status: 'deleted', password_changed_at: null, sessions_invalidated_at: null },
      Math.floor(Date.now() / 1000),
    );
    expect(gate.ok).toBe(false);
    expect(gate.status).toBe(403);
    expect(gate.body.account_status).toBe('deleted');
  });

  it('rejects tokens minted before password change / force-logout', () => {
    const now = Date.now();
    const account = {
      account_status: 'active',
      password_changed_at: new Date(now),
      sessions_invalidated_at: new Date(now),
    };
    const oldIat = Math.floor((now - 10_000) / 1000);
    expect(isTokenStaleAgainstAccount(account, oldIat)).toBe(true);
    expect(evaluateAccountSession(account, oldIat).ok).toBe(false);

    const freshIat = Math.floor(now / 1000) + 1;
    expect(isTokenStaleAgainstAccount(account, freshIat)).toBe(false);
    expect(evaluateAccountSession(account, freshIat).ok).toBe(true);
  });
});
