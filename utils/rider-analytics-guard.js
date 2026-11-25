const REQUEST_LIMIT = 60;
const WINDOW_MS = 60_000;
const DEDUPE_MS = 5 * 60_000;
const MAX_USERS = 5_000;
const MAX_FINGERPRINTS_PER_USER = 100;

const userBuckets = new Map();

function evictOldestUser() {
  const oldest = userBuckets.keys().next().value;
  if (oldest !== undefined) userBuckets.delete(oldest);
}

export function checkRiderAnalyticsGuard(userId, fingerprint, now = Date.now()) {
  let bucket = userBuckets.get(userId);
  if (!bucket) {
    if (userBuckets.size >= MAX_USERS) evictOldestUser();
    bucket = { count: 0, resetAt: now + WINDOW_MS, fingerprints: new Map() };
    userBuckets.set(userId, bucket);
  } else if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + WINDOW_MS;
  }

  bucket.count += 1;
  if (bucket.count > REQUEST_LIMIT) {
    return {
      throttled: true,
      duplicate: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
    };
  }

  for (const [key, expiresAt] of bucket.fingerprints) {
    if (expiresAt <= now) bucket.fingerprints.delete(key);
  }
  const duplicate = bucket.fingerprints.has(fingerprint);
  if (!duplicate) {
    if (bucket.fingerprints.size >= MAX_FINGERPRINTS_PER_USER) {
      bucket.fingerprints.delete(bucket.fingerprints.keys().next().value);
    }
    bucket.fingerprints.set(fingerprint, now + DEDUPE_MS);
  }
  return { throttled: false, duplicate };
}

export function resetRiderAnalyticsGuard() {
  userBuckets.clear();
}
