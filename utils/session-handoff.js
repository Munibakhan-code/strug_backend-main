/**
 * One-time session handoff for proxied logins (strug.ca → app.strug.ca).
 *
 * Login Set-Cookie never reaches the browser when Next proxies /auth/login, and
 * minting a 14d refresh from the access JWT alone was removed (#1272). Instead the
 * API returns an opaque `session_handoff` that the app claims once (withCredentials)
 * to set the httpOnly refresh cookie on api.strug.ca.
 *
 * TTL is short; consume is single-use (GETDEL / delete-after-read).
 */
import crypto from 'crypto';
import redis, { isRedisReady } from './redis-client.js';

const TTL_SECS = 120;
const mem = new Map();
const MAX_MEM = 10_000;

function redisKey(id) {
  return `auth:session-handoff:${id}`;
}

/**
 * @param {string} refreshToken
 * @param {number|string} userId
 * @returns {Promise<string|null>} opaque handoff id, or null if storage failed
 */
export async function createSessionHandoff(refreshToken, userId) {
  if (!refreshToken || userId == null || userId === '') return null;
  const id = crypto.randomBytes(32).toString('base64url');
  const payload = JSON.stringify({
    refreshToken: String(refreshToken),
    userId: Number(userId),
  });

  if (isRedisReady()) {
    try {
      await redis.set(redisKey(id), payload, 'EX', TTL_SECS);
      return id;
    } catch {
      /* fall through */
    }
  }

  if (mem.size >= MAX_MEM) {
    const first = mem.keys().next().value;
    if (first != null) mem.delete(first);
  }
  mem.set(id, { payload, exp: Date.now() + TTL_SECS * 1000 });
  return id;
}

/**
 * @param {string} id
 * @returns {Promise<{ refreshToken: string, userId: number }|null>}
 */
export async function consumeSessionHandoff(id) {
  if (!id || typeof id !== 'string' || id.length < 16 || id.length > 128) return null;

  let raw = null;
  if (isRedisReady()) {
    try {
      if (typeof redis.getdel === 'function') {
        raw = await redis.getdel(redisKey(id));
      } else {
        raw = await redis.get(redisKey(id));
        if (raw != null) await redis.del(redisKey(id));
      }
    } catch {
      raw = null;
    }
  }

  if (raw == null) {
    const row = mem.get(id);
    mem.delete(id);
    if (!row || row.exp <= Date.now()) return null;
    raw = row.payload;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.refreshToken || parsed.userId == null) return null;
    const userId = Number(parsed.userId);
    if (!Number.isFinite(userId) || userId <= 0) return null;
    return { refreshToken: String(parsed.refreshToken), userId };
  } catch {
    return null;
  }
}

/** Test helper */
export function _resetSessionHandoffMemForTests() {
  mem.clear();
}
