import redis, { isRedisReady } from './redis-client.js';

// Read-path caches here were written as Redis-only. Prod has never had a Redis provisioned
// (see redis-client.js), so every one of them is a permanent miss: /video/recommendations
// recomputes the whole Up Next engine — a trending_topic table scan, a title/description
// `contains` OR scan and a watch_history join — on every single video open. That is a large part
// of why reopening a video on a phone waited seconds on the API.
//
// So: keep Redis as the cache when it is there (shared across instances, unchanged behaviour),
// and fall back to a small per-process cache when it is not. Keys are the same strings either
// way, which is what lets invalidateVideoCaches() drop both.
const MAX_ENTRIES = 500;
// Redis is shared, so invalidateVideoCaches() can reach every entry. A per-process cache cannot:
// deleting a video only clears the cache of the instance that served the delete, and #442 is
// exactly the bug where a deleted video kept showing up. So the fallback holds entries for at most
// half a minute — long enough to absorb the burst of repeated requests one viewing session makes,
// short enough that a delete can only linger that long on another instance.
const MAX_MEMORY_TTL_SECONDS = 30;
const memory = new Map();

function readMemory(key) {
	const hit = memory.get(key);
	if (!hit) return null;
	if (hit.expiresAt <= Date.now()) {
		memory.delete(key);
		return null;
	}
	return hit.value;
}

function writeMemory(key, value, ttlSeconds) {
	// Insertion-ordered Map: the first key is the oldest, so this is a cheap bound on memory for a
	// process that may see a lot of distinct video/user combinations.
	if (memory.size >= MAX_ENTRIES && !memory.has(key)) {
		const oldest = memory.keys().next().value;
		if (oldest !== undefined) memory.delete(oldest);
	}
	const ttl = Math.min(ttlSeconds, MAX_MEMORY_TTL_SECONDS);
	memory.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
}

/** Cached JSON payload for `key`, or null on a miss. */
export async function readCachedJson(key) {
	if (isRedisReady()) {
		try {
			const cached = await redis.get(key);
			if (cached) {
				const parsed = JSON.parse(cached);
				// Keep a short local copy so a transient Redis outage can still fail open without
				// forcing every request onto the database at once.
				writeMemory(key, parsed, MAX_MEMORY_TTL_SECONDS);
				return parsed;
			}
		} catch {
			// Redis transport errors and corrupt entries are cache misses, never request failures.
		}
	}
	return readMemory(key);
}

/** Store `value` under `key` for `ttlSeconds`. Never throws: a cache write must not fail a read. */
export async function writeCachedJson(key, value, ttlSeconds) {
	// Always keep the bounded short-lived fallback warm. This is also what lets a request continue
	// safely if Redis reports ready and then fails between the readiness check and SET.
	writeMemory(key, value, ttlSeconds);
	if (isRedisReady()) {
		try {
			await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
		} catch {
			// Best-effort cache write: the durable response path must not fail with Redis.
		}
	}
}

/**
 * Drop every in-process entry whose key starts with `prefix`. The Redis side is handled by the
 * SCAN in invalidateVideoCaches; this is its counterpart for a Redis-less process.
 *
 * @returns {number} entries removed
 */
export function dropCachedPrefix(prefix) {
	let removed = 0;
	for (const key of memory.keys()) {
		if (key.startsWith(prefix)) {
			memory.delete(key);
			removed++;
		}
	}
	return removed;
}

/** Test seam. */
export function clearMemoryCache() {
	memory.clear();
}
