/**
 * Shared account/session gate used by HTTP auth middleware, /auth/refresh, and sockets.
 * Keep these checks identical so a revoked or blocked account cannot survive on one channel.
 */

export const BLOCKED_ACCOUNT_STATUSES = new Set(['suspended', 'banned', 'deleted']);

export function isBlockedAccountStatus(status) {
  return BLOCKED_ACCOUNT_STATUSES.has(String(status || '').toLowerCase());
}

/** True when the JWT was minted before a password change or force-logout. */
export function isTokenStaleAgainstAccount(account, tokenIat) {
  if (!account || tokenIat == null) return false;
  const iat = Number(tokenIat);
  if (!Number.isFinite(iat)) return false;

  if (account.sessions_invalidated_at) {
    const invalidatedSec = Math.floor(new Date(account.sessions_invalidated_at).getTime() / 1000);
    if (iat < invalidatedSec) return true;
  }
  if (account.password_changed_at) {
    const changedSec = Math.floor(new Date(account.password_changed_at).getTime() / 1000);
    if (iat < changedSec) return true;
  }
  return false;
}

/**
 * Evaluate a loaded user row (+ JWT iat) for API/socket access.
 * @returns {{ ok: true } | { ok: false, status: number, body: object|string }}
 */
export function evaluateAccountSession(account, tokenIat) {
  if (!account) {
    return { ok: false, status: 401, body: 'Invalid token' };
  }
  if (isBlockedAccountStatus(account.account_status)) {
    return {
      ok: false,
      status: 403,
      body: {
        message: `Account ${account.account_status}`,
        account_status: account.account_status,
      },
    };
  }
  if (isTokenStaleAgainstAccount(account, tokenIat)) {
    return { ok: false, status: 401, body: 'Invalid token' };
  }
  return { ok: true };
}

export const ACCOUNT_SESSION_SELECT = {
  password_changed_at: true,
  role: true,
  account_status: true,
  sessions_invalidated_at: true,
};
