/**
 * Watch-edge "Subs" drawer: the newest long-form uploads from the channels a viewer subscribes to,
 * newest first.
 *
 * This used to return one row per channel, so a viewer following two channels saw two videos no
 * matter how much those channels had posted, and opening one (it is excluded while playing) simply
 * swapped in that channel's next upload — the drawer read as a trickle of single videos rather
 * than a feed. The list is now plain recency across every subscribed channel: today's upload above
 * yesterday's, whoever posted it.
 */

/** Videos newer than this window get is_new / NEW badge. */
export const SUB_UPLOAD_NEW_MS = 72 * 60 * 60 * 1000;
/** Max subscribed channels to read uploads from (keeps the `in` clause bounded). */
export const SUB_UPLOAD_CHANNEL_SCAN = 40;

/** Default / ceiling for ?limit= — matches the creator-picks drawer next door. */
export const SUB_UPLOAD_DEFAULT_LIMIT = 12;
export const SUB_UPLOAD_MAX_LIMIT = 24;

/**
 * Parse ?limit=&exclude= for GET /channel/subscriptions/uploads.
 * Empty / NaN / non-positive limit → default 12 (clamped 1–24). exclude floored when valid.
 */
export function parseSubscriptionUploadsQuery(query = {}) {
  const limitRaw = Number(query.limit);
  const limit =
    query.limit === undefined || query.limit === '' || !Number.isFinite(limitRaw) || limitRaw <= 0
      ? SUB_UPLOAD_DEFAULT_LIMIT
      : Math.min(Math.max(Math.floor(limitRaw), 1), SUB_UPLOAD_MAX_LIMIT);
  const excludeRaw = Number(query.exclude);
  const excludeId =
    Number.isFinite(excludeRaw) && excludeRaw > 0 ? Math.floor(excludeRaw) : null;
  return { limit, excludeId };
}

export function isNewSubscriptionUpload(createdAt, nowMs = Date.now()) {
  if (!createdAt) return false;
  const t = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= SUB_UPLOAD_NEW_MS;
}
