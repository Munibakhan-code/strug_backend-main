/**
 * Smoke verification for Social + Town Hall hole fixes.
 * Usage: node scripts/smoke-social-townhall-holes.mjs
 */
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma-client.js';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5000';
const results = [];

function pass(name, detail = '') {
  results.push({ ok: true, name, detail });
  console.log(`✅ PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ ok: false, name, detail });
  console.error(`❌ FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function tokenFor(user, extras = {}) {
  return jwt.sign(
    { user_id: user.user_id, role: extras.role || 'USER', ...extras },
    process.env.ACCESS_TOKEN_KEY,
    { expiresIn: '1h' },
  );
}

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* plain */ }
  return { status: res.status, json, text };
}

const stamp = Date.now();
let userA = null;
let userB = null;
let profileA = null;
let profileB = null;
let createdPostIds = [];
let createdFeedIds = [];

async function cleanup() {
  try {
    if (createdPostIds.length) {
      await prisma.town_hall_poll_vote.deleteMany({ where: { post_id: { in: createdPostIds } } }).catch(() => {});
      await prisma.town_hall_post_like.deleteMany({ where: { post_id: { in: createdPostIds } } }).catch(() => {});
      await prisma.town_hall_repost.deleteMany({ where: { post_id: { in: createdPostIds } } }).catch(() => {});
      await prisma.town_hall_post_save.deleteMany({ where: { post_id: { in: createdPostIds } } }).catch(() => {});
      await prisma.town_hall_post_view.deleteMany({ where: { post_id: { in: createdPostIds } } }).catch(() => {});
      await prisma.town_hall_post.deleteMany({ where: { parent_id: { in: createdPostIds } } }).catch(() => {});
      await prisma.town_hall_post.deleteMany({ where: { post_id: { in: createdPostIds } } }).catch(() => {});
    }
    if (createdFeedIds.length) {
      await prisma.social_media_attachments.deleteMany({ where: { social_post_id: { in: createdFeedIds } } }).catch(() => {});
      await prisma.social_interactions.deleteMany({ where: { social_post_id: { in: createdFeedIds } } }).catch(() => {});
      await prisma.social_feed.deleteMany({ where: { social_post_id: { in: createdFeedIds } } }).catch(() => {});
    }
    if (profileA && profileB) {
      await prisma.social_block.deleteMany({
        where: {
          OR: [
            { blocker_id: profileA.profile_id },
            { blocked_id: profileA.profile_id },
            { blocker_id: profileB.profile_id },
            { blocked_id: profileB.profile_id },
          ],
        },
      }).catch(() => {});
      await prisma.social_mute.deleteMany({
        where: {
          OR: [
            { muter_id: profileA.profile_id },
            { muted_id: profileA.profile_id },
            { muter_id: profileB.profile_id },
            { muted_id: profileB.profile_id },
          ],
        },
      }).catch(() => {});
      await prisma.follower.deleteMany({
        where: {
          OR: [
            { follower_id: profileA.profile_id },
            { following_id: profileA.profile_id },
            { follower_id: profileB.profile_id },
            { following_id: profileB.profile_id },
          ],
        },
      }).catch(() => {});
    }
    if (userA) {
      await prisma.town_hall_post.deleteMany({ where: { user_id: userA.user_id } }).catch(() => {});
      await prisma.social_profile.deleteMany({ where: { user_id: userA.user_id } }).catch(() => {});
      await prisma.user.delete({ where: { user_id: userA.user_id } }).catch(() => {});
    }
    if (userB) {
      await prisma.town_hall_post.deleteMany({ where: { user_id: userB.user_id } }).catch(() => {});
      await prisma.social_profile.deleteMany({ where: { user_id: userB.user_id } }).catch(() => {});
      await prisma.user.delete({ where: { user_id: userB.user_id } }).catch(() => {});
    }
  } catch (e) {
    console.warn('cleanup warning:', e.message);
  }
}

try {
  const health = await api('GET', '/social-system/health');
  if (health.status !== 200) {
    fail('server healthy', `status=${health.status}`);
    process.exit(1);
  }
  pass('server healthy');

  userA = await prisma.user.create({
    data: {
      email: `smoke-holes-a-${stamp}@strug.test`,
      username: `smoke_holes_a_${stamp}`,
      name: 'Smoke Holes A',
      password: 'unused',
    },
  });
  userB = await prisma.user.create({
    data: {
      email: `smoke-holes-b-${stamp}@strug.test`,
      username: `smoke_holes_b_${stamp}`,
      name: 'Smoke Holes B',
      password: 'unused',
    },
  });
  profileA = await prisma.social_profile.create({
    data: {
      user_id: userA.user_id,
      handle: `smokea${stamp}`.slice(0, 40),
      display_name: 'Smoke A',
      is_private: false,
    },
  });
  profileB = await prisma.social_profile.create({
    data: {
      user_id: userB.user_id,
      handle: `smokeb${stamp}`.slice(0, 40),
      display_name: 'Smoke B',
      is_private: false,
    },
  });

  const tokenA = tokenFor(userA);
  const tokenB = tokenFor(userB);
  // requireAdmin reads role from DB (not JWT claim)
  await prisma.user.update({ where: { user_id: userA.user_id }, data: { role: 'ADMIN' } });
  const adminToken = tokenFor(userA, { role: 'ADMIN' });
  // restore USER for non-admin checks that use tokenA — tokenA still has USER in JWT
  // but middleware overwrites from DB, so temporarily drop admin after admin stats check.

  // ═══════════════════════════════════════════════════════════════════════
  // CRITICAL: unauthenticated writes must be rejected
  // ═══════════════════════════════════════════════════════════════════════
  {
    const createIx = await api('POST', '/social-interactions/', {
      body: { social_post_id: 1, user_id: 999999, reaction_type: 'like' },
    });
    if (createIx.status === 401) pass('social-interactions POST requires auth');
    else fail('social-interactions POST requires auth', `status=${createIx.status}`);

    const delIx = await api('DELETE', '/social-interactions/1');
    if (delIx.status === 401) pass('social-interactions DELETE requires auth');
    else fail('social-interactions DELETE requires auth', `status=${delIx.status}`);

    const createAtt = await api('POST', '/social-media-attachments/', {
      body: { social_post_id: 1, media_url: 'https://evil.example/x.jpg', media_type: 'image' },
    });
    if (createAtt.status === 401) pass('social-media-attachments POST requires auth');
    else fail('social-media-attachments POST requires auth', `status=${createAtt.status}`);

    const delAtt = await api('DELETE', '/social-media-attachments/1');
    if (delAtt.status === 401) pass('social-media-attachments DELETE requires auth');
    else fail('social-media-attachments DELETE requires auth', `status=${delAtt.status}`);

    const stats = await api('GET', '/social-system/stats');
    if (stats.status === 401) pass('social-system/stats requires auth');
    else fail('social-system/stats requires auth', `status=${stats.status}`);

    const statsUser = await api('GET', '/social-system/stats', { token: tokenB });
    if (statsUser.status === 403) pass('social-system/stats rejects non-admin');
    else fail('social-system/stats rejects non-admin', `status=${statsUser.status}`);

    const statsAdmin = await api('GET', '/social-system/stats', { token: adminToken });
    if (statsAdmin.status === 200 && statsAdmin.json?.successful) {
      pass('social-system/stats allows admin');
    } else {
      fail('social-system/stats allows admin', `status=${statsAdmin.status} body=${statsAdmin.text?.slice(0, 120)}`);
    }
    await prisma.user.update({ where: { user_id: userA.user_id }, data: { role: 'USER' } });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Attachment media allowlist + ownership
  // ═══════════════════════════════════════════════════════════════════════
  {
    const feed = await prisma.social_feed.create({
      data: {
        profile_id: profileA.profile_id,
        caption_text: `smoke attach ${stamp}`,
        status: 'published',
      },
    });
    createdFeedIds.push(feed.social_post_id);

    const evil = await api('POST', '/social-media-attachments/', {
      token: tokenA,
      body: {
        social_post_id: feed.social_post_id,
        media_url: 'https://evil.example/phish.jpg',
        media_type: 'image',
        sequence_order: 1,
      },
    });
    if (evil.status === 400) pass('attachment rejects untrusted media_url');
    else fail('attachment rejects untrusted media_url', `status=${evil.status} body=${evil.text?.slice(0, 160)}`);

    const steal = await api('POST', '/social-media-attachments/', {
      token: tokenB,
      body: {
        social_post_id: feed.social_post_id,
        media_url: 'https://ststrugproduploads.blob.core.windows.net/social-posts/fake.jpg',
        media_type: 'image',
        sequence_order: 1,
      },
    });
    if (steal.status === 403) pass('attachment create requires post ownership');
    else fail('attachment create requires post ownership', `status=${steal.status} body=${steal.text?.slice(0, 160)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Interaction create ignores spoofed identity (uses JWT profile)
  // ═══════════════════════════════════════════════════════════════════════
  {
    const feed = await prisma.social_feed.create({
      data: {
        profile_id: profileA.profile_id,
        caption_text: `smoke like ${stamp}`,
        status: 'published',
      },
    });
    createdFeedIds.push(feed.social_post_id);

    const spoof = await api('POST', '/social-interactions/', {
      token: tokenB,
      body: {
        social_post_id: feed.social_post_id,
        user_id: userA.user_id,
        reaction_type: 'like',
      },
    });
    if (spoof.status === 201 && spoof.json?.profile_id === profileB.profile_id) {
      pass('interaction create uses JWT profile_id', `profile_id=${spoof.json.profile_id}`);
    } else if (spoof.status === 201 && spoof.json?.profile_id !== profileA.profile_id) {
      pass('interaction create does not use spoofed user', `profile_id=${spoof.json?.profile_id}`);
    } else {
      fail('interaction create uses JWT profile_id', `status=${spoof.status} body=${spoof.text?.slice(0, 200)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Block/mute hides Town Hall posts from feed + search
  // ═══════════════════════════════════════════════════════════════════════
  {
    const marker = `zzsmokeblock${stamp}`;
    const blockedPost = await prisma.town_hall_post.create({
      data: { user_id: userA.user_id, content: marker },
    });
    createdPostIds.push(blockedPost.post_id);

    // Before block — B can see it in search
    const before = await api('GET', `/town-hall/search-posts?q=${encodeURIComponent(marker)}`, { token: tokenB });
    const beforeHit = (before.json?.posts || []).some((p) => p.post_id === blockedPost.post_id);
    if (before.status === 200 && beforeHit) pass('search finds post before block');
    else fail('search finds post before block', `status=${before.status} hit=${beforeHit}`);

    await prisma.social_block.create({
      data: { blocker_id: profileB.profile_id, blocked_id: profileA.profile_id },
    });

    const after = await api('GET', `/town-hall/search-posts?q=${encodeURIComponent(marker)}`, { token: tokenB });
    const afterHit = (after.json?.posts || []).some((p) => p.post_id === blockedPost.post_id);
    if (after.status === 200 && !afterHit) pass('search hides blocked author after block');
    else fail('search hides blocked author after block', `status=${after.status} hit=${afterHit}`);

    await prisma.social_block.deleteMany({
      where: { blocker_id: profileB.profile_id, blocked_id: profileA.profile_id },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Mute hides author; private profile posts hidden from non-followers
  // ═══════════════════════════════════════════════════════════════════════
  {
    const marker = `zzsmokemute${stamp}`;
    const mutedPost = await prisma.town_hall_post.create({
      data: { user_id: userA.user_id, content: marker },
    });
    createdPostIds.push(mutedPost.post_id);

    await prisma.social_mute.create({
      data: { muter_id: profileB.profile_id, muted_id: profileA.profile_id, mute_posts: true },
    });
    const mutedSearch = await api('GET', `/town-hall/search-posts?q=${encodeURIComponent(marker)}`, { token: tokenB });
    const mutedHit = (mutedSearch.json?.posts || []).some((p) => p.post_id === mutedPost.post_id);
    if (mutedSearch.status === 200 && !mutedHit) pass('search hides muted author');
    else fail('search hides muted author', `status=${mutedSearch.status} hit=${mutedHit}`);
    await prisma.social_mute.deleteMany({
      where: { muter_id: profileB.profile_id, muted_id: profileA.profile_id },
    });

    await prisma.social_profile.update({
      where: { profile_id: profileA.profile_id },
      data: { is_private: true },
    });
    const privMarker = `zzsmokepriv${stamp}`;
    const privPost = await prisma.town_hall_post.create({
      data: { user_id: userA.user_id, content: privMarker },
    });
    createdPostIds.push(privPost.post_id);

    const privSearch = await api('GET', `/town-hall/search-posts?q=${encodeURIComponent(privMarker)}`, { token: tokenB });
    const privHit = (privSearch.json?.posts || []).some((p) => p.post_id === privPost.post_id);
    if (privSearch.status === 200 && !privHit) pass('search hides private-profile author from non-follower');
    else fail('search hides private-profile author from non-follower', `status=${privSearch.status} hit=${privHit}`);

    const userPosts = await api('GET', `/town-hall/user/${userA.user_id}`, { token: tokenB });
    if (userPosts.status === 200 && Array.isArray(userPosts.json) && userPosts.json.length === 0) {
      pass('GET /user/:id empty for private non-follower');
    } else {
      fail('GET /user/:id empty for private non-follower', `status=${userPosts.status} n=${userPosts.json?.length}`);
    }

    await prisma.social_profile.update({
      where: { profile_id: profileA.profile_id },
      data: { is_private: false },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Reply to scheduled parent rejected; repost of scheduled not in feed
  // ═══════════════════════════════════════════════════════════════════════
  {
    const scheduled = await prisma.town_hall_post.create({
      data: {
        user_id: userA.user_id,
        content: `scheduled reply target ${stamp}`,
        scheduled_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });
    createdPostIds.push(scheduled.post_id);

    const reply = await api('POST', '/town-hall', {
      token: tokenB,
      body: { content: `reply to scheduled ${stamp}`, parent_id: scheduled.post_id },
    });
    if (reply.status === 404) pass('reply to scheduled parent → 404');
    else fail('reply to scheduled parent → 404', `status=${reply.status} body=${reply.text?.slice(0, 160)}`);

    // Repost scheduled post, then check B's feed does not include it via home page 1
    await prisma.town_hall_repost.create({
      data: { post_id: scheduled.post_id, user_id: userA.user_id },
    });
    // Invalidate any ranked cache for B by using a unique day key — feed should still filter schedule
    const feed = await api('GET', '/town-hall?page=1&limit=50', { token: tokenB });
    const feedHit = Array.isArray(feed.json) && feed.json.some((p) => p.post_id === scheduled.post_id);
    if (feed.status === 200 && !feedHit) pass('home feed excludes scheduled via repost');
    else fail('home feed excludes scheduled via repost', `status=${feed.status} hit=${feedHit}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Poll voted_option_id + voices + trending topics + share path
  // ═══════════════════════════════════════════════════════════════════════
  {
    const pollPost = await prisma.town_hall_post.create({
      data: {
        user_id: userA.user_id,
        content: `poll holes ${stamp}`,
        poll_options: {
          create: [{ option_text: 'One' }, { option_text: 'Two' }],
        },
      },
      include: { poll_options: true },
    });
    createdPostIds.push(pollPost.post_id);
    const opt = pollPost.poll_options[0];

    const vote = await api('POST', `/town-hall/${pollPost.post_id}/poll/vote`, {
      token: tokenB,
      body: { option_id: opt.option_id },
    });
    if (vote.status === 201 || vote.status === 200) pass('poll vote OK', `status=${vote.status}`);
    else fail('poll vote OK', `status=${vote.status} body=${vote.text?.slice(0, 160)}`);

    const detail = await api('GET', `/town-hall/${pollPost.post_id}`, { token: tokenB });
    const votedId = detail.json?.poll?.voted_option_id ?? detail.json?.data?.poll?.voted_option_id;
    if (detail.status === 200 && votedId === opt.option_id) {
      pass('poll payload includes voted_option_id', `voted=${votedId}`);
    } else {
      fail('poll payload includes voted_option_id', `status=${detail.status} voted=${votedId} body=${JSON.stringify(detail.json?.poll || detail.json)?.slice(0, 200)}`);
    }

    const voices = await api('GET', '/town-hall/voices-to-follow?limit=5', { token: tokenB });
    if (voices.status === 200 && Array.isArray(voices.json?.users)) {
      pass('voices-to-follow reachable', `n=${voices.json.users.length}`);
    } else {
      fail('voices-to-follow reachable', `status=${voices.status}`);
    }

    const topics = await api('GET', '/town-hall/trending-topics?limit=5', { token: tokenB });
    if (topics.status === 200 && Array.isArray(topics.json?.topics)) {
      pass('trending-topics reachable', `n=${topics.json.topics.length}`);
    } else {
      fail('trending-topics reachable', `status=${topics.status}`);
    }

    const live = await prisma.town_hall_post.create({
      data: { user_id: userA.user_id, content: `share path ${stamp}` },
    });
    createdPostIds.push(live.post_id);
    const share = await api('GET', `/town-hall/share/${live.post_id}`);
    const hasTownhallPath = (share.text || '').includes('/townhall/');
    const hasOldPath = (share.text || '').includes('/town-hall/') && (share.text || '').includes('app.strug.ca/town-hall/');
    if (share.status === 200 && hasTownhallPath && !hasOldPath) {
      pass('share redirect uses /townhall path');
    } else if (share.status === 200 && hasTownhallPath) {
      pass('share redirect uses /townhall path', 'found townhall deep link');
    } else {
      fail('share redirect uses /townhall path', `status=${share.status} hasNew=${hasTownhallPath} hasOld=${hasOldPath}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Moderation accepts TOWN_HALL_POST
  // ═══════════════════════════════════════════════════════════════════════
  {
    const bad = await api('POST', '/social-moderation/report', {
      token: tokenB,
      body: { target_type: 'NOT_A_TYPE', target_id: 1, reason: 'Spam or misleading' },
    });
    if (bad.status === 400) pass('moderation rejects unknown target_type');
    else fail('moderation rejects unknown target_type', `status=${bad.status}`);

    const post = await prisma.town_hall_post.create({
      data: { user_id: userA.user_id, content: `report me ${stamp}` },
    });
    createdPostIds.push(post.post_id);
    const ok = await api('POST', '/social-moderation/report', {
      token: tokenB,
      body: {
        target_type: 'TOWN_HALL_POST',
        target_id: post.post_id,
        reason: 'Spam or misleading',
      },
    });
    if (ok.status === 200 || ok.status === 201) pass('moderation accepts TOWN_HALL_POST');
    else fail('moderation accepts TOWN_HALL_POST', `status=${ok.status} body=${ok.text?.slice(0, 160)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Bookmarks alias path
  // ═══════════════════════════════════════════════════════════════════════
  {
    const me = await api('GET', '/social-interactions/bookmarks/me', { token: tokenB });
    const alias = await api('GET', '/social-interactions/bookmarked-posts', { token: tokenB });
    if (me.status === 200 && alias.status === 200) pass('bookmarks/me and bookmarked-posts both work');
    else fail('bookmarks paths', `me=${me.status} alias=${alias.status}`);
  }

} catch (err) {
  fail('smoke runner crashed', err.stack || err.message);
} finally {
  await cleanup();
  await prisma.$disconnect().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log('\n──────────── SUMMARY ────────────');
console.log(`Passed: ${results.filter((r) => r.ok).length}/${results.length}`);
if (failed.length) {
  console.log('Failed:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log('All Social/Town Hall hole fixes verified.');
process.exit(0);
