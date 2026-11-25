import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';

// Regression for the "merged creator dashboards" report: GET /video/feed?channel_id=<id> was
// dropping channel_id (it wasn't in the Zod schema), so the Creator Studio Content tab and
// public channel pages returned the GLOBAL newest-first feed — every creator saw the same
// videos and appeared to have "lost access" to their own uploads. Also covers include_shorts
// (channel view shows long + shorts) and category filtering (silently dropped the same way).

async function seedCreator({ handle }) {
  const user = await createUser({ name: `Owner ${handle}` });
  await db.social_profile.create({
    data: { user_id: user.user_id, handle: `${handle}_sp`, display_name: `SP ${handle}`, is_banned: false },
  });
  const channel = await db.channel.create({
    data: { user_id: user.user_id, handle, display_name: `Ch ${handle}`, is_active: true },
  });
  return { user, channel };
}

async function seedVideo(channel, over = {}) {
  return db.video.create({
    data: {
      channel_id: channel.channel_id,
      title: 't',
      raw_video_url: 'x',
      status: 'safe',
      processing_status: 'done',
      video_type: 'long',
      category: 'General',
      ...over,
    },
  });
}

describe('GET /video/feed — channel scoping', () => {
  let A, B;
  let aLongGaming, aLongMusic, aShort, aPending, bLong;

  beforeAll(async () => {
    await truncateAll();
    A = await seedCreator({ handle: 'channel_a' });
    B = await seedCreator({ handle: 'channel_b' });

    aLongGaming = await seedVideo(A.channel, { title: 'A gaming', category: 'Gaming' });
    aLongMusic = await seedVideo(A.channel, { title: 'A music', category: 'Music' });
    aShort = await seedVideo(A.channel, { title: 'A short', video_type: 'shorts' });
    aPending = await seedVideo(A.channel, { title: 'A pending', processing_status: 'pending', status: 'pending' });
    bLong = await seedVideo(B.channel, { title: 'B long' });
  });

  afterAll(async () => { await truncateAll(); await closeDb(); });

  const feed = async (qs) => {
    const res = await request(app).get(`/video/feed${qs}`);
    expect(res.status).toBe(200);
    return res.body.data.items;
  };
  const ids = (items) => items.map((v) => v.video_id);
  const channelIds = (items) => [...new Set(items.map((v) => v.channel?.channel_id))];

  it('channel_id scopes to that channel only (not the global/merged feed)', async () => {
    const a = await feed(`?channel_id=${A.channel.channel_id}`);
    expect(channelIds(a)).toEqual([A.channel.channel_id]);
    expect(ids(a)).toEqual(expect.arrayContaining([aLongGaming.video_id, aLongMusic.video_id]));
    // long-only by default → no short; safe/done only → no pending; other channel excluded
    expect(ids(a)).not.toContain(aShort.video_id);
    expect(ids(a)).not.toContain(aPending.video_id);
    expect(ids(a)).not.toContain(bLong.video_id);
  });

  it('a different channel_id returns a disjoint set — dashboards are NOT merged', async () => {
    const b = await feed(`?channel_id=${B.channel.channel_id}`);
    expect(channelIds(b)).toEqual([B.channel.channel_id]);
    expect(ids(b)).toEqual([bLong.video_id]);
    expect(ids(b)).not.toContain(aLongGaming.video_id);
  });

  it('no channel_id still returns the global feed (both channels)', async () => {
    const all = await feed('');
    expect(ids(all)).toEqual(expect.arrayContaining([aLongGaming.video_id, bLong.video_id]));
  });

  it('include_shorts=true adds the channel\'s shorts alongside long videos, still scoped', async () => {
    const a = await feed(`?channel_id=${A.channel.channel_id}&include_shorts=true`);
    expect(ids(a)).toEqual(expect.arrayContaining([aLongGaming.video_id, aShort.video_id]));
    expect(channelIds(a)).toEqual([A.channel.channel_id]);
  });

  it('category filters within the feed', async () => {
    const gaming = await feed(`?channel_id=${A.channel.channel_id}&category=Gaming`);
    expect(ids(gaming)).toEqual([aLongGaming.video_id]);
  });
});
