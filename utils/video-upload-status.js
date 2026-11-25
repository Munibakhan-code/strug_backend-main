// Map the upload form's visibility to the video.status written at create.
//
// Public stays `pending` so the transcode worker can promote it to `safe` (feeds only list `safe`).
// Unlisted uses `pending_unlisted` — the worker resolves that to `unlisted`, never public
// (see workers/video-synthetic-probe.js).
// Private is stored as `private` immediately so play/watch-later 403 for everyone except the owner
// even before transcode finishes. Feeds already exclude anything that is not `safe`.

const OWNER_ONLY = new Set(['private', 'pending_private']);

export function statusFromUploadVisibility(visibility) {
  const v = String(visibility || 'public').trim().toLowerCase();
  if (v === 'private') return 'private';
  if (v === 'unlisted') return 'pending_unlisted';
  return 'pending';
}

export function isOwnerOnlyVideoStatus(status) {
  return OWNER_ONLY.has(status);
}
