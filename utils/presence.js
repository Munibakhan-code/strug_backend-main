// Ephemeral online-presence tracking (#275). Purely in-memory — a user is "online" while
// they hold at least one live socket (multiple tabs/devices are ref-counted). Nothing is
// persisted, so there is no migration and a restart simply re-derives presence as sockets
// reconnect. Presence changes are pushed only to a user's own chat peers (their private
// user-<id> rooms); presence is never broadcast platform-wide and can only be read via an
// authenticated, peer-scoped query.

// Hard cap on ids scanned per lookup, so a crafted request can't pin the event loop.
const MAX_LOOKUP = 300;

// user_id -> number of live sockets
const counts = new Map();

/** Register a new connection. Returns true only on the 0->1 transition (now online). */
export function markOnline(userId) {
  if (userId == null) return false;
  const n = counts.get(userId) || 0;
  counts.set(userId, n + 1);
  return n === 0;
}

/** Drop a connection. Returns true only on the 1->0 transition (now offline). */
export function markOffline(userId) {
  if (userId == null) return false;
  const n = counts.get(userId) || 0;
  if (n <= 1) { counts.delete(userId); return n === 1; }
  counts.set(userId, n - 1);
  return false;
}

export function isOnline(userId) {
  return counts.has(Number(userId));
}

/** Return the subset of the given ids that are currently online (numbers). Scans at most
 *  MAX_LOOKUP ids regardless of input size as a DoS backstop. */
export function filterOnline(userIds) {
  const list = Array.isArray(userIds) ? userIds.slice(0, MAX_LOOKUP) : [];
  const out = [];
  for (const raw of list) {
    const id = Number(raw);
    if (!Number.isNaN(id) && counts.has(id)) out.push(id);
  }
  return out;
}
