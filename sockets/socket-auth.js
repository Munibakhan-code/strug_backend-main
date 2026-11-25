// sockets/socket-auth.js
//
// Socket handshake identity classification. The SAME JWT signing key (ACCESS_TOKEN_KEY)
// signs both app-user tokens and internal board (staff) tokens, so the socket layer must
// decide which identity a connection is — and keep the two strictly separate:
//   • a board token (permission==='board' + member_id) is a STAFF session → it must only
//     ever join board-member-<id> / staff_chat_<id> rooms, NEVER a user-<id> room.
//   • anything else is an app-user session → the existing user path, NEVER a board room.
//
// This is pulled out as a pure function so the isolation invariant is unit-testable without
// booting Socket.IO (see test/unit/socket-auth.test.js).

import prisma from '../utils/prisma-client.js';
import {
  ACCOUNT_SESSION_SELECT,
  evaluateAccountSession,
} from '../utils/account-session.js';

export function classifySocketToken(decoded) {
  // permission wins: a board token is board even if it somehow also carried a user_id claim.
  if (decoded?.permission === 'board' && decoded?.member_id) {
    return { kind: 'board', memberId: decoded.member_id, userId: undefined };
  }
  // Legacy-permissive app-user path (unchanged): any other valid token is a user session.
  return { kind: 'user', userId: decoded?.user_id, memberId: undefined };
}

/**
 * App-user sockets must pass the same account/session gate as HTTP auth. Board tokens skip
 * the user table (staff identity lives elsewhere). Fail closed on DB errors.
 */
export async function assertSocketUserAllowed(decoded) {
  const cls = classifySocketToken(decoded);
  if (cls.kind === 'board') return { ok: true, classification: cls };

  if (!cls.userId) {
    return { ok: false, error: 'Invalid token' };
  }

  let account;
  try {
    account = await prisma.user.findUnique({
      where: { user_id: cls.userId },
      select: ACCOUNT_SESSION_SELECT,
    });
  } catch (err) {
    console.error('[socket-auth] account gate failed:', err?.message || err);
    return { ok: false, error: 'Authentication temporarily unavailable' };
  }

  const gate = evaluateAccountSession(account, decoded?.iat);
  if (!gate.ok) {
    const msg = typeof gate.body === 'string'
      ? gate.body
      : (gate.body?.message || 'Invalid token');
    return { ok: false, error: msg };
  }

  return { ok: true, classification: cls, account };
}
