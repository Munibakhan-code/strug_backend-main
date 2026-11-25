import jwt from 'jsonwebtoken';
import { newRefreshJti } from './refresh-session.js';

export function jwTokens(login, name, permission, user_id, teamId) {
  if (!process.env.ACCESS_TOKEN_KEY || !process.env.REFRESH_TOKEN_KEY) {
    throw new Error('ACCESS_TOKEN_KEY and REFRESH_TOKEN_KEY must be set for JWT signing');
  }
  const user = { login, name, permission, user_id, teamId };
  // Short-lived access + long-lived refresh cookie. Clients already renew via /auth/refresh.
  const accessToken = jwt.sign(user, process.env.ACCESS_TOKEN_KEY, { expiresIn: '1h' });
  const refreshJti = newRefreshJti();
  const refreshToken = jwt.sign(
    { ...user, jti: refreshJti },
    process.env.REFRESH_TOKEN_KEY,
    { expiresIn: '14d' },
  );
  return { accessToken, refreshToken, refreshJti };
}

export function boardToken(member) {
  const payload = {
    member_id: member.member_id,
    email: member.email,
    name: member.name,
    permission: 'board',
    // Fingerprint of current password hash — password change invalidates older board JWTs
    // without a schema migration.
    pwd_fp: member.password ? String(member.password).slice(-12) : undefined,
  };
  return jwt.sign(payload, process.env.ACCESS_TOKEN_KEY, { expiresIn: '7d' });
}
