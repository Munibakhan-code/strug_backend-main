// sockets/staff-presence.js
// Lightweight in-memory presence for board (staff) members. Ref-counts live board sockets so a
// member with multiple tabs is "online" until the last one disconnects. Single-replica only
// (matches the current socket setup); a Redis-backed presence would be needed to scale out.
const counts = new Map();

export function staffOnline(memberId) {
  const id = Number(memberId);
  counts.set(id, (counts.get(id) || 0) + 1);
}

export function staffOffline(memberId) {
  const id = Number(memberId);
  const next = (counts.get(id) || 0) - 1;
  if (next <= 0) counts.delete(id);
  else counts.set(id, next);
}

export function isStaffOnline(memberId) {
  return counts.has(Number(memberId));
}

export function onlineStaffIds() {
  return [...counts.keys()];
}
