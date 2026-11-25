import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { truncateAll, createUser, closeDb, db } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

// #492 — "Friends are watching" rail. Friends = mutual follows; each friend's activity is
// only surfaced if THEY opted into sharing; the viewer can hide the rail entirely.

let pseq = 0;
async function makeMember({ share = false, show = true } = {}) {
  const user = await createUser();
  pseq += 1;
  const profile = await db.social_profile.create({
    data: {
      user_id: user.user_id,
      handle: `h_${pseq}_${user.user_id}`,
      display_name: `Member ${user.user_id}`,
      share_video_activity: share,
      show_friend_video_activity: show,
    },
  });
  return { user, profile };
}

// Make me follow them AND them follow me → mutual.
async function mutualFollow(a, b) {
  await db.follower.createMany({
    data: [
      { follower_id: a.profile.profile_id, following_id: b.profile.profile_id },
      { follower_id: b.profile.profile_id, following_id: a.profile.profile_id },
    ],
  });
}

async function makePlayableVideo({ title = 'Vid', status = 'safe', processing_status = 'done', hls = 'https://cdn/x.m3u8' } = {}) {
  const owner = await createUser();
  const channel = await db.channel.create({
    data: { user_id: owner.user_id, handle: `ch_${owner.user_id}`, display_name: `Chan ${owner.user_id}`, is_active: true },
  });
  return db.video.create({
    data: {
      channel_id: channel.channel_id,
      title,
      raw_video_url: 'https://cdn/raw.mp4',
      hls_url: hls,
      thumbnail_url: 'https://cdn/thumb.jpg',
      duration_sec: 120,
      views_count: 42,
      status,
      processing_status,
    },
  });
}

const feed = (viewer, query = '') => request(app).get(`/video-friend-activity/feed${query}`).set(authHeader(viewer.user));

describe('GET /video-friend-activity/feed', () => {
  it("surfaces a mutual friend's liked video with attribution", async () => {
    const viewer = await makeMember();
    const friend = await makeMember({ share: true });
    await mutualFollow(viewer, friend);
    const video = await makePlayableVideo({ title: 'Friend Liked This' });
    await db.video_likes.create({ data: { user_id: friend.user.user_id, video_id: video.video_id, is_like: true } });

    const res = await feed(viewer).expect(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data).toHaveLength(1);
    const item = res.body.data[0];
    expect(item.video_id).toBe(video.video_id);
    expect(item.title).toBe('Friend Liked This');
    expect(item.friend_count).toBe(1);
    expect(item.friends[0].display_name).toBe(friend.profile.display_name);
    expect(item.friends[0].action).toBe('liked');
  });

  it('keeps a live-in-progress watch private (not watching now)', async () => {
    const viewer = await makeMember();
    const friend = await makeMember({ share: true });
    await mutualFollow(viewer, friend);
    const video = await makePlayableVideo();
    await db.watch_history.create({ data: { user_id: friend.user.user_id, video_id: video.video_id, watched_at: new Date() } });

    const res = await feed(viewer).expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('surfaces a finished watch as watched after the live-private window', async () => {
    const viewer = await makeMember();
    const friend = await makeMember({ share: true });
    await mutualFollow(viewer, friend);
    const video = await makePlayableVideo();
    const fourMinAgo = new Date(Date.now() - 4 * 60 * 1000);
    await db.watch_history.create({ data: { user_id: friend.user.user_id, video_id: video.video_id, watched_at: fourMinAgo } });

    const res = await feed(viewer).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].watching_now).toBe(false);
    expect(res.body.data[0].friends[0].action).toBe('watched');
  });

  it('PRIVACY: excludes a mutual friend who did NOT opt into sharing', async () => {
    const viewer = await makeMember();
    const friend = await makeMember({ share: false });
    await mutualFollow(viewer, friend);
    const video = await makePlayableVideo();
    await db.video_likes.create({ data: { user_id: friend.user.user_id, video_id: video.video_id, is_like: true } });

    const res = await feed(viewer).expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('excludes a one-way follow (not mutual) even if sharing', async () => {
    const viewer = await makeMember();
    const other = await makeMember({ share: true });
    // other follows viewer, but viewer does NOT follow back → not a friend.
    await db.follower.create({ data: { follower_id: other.profile.profile_id, following_id: viewer.profile.profile_id } });
    const video = await makePlayableVideo();
    await db.video_likes.create({ data: { user_id: other.user.user_id, video_id: video.video_id, is_like: true } });

    const res = await feed(viewer).expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('VIEWER OPT-OUT: returns empty when the viewer hid the rail', async () => {
    const viewer = await makeMember({ show: false });
    const friend = await makeMember({ share: true });
    await mutualFollow(viewer, friend);
    const video = await makePlayableVideo();
    await db.video_likes.create({ data: { user_id: friend.user.user_id, video_id: video.video_id, is_like: true } });

    const res = await feed(viewer).expect(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.opted_out).toBe(true);
  });

  it('excludes the currently-playing video via ?exclude=', async () => {
    const viewer = await makeMember();
    const friend = await makeMember({ share: true });
    await mutualFollow(viewer, friend);
    const playing = await makePlayableVideo({ title: 'Now Playing' });
    await db.video_likes.create({ data: { user_id: friend.user.user_id, video_id: playing.video_id, is_like: true } });

    const res = await feed(viewer, `?exclude=${playing.video_id}`).expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('excludes non-playable (still-processing) videos', async () => {
    const viewer = await makeMember();
    const friend = await makeMember({ share: true });
    await mutualFollow(viewer, friend);
    const pending = await makePlayableVideo({ processing_status: 'pending' });
    await db.video_likes.create({ data: { user_id: friend.user.user_id, video_id: pending.video_id, is_like: true } });

    const res = await feed(viewer).expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('collapses multiple friends on one video and counts them', async () => {
    const viewer = await makeMember();
    const f1 = await makeMember({ share: true });
    const f2 = await makeMember({ share: true });
    await mutualFollow(viewer, f1);
    await mutualFollow(viewer, f2);
    const video = await makePlayableVideo();
    await db.video_likes.create({ data: { user_id: f1.user.user_id, video_id: video.video_id, is_like: true } });
    await db.watch_history.create({ data: { user_id: f2.user.user_id, video_id: video.video_id, watched_at: new Date('2020-01-01') } });

    const res = await feed(viewer).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].friend_count).toBe(2);
  });
});

describe('GET/PATCH /video-friend-activity/preferences', () => {
  it('reads defaults then persists updates', async () => {
    const viewer = await makeMember();

    const g = await request(app).get('/video-friend-activity/preferences').set(authHeader(viewer.user)).expect(200);
    expect(g.body.share_video_activity).toBe(false);
    expect(g.body.show_friend_video_activity).toBe(true);

    const p = await request(app).patch('/video-friend-activity/preferences')
      .set(authHeader(viewer.user)).send({ share_video_activity: true, show_friend_video_activity: false }).expect(200);
    expect(p.body.share_video_activity).toBe(true);
    expect(p.body.show_friend_video_activity).toBe(false);

    const persisted = await db.social_profile.findUnique({ where: { profile_id: viewer.profile.profile_id }, select: { share_video_activity: true, show_friend_video_activity: true } });
    expect(persisted.share_video_activity).toBe(true);
    expect(persisted.show_friend_video_activity).toBe(false);
  });

  it('rejects a body with no valid boolean preference', async () => {
    const viewer = await makeMember();
    await request(app).patch('/video-friend-activity/preferences').set(authHeader(viewer.user)).send({ foo: 'bar' }).expect(400);
  });
});

const overlap = (viewer, channelId) =>
  request(app)
    .get(`/video-friend-activity/channel-overlap?channel_id=${channelId}`)
    .set(authHeader(viewer.user));

describe('GET /video-friend-activity/channel-overlap', () => {
  it('lists mutual friends who subscribe to the channel', async () => {
    const viewer = await makeMember();
    const friend = await makeMember({ share: true });
    const stranger = await makeMember({ share: true });
    await mutualFollow(viewer, friend);
    await mutualFollow(viewer, stranger);
    const video = await makePlayableVideo();
    await db.subscription.create({
      data: { user_id: friend.user.user_id, channel_id: video.channel_id },
    });
    // stranger is mutual but not subscribed — must not appear
    const res = await overlap(viewer, video.channel_id).expect(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].user_id).toBe(friend.user.user_id);
    expect(res.body.data[0].display_name).toBe(friend.profile.display_name);
    expect(res.body.data[0]).toHaveProperty('avatar_url');
  });

  it('PRIVACY: excludes a subscribed mutual friend who did NOT opt into sharing', async () => {
    const viewer = await makeMember();
    const friend = await makeMember();
    await mutualFollow(viewer, friend);
    const video = await makePlayableVideo();
    await db.subscription.create({
      data: { user_id: friend.user.user_id, channel_id: video.channel_id },
    });
    const res = await overlap(viewer, video.channel_id).expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('returns empty when no mutual friends subscribe', async () => {
    const viewer = await makeMember();
    const friend = await makeMember();
    await mutualFollow(viewer, friend);
    const video = await makePlayableVideo();
    const res = await overlap(viewer, video.channel_id).expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('VIEWER OPT-OUT: empty + opted_out when the viewer hid friend activity', async () => {
    const viewer = await makeMember({ show: false });
    const friend = await makeMember({ share: true });
    await mutualFollow(viewer, friend);
    const video = await makePlayableVideo();
    await db.subscription.create({
      data: { user_id: friend.user.user_id, channel_id: video.channel_id },
    });
    const res = await overlap(viewer, video.channel_id).expect(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.opted_out).toBe(true);
  });

  it('excludes one-way follows even if they subscribe', async () => {
    const viewer = await makeMember();
    const other = await makeMember({ share: true });
    await db.follower.create({
      data: { follower_id: other.profile.profile_id, following_id: viewer.profile.profile_id },
    });
    const video = await makePlayableVideo();
    await db.subscription.create({
      data: { user_id: other.user.user_id, channel_id: video.channel_id },
    });
    const res = await overlap(viewer, video.channel_id).expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('rejects a missing or invalid channel_id', async () => {
    const viewer = await makeMember();
    await request(app).get('/video-friend-activity/channel-overlap').set(authHeader(viewer.user)).expect(400);
    await overlap(viewer, 'abc').expect(400);
    await overlap(viewer, 0).expect(400);
  });
});
