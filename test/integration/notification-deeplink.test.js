import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, truncateAll, createUser, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

// #472 — a notification must carry the entity it's about (entity_type/entity_id) so the app can
// deep-link to the specific post/video/profile instead of the bare category. These assert the
// backend now emits that identity for video likes/comments (which previously emitted NO
// notification at all) and for follows (which pointed at a profile_id the profile page can't use).

// Socket.IO is attached in index.js, not under supertest — stub it so notify() and
// createNotification()'s io.to(...).emit(...) don't throw.
const fakeIo = { to: () => ({ emit: () => {} }) };

beforeAll(() => { app.set('io', fakeIo); });
beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

// The route fires notify() as best-effort (not awaited) before responding, so poll for the row.
async function waitForNotif(where, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const row = await db.notification.findFirst({ where, orderBy: { notification_id: 'desc' } });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function makeVideo(ownerUserId) {
  const channel = await db.channel.create({
    data: { user_id: ownerUserId, handle: `ch_${ownerUserId}_${Date.now()}`, display_name: 'Owner Channel' },
  });
  return db.video.create({
    data: { channel_id: channel.channel_id, title: 'Test Video', raw_video_url: 'https://example.test/raw.mp4', status: 'safe' },
  });
}

describe('#472 notification deep-link targets', () => {
  it('video like → owner gets a notification carrying the video id', async () => {
    const owner = await createUser();
    const liker = await createUser();
    const video = await makeVideo(owner.user_id);

    await request(app).post(`/video/${video.video_id}/like`).set(authHeader(liker)).expect(200);

    const notif = await waitForNotif({ user_id: owner.user_id, type: 'video.like' });
    expect(notif).not.toBeNull();
    expect(notif.vertical).toBe('video');
    expect(notif.entity_type).toBe('video');
    expect(notif.entity_id).toBe(video.video_id);
  });

  it('does NOT notify on a self-like', async () => {
    const owner = await createUser();
    const video = await makeVideo(owner.user_id);

    await request(app).post(`/video/${video.video_id}/like`).set(authHeader(owner)).expect(200);

    await new Promise((r) => setTimeout(r, 400));
    expect(await db.notification.count({ where: { user_id: owner.user_id } })).toBe(0);
  });

  it('video comment → owner gets a notification carrying the video id', async () => {
    const owner = await createUser();
    const commenter = await createUser();
    const video = await makeVideo(owner.user_id);

    await request(app)
      .post(`/video/${video.video_id}/comments`)
      .set(authHeader(commenter))
      .send({ content: 'great video' })
      .expect(201);

    const notif = await waitForNotif({ user_id: owner.user_id, type: 'video.comment' });
    expect(notif).not.toBeNull();
    expect(notif.entity_type).toBe('video');
    expect(notif.entity_id).toBe(video.video_id);
  });

  it('follow → followed user gets a PROFILE notification pointing at the follower user_id (not profile_id)', async () => {
    // Advance the user_id sequence ahead of the profile_id sequence (throwaway users with no
    // profile) so the follower's user_id != profile_id — otherwise the "not the profile_id"
    // guard below is meaningless (both are 2 in a freshly-truncated DB).
    await createUser();
    await createUser();
    const followed = await createUser();
    const follower = await createUser();
    // Both need social_profiles: the follow route works on profile_id, and the auth middleware
    // re-derives req.user.profile_id from the DB.
    await db.social_profile.create({ data: { user_id: followed.user_id, handle: `p_${followed.user_id}`, display_name: 'Followed' } });
    const followerProfile = await db.social_profile.create({ data: { user_id: follower.user_id, handle: `p_${follower.user_id}`, display_name: 'Follower' } });

    await request(app).post(`/social-follow/toggle-by-user/${followed.user_id}`).set(authHeader(follower)).expect(200);

    const notif = await waitForNotif({ user_id: followed.user_id, type: 'social.follow' });
    expect(notif).not.toBeNull();
    expect(notif.entity_type).toBe('profile');
    // The deep-link must be the follower's USER id (what the profile page keys on), not the
    // follower's profile_id — guard against the regression this fix addresses.
    expect(notif.entity_id).toBe(follower.user_id);
    expect(notif.entity_id).not.toBe(followerProfile.profile_id);
  });
});
