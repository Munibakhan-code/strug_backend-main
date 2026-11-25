import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';

// Verifies GET /board-admin/analytics/channels-audit — the per-channel ownership sweep that
// answers "did creator dashboards get merged?". Seeds three creators (one real w/ 2 videos,
// one empty, one placeholder-named "user99") + a board admin, and asserts the summary,
// placeholder detection, and the (structurally-impossible) multiChannelUsers stays empty.

function boardHeader(member) {
  const token = jwt.sign(
    { permission: 'board', member_id: member.member_id, name: member.name },
    process.env.ACCESS_TOKEN_KEY,
    { expiresIn: '1h' },
  );
  return { Authorization: `Bearer ${token}` };
}

describe('board-admin channels-audit', () => {
  let admin;

  beforeAll(async () => {
    await truncateAll();

    admin = await db.board_member.create({
      data: {
        name: 'Admin', email: 'admin@board.test', password: 'x',
        status: 'approved', can_manage_members: true, can_review: true,
        // RBAC v2 (2026-07-13) gates dashboards on the resolved ACCESS map, not the legacy
        // can_* flags — those now only grant coarse capabilities. Real members get an access
        // map from their board_role (the seed backfills one from their old flags), but a
        // member created straight in a test has no role, so /board-admin/analytics/* 403s.
        // Grant analytics read explicitly, which is what this test is actually about.
        access_overrides: { analytics: 'read' },
      },
    });

    // Real creator: channel with 2 videos.
    const u1 = await createUser({ name: 'Real Creator' });
    const c1 = await db.channel.create({ data: { user_id: u1.user_id, handle: 'realone', display_name: 'Real One' } });
    await db.video.create({ data: { channel_id: c1.channel_id, title: 'v1', raw_video_url: 'x' } });
    await db.video.create({ data: { channel_id: c1.channel_id, title: 'v2', raw_video_url: 'x' } });

    // Empty creator: channel, no videos.
    const u2 = await createUser({ name: 'Empty Creator' });
    await db.channel.create({ data: { user_id: u2.user_id, handle: 'emptyone', display_name: 'Empty One' } });

    // Placeholder-owned creator: owner name looks like the GET /me auto-provision hotfix.
    const u3 = await createUser({ name: 'user99' });
    const c3 = await db.channel.create({ data: { user_id: u3.user_id, handle: 'placeholder', display_name: 'Placeholder' } });
    await db.video.create({ data: { channel_id: c3.channel_id, title: 'pv1', raw_video_url: 'x' } });
  });

  afterAll(async () => { await truncateAll(); await closeDb(); });

  it('rejects a non-board token', async () => {
    const res = await request(app).get('/board-admin/analytics/channels-audit');
    expect(res.status).toBe(401);
  });

  it('returns per-channel ownership + honest anomaly flags', async () => {
    const res = await request(app).get('/board-admin/analytics/channels-audit').set(boardHeader(admin));
    expect(res.status).toBe(200);

    const { summary, anomalies, guarantees, channels } = res.body;
    expect(summary.totalChannels).toBe(3);
    expect(summary.channelsWithVideos).toBe(2);
    expect(summary.emptyChannels).toBe(1);
    expect(summary.placeholderOwnedChannels).toBe(1);
    expect(summary.totalVideosOwned).toBe(3);

    // cross-ownership is structurally impossible → no user owns >1 channel
    expect(anomalies.multiChannelUsers).toEqual([]);
    expect(guarantees.crossOwnershipPossible).toBe(false);

    // placeholder detection
    expect(anomalies.placeholderChannels).toHaveLength(1);
    expect(anomalies.placeholderChannels[0].handle).toBe('placeholder');

    // per-channel rows carry owner + counts
    const real = channels.find((c) => c.handle === 'realone');
    expect(real.video_count).toBe(2);
    expect(real.is_empty).toBe(false);
    expect(real.is_placeholder_owner).toBe(false);
    const empty = channels.find((c) => c.handle === 'emptyone');
    expect(empty.video_count).toBe(0);
    expect(empty.is_empty).toBe(true);
  });
});
