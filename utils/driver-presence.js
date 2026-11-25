/**
 * Rideshare driver presence — is_online alone is not enough.
 * A driver must have is_online=true AND a recent last_ping (GPS/status heartbeat) to be
 * dispatch-eligible. is_online itself is driver-controlled only (PATCH /driver-profile/me/status)
 * — it does NOT get auto-flipped off by a stale ping anymore, so the toggle survives a closed
 * tab/app and offers still reach the driver by push. A driver with a stale ping still shows
 * "Online" in their own UI, but presentDriverWhereExtra/isDriverPresentForDispatch below silently
 * exclude them from nearest-driver matching until their location refreshes (reopening the app).
 */

export const DRIVER_PRESENCE_STALE_MS = Number(process.env.RIDE_DRIVER_PRESENCE_STALE_SEC ?? 180) * 1000;

export function driverPresenceCutoff(now = Date.now()) {
  return new Date(now - DRIVER_PRESENCE_STALE_MS);
}

/** True when profile is actively available for dispatch (online + recent ping). */
export function isDriverPresentForDispatch(profile, now = Date.now()) {
  if (!profile || profile.is_online !== true) return false;
  if (!profile.last_ping) return false;
  const pingMs = new Date(profile.last_ping).getTime();
  if (Number.isNaN(pingMs)) return false;
  return now - pingMs <= DRIVER_PRESENCE_STALE_MS;
}

/**
 * Force-flip drivers offline when is_online=true but heartbeat is missing/stale. Not called
 * automatically (see the module comment above) — the online toggle is driver-controlled only now.
 * Kept for ops/admin use (e.g. manually clearing a ghost-online driver from a support tool).
 * Returns count of users expired.
 */
export async function expireStaleOnlineDrivers(prisma) {
  const cutoff = driverPresenceCutoff();
  const stale = await prisma.driver_profile.findMany({
    where: {
      is_online: true,
      OR: [{ last_ping: null }, { last_ping: { lt: cutoff } }],
    },
    select: { user_id: true },
    orderBy: { driver_profile_id: 'asc' },
  });

  const userIds = [...new Set(stale.map((r) => r.user_id).filter(Boolean))];
  if (!userIds.length) return 0;

  await prisma.driver_profile.updateMany({
    where: { user_id: { in: userIds }, is_online: true },
    data: { is_online: false },
  });

  return userIds.length;
}

/** Prisma where-clause fragment for dispatch-eligible drivers. */
export function presentDriverWhereExtra() {
  return {
    is_online: true,
    last_ping: { gte: driverPresenceCutoff() },
  };
}
