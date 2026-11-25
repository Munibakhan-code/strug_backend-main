/** Creator's Choice — helpers for creator CRUD and subscriber feed shaping. */

export const MAX_CREATOR_PICKS = 12;
export const DEFAULT_SUBSCRIBER_PICKS_LIMIT = 12;
export const MAX_SUBSCRIBER_PICKS_LIMIT = 24;
export const MAX_PICK_NOTE_LEN = 200;

export const PICK_TYPES = new Set(['video', 'channel']);

/** Card-only video fields — no playback URLs on discovery surfaces. */
export const CREATOR_PICK_VIDEO_SELECT = {
  video_id: true,
  public_id: true,
  slug: true,
  title: true,
  thumbnail_url: true,
  duration_sec: true,
  views_count: true,
  video_type: true,
  category: true,
  created_at: true,
  channel_id: true,
  status: true,
  processing_status: true,
  channel: {
    select: {
      channel_id: true,
      display_name: true,
      handle: true,
      profile_pic_url: true,
      is_active: true,
      user: { select: { social_profiles: { select: { is_banned: true } } } },
    },
  },
};

export const CREATOR_PICK_CHANNEL_SELECT = {
  channel_id: true,
  display_name: true,
  handle: true,
  profile_pic_url: true,
  banner_url: true,
  description: true,
  is_active: true,
  user: { select: { social_profiles: { select: { is_banned: true } } } },
  _count: { select: { subscriptions: true, videos: { where: { status: 'safe' } } } },
};

export const RECOMMENDER_SELECT = {
  channel_id: true,
  display_name: true,
  handle: true,
  profile_pic_url: true,
};

function parsePositiveInt(raw, fallback = null) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function parseSubscriberPicksQuery(query = {}) {
  const limitRaw = parsePositiveInt(query.limit, DEFAULT_SUBSCRIBER_PICKS_LIMIT);
  const limit = Math.min(Math.max(limitRaw ?? DEFAULT_SUBSCRIBER_PICKS_LIMIT, 1), MAX_SUBSCRIBER_PICKS_LIMIT);
  const excludeId = parsePositiveInt(query.exclude, null);
  return { limit, excludeId };
}

export function parseCreatePickBody(body = {}) {
  const pick_type = String(body.pick_type ?? '').trim().toLowerCase();
  if (!PICK_TYPES.has(pick_type)) {
    return { ok: false, message: 'pick_type must be "video" or "channel".' };
  }

  if (pick_type === 'video') {
    const video_id = parsePositiveInt(body.video_id, null);
    if (video_id == null) {
      return { ok: false, message: 'video_id is required for video picks.' };
    }
    const note = normalizePickNote(body.note);
    if (note.error) return { ok: false, message: note.error };
    return { ok: true, pick_type, video_id, target_channel_id: null, note: note.value };
  }

  const target_channel_id = parsePositiveInt(body.target_channel_id ?? body.channel_id, null);
  if (target_channel_id == null) {
    return { ok: false, message: 'target_channel_id is required for channel picks.' };
  }
  const note = normalizePickNote(body.note);
  if (note.error) return { ok: false, message: note.error };
  return { ok: true, pick_type, video_id: null, target_channel_id, note: note.value };
}

export function normalizePickNote(raw) {
  if (raw == null || raw === '') return { value: null };
  const trimmed = String(raw).trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > MAX_PICK_NOTE_LEN) {
    return { error: `note must be at most ${MAX_PICK_NOTE_LEN} characters.` };
  }
  return { value: trimmed };
}

export function parsePickIdParam(raw) {
  const pick_id = parsePositiveInt(raw, null);
  if (pick_id == null) return { ok: false, message: 'Invalid pick id.' };
  return { ok: true, pick_id };
}

function channelIsVisible(ch) {
  if (!ch?.is_active) return false;
  const banned = ch.user?.social_profiles?.is_banned;
  return banned !== true;
}

function videoIsVisible(v) {
  if (!v || v.status !== 'safe') return false;
  // Match create-route gate: only fully processed published videos surface in the feed.
  if (v.processing_status != null && v.processing_status !== 'done') return false;
  return channelIsVisible(v.channel);
}

/** Ownership lookup result → HTTP decision for DELETE /me/creator-picks/:pick_id. */
export function ownedCreatorPickOr404(existing) {
  if (!existing || existing.pick_id == null) {
    return { ok: false, status: 404, message: 'Pick not found.' };
  }
  return { ok: true, pick_id: existing.pick_id };
}

/** Dedupe subscriber feed rows — one row per recommended video or channel. */
export function dedupeSubscriberPicks(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = row.pick_type === 'video'
      ? `v:${row.video_id}`
      : `c:${row.target_channel_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function filterSubscriberPickRows(rows, { excludeId = null } = {}) {
  const filtered = [];
  for (const row of rows) {
    if (row.pick_type === 'video') {
      if (!videoIsVisible(row.video)) continue;
      if (excludeId != null && row.video.video_id === excludeId) continue;
    } else if (row.pick_type === 'channel') {
      if (!channelIsVisible(row.target_channel)) continue;
    } else {
      continue;
    }
    if (!channelIsVisible(row.channel)) continue;
    filtered.push(row);
  }
  return filtered;
}

export function capSubscriberPicks(rows, limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return [];
  return rows.slice(0, Math.floor(n));
}

export function toCreatorPickCard(row, signThumbnail) {
  const recommender = row.channel
    ? {
      channel_id: row.channel.channel_id,
      display_name: row.channel.display_name,
      handle: row.channel.handle,
      profile_pic_url: row.channel.profile_pic_url ?? null,
    }
    : null;

  if (row.pick_type === 'video' && row.video) {
    const { channel: ch, ...video } = row.video;
    return {
      pick_id: row.pick_id,
      pick_type: 'video',
      note: row.note ?? null,
      created_at: row.created_at,
      recommender,
      video: {
        video_id: video.video_id,
        public_id: video.public_id ?? null,
        slug: video.slug ?? null,
        title: video.title,
        thumbnail_url: signThumbnail(video.thumbnail_url),
        duration_sec: video.duration_sec,
        views_count: video.views_count,
        video_type: video.video_type,
        category: video.category ?? null,
        created_at: video.created_at,
        channel_id: video.channel_id,
        channel: ch
          ? {
            channel_id: ch.channel_id,
            display_name: ch.display_name,
            handle: ch.handle,
            profile_pic_url: ch.profile_pic_url ?? null,
          }
          : null,
      },
      channel: null,
    };
  }

  if (row.pick_type === 'channel' && row.target_channel) {
    const ch = row.target_channel;
    return {
      pick_id: row.pick_id,
      pick_type: 'channel',
      note: row.note ?? null,
      created_at: row.created_at,
      recommender,
      video: null,
      channel: {
        channel_id: ch.channel_id,
        display_name: ch.display_name,
        handle: ch.handle,
        profile_pic_url: ch.profile_pic_url ?? null,
        banner_url: ch.banner_url ?? null,
        description: ch.description ?? null,
        subscriber_count: ch._count?.subscriptions ?? 0,
        video_count: ch._count?.videos ?? 0,
      },
    };
  }

  return null;
}

export function toCreatorManagePick(row, signThumbnail) {
  const base = {
    pick_id: row.pick_id,
    pick_type: row.pick_type,
    note: row.note ?? null,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  if (row.pick_type === 'video' && row.video) {
    const { channel: ch, ...video } = row.video;
    return {
      ...base,
      video_id: video.video_id,
      target_channel_id: null,
      video: {
        video_id: video.video_id,
        title: video.title,
        thumbnail_url: signThumbnail(video.thumbnail_url),
        views_count: video.views_count,
        channel: ch
          ? {
            channel_id: ch.channel_id,
            display_name: ch.display_name,
            handle: ch.handle,
          }
          : null,
      },
      channel: null,
    };
  }

  if (row.pick_type === 'channel' && row.target_channel) {
    const ch = row.target_channel;
    return {
      ...base,
      video_id: null,
      target_channel_id: ch.channel_id,
      video: null,
      channel: {
        channel_id: ch.channel_id,
        display_name: ch.display_name,
        handle: ch.handle,
        profile_pic_url: ch.profile_pic_url ?? null,
        subscriber_count: ch._count?.subscriptions ?? 0,
        video_count: ch._count?.videos ?? 0,
      },
    };
  }

  return base;
}
