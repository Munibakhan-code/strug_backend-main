import redis, { isRedisReady } from './redis-client.js';
import { dropCachedPrefix } from './response-cache.js';

// Board #442: "deleting a video is not deleting it from other sides of the platform such as
// profile and social".
//
// DELETE /video/:id is a genuine hard delete — after it runs, no query can return the row. The
// video kept showing up because the *read* paths cache their responses in Redis and nothing ever
// invalidated them:
//
//   video:feed:*            EX 120  — also serves the channel-scoped grid (ch:<channelId>), i.e.
//                                     the creator's public channel/profile video list
//   video:suggest:*         EX 300
//   video:search:*          EX 300
//   video:recommendations:* EX 120
//
// so a deleted video stayed visible for up to 5 minutes. Bust them on delete.
//
// SCAN (not KEYS) so this never blocks the server on a large keyspace. The key families are small
// and deletes are rare, so the extra round-trips are irrelevant.
const VIDEO_CACHE_PATTERNS = [
  'video:feed:*',
  'video:suggest:*',
  'video:search:*',
  'video:recommendations:*',
];

/**
 * Drop every cached video read-path response. Call after any mutation that changes which videos
 * are visible (delete, and any future unpublish/ban).
 *
 * Without Redis the same responses are cached per process instead (response-cache.js), so those
 * entries have to be dropped here too or a deleted video would linger in Up Next — the very bug
 * this file exists for.
 *
 * @returns {Promise<number>} number of keys removed
 */
export async function invalidateVideoCaches() {
  let removed = VIDEO_CACHE_PATTERNS.reduce(
    (n, pattern) => n + dropCachedPrefix(pattern.replace(/\*$/, '')),
    0,
  );
  if (!isRedisReady()) return removed;

  for (const pattern of VIDEO_CACHE_PATTERNS) {
    let cursor = '0';
    do {
      const reply = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      // The client returns null for every command once Redis drops. Stop rather than crash the
      // delete — the cache entries will expire on their own within 5 minutes.
      if (!Array.isArray(reply)) break;
      const [next, keys] = reply;
      cursor = String(next);
      if (keys?.length) {
        await redis.del(...keys);
        removed += keys.length;
      }
    } while (cursor !== '0');
  }
  return removed;
}
