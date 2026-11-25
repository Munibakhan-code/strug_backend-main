import { describe, it, expect } from 'vitest';
import {
  visibleVideoWhere,
  visibleChannelWhere,
  visibilityBlockers,
  creatorVisibility,
} from '../../utils/video-visibility.js';

// A creator who has a channel but never made a social profile.
const noProfile = { is_active: true, user: { social_profiles: null } };
const okProfile = { is_active: true, user: { social_profiles: { is_banned: false } } };
const bannedProfile = { is_active: true, user: { social_profiles: { is_banned: true } } };

const live = (over = {}) => ({
  status: 'safe',
  processing_status: 'done',
  hls_url: 'https://blob/master.m3u8',
  channel: okProfile,
  ...over,
});

describe('visibleChannelWhere', () => {
  it('treats a MISSING social profile as not-banned rather than hiding the video', () => {
    // The bug: `social_profiles: { is_banned: false }` on an OPTIONAL to-one relation compiles to
    // `is_banned = false AND profile_id IS NOT NULL`, so a null profile excluded every video from
    // /feed and /search while the channel page still listed them. The guard must be an OR over null.
    const where = visibleChannelWhere();
    expect(where.user.OR).toEqual([
      { social_profiles: { is: null } },
      { social_profiles: { is_banned: false } },
    ]);
    // and it must NOT contain the old bare form, which is what re-introduces the bug
    expect(where.user.social_profiles).toBeUndefined();
  });

  it('still requires the channel to be active', () => {
    expect(visibleChannelWhere().is_active).toBe(true);
  });
});

describe('visibleVideoWhere', () => {
  it('always demands safe + done', () => {
    const w = visibleVideoWhere();
    expect(w.status).toBe('safe');
    expect(w.processing_status).toBe('done');
  });

  it('merges extra conditions without dropping the channel guard', () => {
    const w = visibleVideoWhere({ video_type: 'long', category: 'music' });
    expect(w.video_type).toBe('long');
    expect(w.category).toBe('music');
    expect(w.channel.is_active).toBe(true);
    expect(w.channel.user.OR).toHaveLength(2);
  });

  it('lets a caller add channel conditions without clobbering the guard', () => {
    const w = visibleVideoWhere({ channel: { channel_id: 7 } });
    expect(w.channel.channel_id).toBe(7);
    expect(w.channel.is_active).toBe(true);
    expect(w.channel.user.OR).toHaveLength(2);
  });
});

describe('visibilityBlockers', () => {
  it('reports nothing for a genuinely live video', () => {
    expect(visibilityBlockers(live())).toEqual([]);
  });

  it('does NOT flag a creator who simply has no social profile', () => {
    expect(visibilityBlockers(live({ channel: noProfile }))).toEqual([]);
  });

  it('flags a banned creator', () => {
    expect(visibilityBlockers(live({ channel: bannedProfile }))).toContain('creator_banned');
  });

  it('flags an auto-banned video', () => {
    // markBanned sets status='banned' AND processing_status='done', so it looks finished.
    const v = live({ status: 'banned' });
    expect(visibilityBlockers(v)).toContain('banned_by_moderation');
  });

  it('flags private and pending_private as private, not published', () => {
    expect(visibilityBlockers(live({ status: 'private' }))).toContain('private');
    // pending_private intentionally treated as not_published in this capacity-only slice
    // until worker/visibility pairing is shipped.
    expect(visibilityBlockers(live({ status: 'pending_private' }))).toContain('not_published');
    expect(visibilityBlockers(live({ status: 'private' }))).not.toContain('not_published');
  });

  it('flags a failed transcode that never reached safe', () => {
    const v = live({ status: 'pending', processing_status: 'error', hls_url: null });
    const b = visibilityBlockers(v);
    expect(b).toContain('not_published');
    expect(b).toContain('processing_failed');
  });

  it('flags a still-processing video', () => {
    const v = live({ status: 'pending', processing_status: 'processing', hls_url: null });
    expect(visibilityBlockers(v)).toContain('still_processing');
  });

  it('flags done-but-no-hls (nothing to play)', () => {
    expect(visibilityBlockers(live({ hls_url: null }))).toContain('missing_hls');
  });

  it('flags an inactive channel', () => {
    const v = live({ channel: { ...okProfile, is_active: false } });
    expect(visibilityBlockers(v)).toContain('channel_inactive');
  });
});

describe('creatorVisibility', () => {
  it('says published only when viewers can actually see it', () => {
    expect(creatorVisibility(live())).toEqual({
      state: 'published',
      visible_to_viewers: true,
      blockers: [],
    });
  });

  it('never reports a removed video as published', () => {
    const r = creatorVisibility(live({ status: 'banned' }));
    expect(r.state).toBe('removed');
    expect(r.visible_to_viewers).toBe(false);
  });

  it('reports a finished private video as private, not published', () => {
    const r = creatorVisibility(live({ status: 'private' }));
    expect(r.state).toBe('private');
    expect(r.visible_to_viewers).toBe(false);
  });

  it('never reports a failed video as published', () => {
    const r = creatorVisibility(live({ status: 'pending', processing_status: 'error', hls_url: null }));
    expect(r.state).toBe('failed');
    expect(r.visible_to_viewers).toBe(false);
  });

  it('reports still-processing distinctly from failed', () => {
    const r = creatorVisibility(live({ status: 'pending', processing_status: 'processing', hls_url: null }));
    expect(r.state).toBe('processing');
    expect(r.visible_to_viewers).toBe(false);
  });

  it('a creator with no social profile is published, not hidden', () => {
    const r = creatorVisibility(live({ channel: noProfile }));
    expect(r.state).toBe('published');
    expect(r.visible_to_viewers).toBe(true);
  });
});
