export const CATALOG_OFFER_MAX_MS = 48 * 3600 * 1000;

/** Scheduled Book Artist / catalog offers: hours to respond, not 45 seconds. */
export function catalogOfferExpiresAt(scheduledStart, nowMs = Date.now()) {
  const start = scheduledStart instanceof Date ? scheduledStart.getTime() : new Date(scheduledStart).getTime();
  const cap = nowMs + CATALOG_OFFER_MAX_MS;
  const beforeGig = Number.isFinite(start) ? start - 15 * 60 * 1000 : cap;
  const preferred = Math.min(cap, beforeGig);
  return new Date(Math.max(preferred, nowMs + 30 * 60 * 1000));
}
