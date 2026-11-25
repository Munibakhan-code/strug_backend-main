import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

// The Subs drawer used to answer with one video per subscribed channel, so a viewer following two
// channels saw two rows no matter how much those channels had posted, and opening a row (the
// playing video is excluded) swapped in that channel's next upload — a trickle of single videos
// instead of a feed. These cover the replacement rule: newest first across the whole subscription
// pool, with the playing video and anything a viewer may not see left out.

let seq = 0;
async function seedChannel() {
  seq += 1;
  const user = await createUser({ name: `Creator ${seq}` });
  const channel = await db.channel.create({
    data: { user_id: user.user_id, handle: `subs_ch_${seq}_${user.user_id}`, display_name: `Ch ${seq}`, is_active: true },
  });
  return channel;
}

async function seedUpload(channel, { title, createdAt, ...over } = {}) {
  return db.video.create({
    data: {
      channel_id: channel.channel_id,
      title: title ?? `Upload ${seq}`,
      raw_video_url: 'https://cdn/raw.mp4',
      hls_url: 'https://cdn/x.m3u8',
      thumbnail_url: 'https://cdn/thumb.jpg',
      duration_sec: 120,
      status: 'safe',
      processing_status: 'done',
      video_type: 'long',
      ...(createdAt ? { created_at: createdAt } : {}),
      ...over,
    },
  });
}

const uploads = (viewer, query = '') =>
  request(app).get(`/channel/subscriptions/uploads${query}`).set(authHeader(viewer));

describe('GET /channel/subscriptions/uploads', () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await truncateAll(); await closeDb(); });

  it('returns every subscribed upload newest first, not one per channel', async () => {
    const viewer = await createUser();
    const busy = await seedChannel();
    const quiet = await seedChannel();
    await seedUpload(busy, { title: 'busy old', createdAt: new Date('2026-08-01T00:00:00Z') });
    await seedUpload(busy, { title: 'busy new', createdAt: new Date('2026-08-20T00:00:00Z') });
    await seedUpload(quiet, { title: 'quiet mid', createdAt: new Date('2026-08-10T00:00:00Z') });
    await db.subscription.createMany({
      data: [
        { user_id: viewer.user_id, channel_id: busy.channel_id },
        { user_id: viewer.user_id, channel_id: quiet.channel_id },
      ],
    });

    const res = await uploads(viewer).expect(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data.map((v) => v.title)).toEqual(['busy new', 'quiet mid', 'busy old']);
  });

  it('leaves out the video being watched and honours the limit', async () => {
    const viewer = await createUser();
    const channel = await seedChannel();
    const newest = await seedUpload(channel, { title: 'newest', createdAt: new Date('2026-08-20T00:00:00Z') });
    await seedUpload(channel, { title: 'middle', createdAt: new Date('2026-08-10T00:00:00Z') });
    await seedUpload(channel, { title: 'oldest', createdAt: new Date('2026-08-01T00:00:00Z') });
    await db.subscription.create({ data: { user_id: viewer.user_id, channel_id: channel.channel_id } });

    const excluded = await uploads(viewer, `?exclude=${newest.video_id}`).expect(200);
    expect(excluded.body.data.map((v) => v.title)).toEqual(['middle', 'oldest']);

    const capped = await uploads(viewer, '?limit=2').expect(200);
    expect(capped.body.data.map((v) => v.title)).toEqual(['newest', 'middle']);
  });

  it('skips shorts, unfinished transcodes and unpublished videos', async () => {
    const viewer = await createUser();
    const channel = await seedChannel();
    await seedUpload(channel, { title: 'playable', createdAt: new Date('2026-08-01T00:00:00Z') });
    await seedUpload(channel, { title: 'a short', video_type: 'shorts', createdAt: new Date('2026-08-20T00:00:00Z') });
    await seedUpload(channel, { title: 'still processing', processing_status: 'pending', createdAt: new Date('2026-08-19T00:00:00Z') });
    await seedUpload(channel, { title: 'not published', status: 'pending', createdAt: new Date('2026-08-18T00:00:00Z') });
    await db.subscription.create({ data: { user_id: viewer.user_id, channel_id: channel.channel_id } });

    const res = await uploads(viewer).expect(200);
    expect(res.body.data.map((v) => v.title)).toEqual(['playable']);
  });

  it('answers empty for a viewer who subscribes to nothing', async () => {
    const viewer = await createUser();
    const channel = await seedChannel();
    await seedUpload(channel, { title: 'nobody asked' });

    const res = await uploads(viewer).expect(200);
    expect(res.body.data).toEqual([]);
  });
});
