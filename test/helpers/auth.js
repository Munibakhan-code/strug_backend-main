import jwt from 'jsonwebtoken';

// Mint an access token exactly like the app expects: middleware/authentication.js verifies
// with process.env.ACCESS_TOKEN_KEY and reads user_id off the payload. team_id/profile_id/
// role are optional (the middleware re-derives role + profile_id from the DB).
export function tokenFor(user, extra = {}) {
  return jwt.sign(
    {
      user_id: user.user_id,
      team_id: user.team_id ?? null,
      profile_id: user.profile_id ?? null,
      role: user.role ?? 'USER',
      ...extra,
    },
    process.env.ACCESS_TOKEN_KEY,
    { expiresIn: '1h' },
  );
}

export const authHeader = (user, extra) => ({ Authorization: `Bearer ${tokenFor(user, extra)}` });
