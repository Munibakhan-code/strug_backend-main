/**
 * YouTube library import job helpers.
 * Busy jobs block a new import; worker crashes can leave status stuck on importing.
 */

export const YOUTUBE_IMPORT_BUSY = Object.freeze(['queued', 'listing', 'importing']);

/** Default: 30 minutes with no row update → treat as abandoned. */
export function youtubeImportStaleMs() {
  const n = Number(process.env.YOUTUBE_IMPORT_STALE_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30 * 60 * 1000;
}

export function isYoutubeImportBusy(status) {
  return YOUTUBE_IMPORT_BUSY.includes(status);
}

/**
 * @param {{ status?: string, updated_at?: Date|string|null }} job
 * @param {{ now?: Date, staleMs?: number }} [opts]
 */
export function isYoutubeImportStale(job, opts = {}) {
  if (!job || !isYoutubeImportBusy(job.status)) return false;
  const updated = job.updated_at ? new Date(job.updated_at).getTime() : NaN;
  if (!Number.isFinite(updated)) return true;
  const now = (opts.now || new Date()).getTime();
  const staleMs = opts.staleMs ?? youtubeImportStaleMs();
  return now - updated >= staleMs;
}

export function youtubeImportCancelMessage() {
  return 'Import cancelled so you can start a new one.';
}

export function youtubeImportStaleMessage() {
  return 'Import timed out (worker stopped updating). Cancelled automatically — you can start a new import.';
}
