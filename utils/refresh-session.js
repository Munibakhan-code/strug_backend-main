/**
 * Current refresh JWT jti per user — rotation invalidates prior refresh tokens.
 * Redis when available; in-process Map fallback (same caveats as auth rate limits).
 */
import crypto from 'crypto';
import redis, { isRedisReady } from './redis-client.js';

const TTL_SECS = 14 * 24 * 60 * 60;
const mem = new Map();
const MAX_MEM = 20_000;

function redisKey(userId) {
  return `auth:refresh-jti:${userId}`;
}

export function newRefreshJti() {
  return crypto.randomUUID();
}

export async function rememberUserRefreshJti(userId, jti) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0 || !jti) return;
  if (isRedisReady()) {
    try {
      await redis.set(redisKey(uid), String(jti), 'EX', TTL_SECS);
      return;
    } catch {
      /* fall through to memory */
    }
  }
  if (mem.size >= MAX_MEM) {
    const first = mem.keys().next().value;
    if (first != null) mem.delete(first);
  }
  mem.set(uid, { jti: String(jti), exp: Date.now() + TTL_SECS * 1000 });
}

/**
 * @returns {Promise<boolean>} true if the presented jti is allowed (or legacy / empty store)
 */
export async function isCurrentUserRefreshJti(userId, presentedJti) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return false;

  let stored = null;
  if (isRedisReady()) {
    try {
      stored = await redis.get(redisKey(uid));
    } catch {
      stored = null;
    }
  }
  if (stored == null) {
    const row = mem.get(uid);
    if (row) {
      if (row.exp <= Date.now()) {
        mem.delete(uid);
      } else {
        stored = row.jti;
      }
    }
  }

  // No stored jti yet (pre-rotation sessions): allow once; caller will remember the new one.
  if (stored == null || stored === '') return true;
  // Legacy refresh JWT without jti after we started storing: reject (force re-login).
  if (!presentedJti) return false;
  return String(stored) === String(presentedJti);
}

export async function clearUserRefreshJti(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return;
  mem.delete(uid);
  if (isRedisReady()) {
    try {
      await redis.del(redisKey(uid));
    } catch {
      /* ignore */
    }
  }
}
