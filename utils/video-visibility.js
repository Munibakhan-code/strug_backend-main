// utils/video-visibility.js
//
// ONE definition of "can a viewer see this video", shared by every viewer-facing surface.
//
// Why this exists: the visibility rules had drifted apart across six call sites. /feed required
// status+processing_status+channel.is_active+not-banned; /suggest omitted the not-banned check;
// /home-feed instead required a non-null hls_url and a recency window but skipped processing_status
// and is_active entirely; /categories checked only status. So the same video could be visible in one
// rail and invisible in another, which is impossible to reason about and impossible to debug.
//
// The null-relation bug this also fixes:
//   `user: { social_profiles: { is_banned: false } }`
// reads as "not banned", but `social_profiles` is an OPTIONAL to-one relation, and Prisma compiles a
// to-one filter into a clause that REQUIRES the related row to exist:
//   j2.is_banned = false AND (j2.profile_id IS NOT NULL)     <-- verified against the real DB
// A creator who has a channel but never created a social profile therefore has EVERY video excluded
// from /feed and /search — while their channel/profile page (which filters on `status` alone) still
// lists those same videos. That is the "it plays on my profile but never shows up in Videos" report.
// Channel creation does not create a social_profile (it's made on demand by social-profile-routes),
// so this is reachable for any creator who hasn't touched the social product.
//
// A missing profile means "this creator was never banned", so it must NOT hide the video.

/**
 * The creator-side guard: channel is live, and the owner is not banned.
 * A NULL social_profile is treated as "not banned" rather than as "hide".
 */
export function visibleChannelWhere() {
  return {
    is_active: true,
    user: {
      OR: [
        { social_profiles: { is: null } },      // no social profile => never banned
        { social_profiles: { is_banned: false } },
      ],
    },
  };
}

/**
 * The full predicate for a video a viewer is allowed to see.
 * `status: 'safe'` is the visibility flag; `processing_status: 'done'` means the transcode finished
 * and an HLS ladder actually exists to play.
 *
 * @param {object} [extra] additional AND-ed conditions (video_type, category, channel_id, ...)
 */
export function visibleVideoWhere(extra = {}) {
  return {
    status: 'safe',
    processing_status: 'done',
    ...extra,
    channel: { ...visibleChannelWhere(), ...(extra.channel || {}) },
  };
}

/**
 * Explains why a single video row is NOT viewer-visible. Returns [] when it is visible.
 * Used by the creator-facing listings so the UI can state the real reason instead of showing a
 * dead video as "Published", and by scripts/diagnose-video-visibility.js.
 *
 * Expects a row selected with: status, processing_status, hls_url, and
 * channel: { is_active, user: { social_profiles: { is_banned } } }
 */
export function visibilityBlockers(video) {
  const blockers = [];
  if (video?.status === 'banned') blockers.push('banned_by_moderation');
  // Capacity-only PR: `pending_private` support is intentionally NOT included.
  // The schema now disallows uploading `private` so this keeps private handling tight.
  else if (video?.status === 'private') blockers.push('private');
  else if (video?.status !== 'safe') blockers.push('not_published');       // 'pending' / 'pending_safe' / 'unlisted'

  if (video?.processing_status === 'error') blockers.push('processing_failed');
  else if (video?.processing_status !== 'done') blockers.push('still_processing');

  if (video?.channel && video.channel.is_active === false) blockers.push('channel_inactive');
  if (video?.channel?.user?.social_profiles?.is_banned === true) blockers.push('creator_banned');
  if (video?.processing_status === 'done' && !video?.hls_url) blockers.push('missing_hls');

  return blockers;
}

/** The select fragment visibilityBlockers() needs. */
export const VISIBILITY_SELECT = {
  status: true,
  processing_status: true,
  hls_url: true,
  channel: {
    select: {
      is_active: true,
      user: { select: { social_profiles: { select: { is_banned: true } } } },
    },
  },
};

/**
 * Creator-facing state for one of their own videos. This is what the creator's Content tab should
 * render — never a bare "Published".
 */
export function creatorVisibility(video) {
  const blockers = visibilityBlockers(video);
  if (!blockers.length) return { state: 'published', visible_to_viewers: true, blockers: [] };

  // Pick the most explanatory single state for the badge.
  const state =
    blockers.includes('banned_by_moderation') ? 'removed'
    : blockers.includes('processing_failed') ? 'failed'
    : blockers.includes('still_processing') ? 'processing'
    : blockers.includes('private') ? 'private'
    : blockers.includes('channel_inactive') ? 'channel_inactive'
    : blockers.includes('creator_banned') ? 'creator_banned'
    : blockers.includes('missing_hls') ? 'failed'
    : 'not_published';

  return { state, visible_to_viewers: false, blockers };
}
