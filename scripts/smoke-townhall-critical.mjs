/**
 * One-off smoke test for Town Hall critical fixes against the running local API.
 * Creates a throwaway user (+ posts), asserts behaviours, then cleans up.
 *
 * Usage: node scripts/smoke-townhall-critical.mjs
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

function tokenFor(user) {
  return jwt.sign(
    { user_id: user.user_id, role: 'USER' },
    process.env.ACCESS_TOKEN_KEY,
    { expiresIn: '1h' },
  );
}

async function api(method, path, { token, body, raw = false } = {}) {
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
  try { json = text ? JSON.parse(text) : null; } catch { /* html / plain */ }
  if (raw) return { status: res.status, text, json };
  return { status: res.status, json, text };
}

const stamp = Date.now();
let userA = null;
let userB = null;
let createdPostIds = [];

async function cleanup() {
  const ids = [...new Set(createdPostIds.filter(Boolean))];
  if (ids.length) {
    // Delete replies first, then roots (FK-safe enough for our smoke data).
    await prisma.town_hall_post.deleteMany({ where: { parent_id: { in: ids } } }).catch(() => {});
    await prisma.town_hall_post.deleteMany({ where: { post_id: { in: ids } } }).catch(() => {});
  }
  if (userA) {
    await prisma.user_tag.deleteMany({ where: { user_id: userA.user_id } }).catch(() => {});
    await prisma.town_hall_poll_vote.deleteMany({ where: { user_id: userA.user_id } }).catch(() => {});
    await prisma.town_hall_post_like.deleteMany({ where: { user_id: userA.user_id } }).catch(() => {});
    await prisma.town_hall_repost.deleteMany({ where: { user_id: userA.user_id } }).catch(() => {});
    await prisma.town_hall_post_save.deleteMany({ where: { user_id: userA.user_id } }).catch(() => {});
    await prisma.town_hall_post_view.deleteMany({ where: { user_id: userA.user_id } }).catch(() => {});
    await prisma.town_hall_post.deleteMany({ where: { user_id: userA.user_id } }).catch(() => {});
    await prisma.user.delete({ where: { user_id: userA.user_id } }).catch(() => {});
  }
  if (userB) {
    await prisma.town_hall_poll_vote.deleteMany({ where: { user_id: userB.user_id } }).catch(() => {});
    await prisma.town_hall_post_like.deleteMany({ where: { user_id: userB.user_id } }).catch(() => {});
    await prisma.town_hall_post.deleteMany({ where: { user_id: userB.user_id } }).catch(() => {});
    await prisma.user.delete({ where: { user_id: userB.user_id } }).catch(() => {});
  }
}

try {
  // Health
  const health = await fetch(`${BASE}/`).catch((e) => ({ ok: false, error: e }));
  if (!health.ok && health.status == null) {
    fail('server reachable', String(health.error?.message || health.error));
    process.exit(1);
  }

  userA = await prisma.user.create({
    data: {
      email: `smoke-th-a-${stamp}@strug.test`,
      username: `smoke_th_a_${stamp}`,
      name: 'Smoke TH A',
      password: 'unused',
    },
  });
  userB = await prisma.user.create({
    data: {
      email: `smoke-th-b-${stamp}@strug.test`,
      username: `smoke_th_b_${stamp}`,
      name: 'Smoke TH B',
      password: 'unused',
    },
  });
  const tokenA = tokenFor(userA);
  const tokenB = tokenFor(userB);

  // ── 1. Create works for unrestricted user ─────────────────────────────
  {
    const res = await api('POST', '/town-hall', {
      token: tokenA,
      body: { content: `smoke parent ${stamp}` },
    });
    if (res.status === 200 || res.status === 201) {
      const id = res.json?.post_id ?? res.json?.data?.post_id;
      if (id) createdPostIds.push(id);
      pass('create post (unrestricted)', `post_id=${id} status=${res.status}`);
    } else {
      fail('create post (unrestricted)', `status=${res.status} body=${res.text?.slice(0, 200)}`);
    }
  }

  const parentId = createdPostIds[0];

  // ── 2. RESTRICTED_TOWNHALL blocks create + upload ──────────────────────
  {
    await prisma.user_tag.create({
      data: {
        user_id: userA.user_id,
        tag: 'RESTRICTED_TOWNHALL',
        color: '#EF4444',
      },
    });
    const createRes = await api('POST', '/town-hall', {
      token: tokenA,
      body: { content: `should fail ${stamp}` },
    });
    if (createRes.status === 403) pass('RESTRICTED blocks create', `status=403`);
    else fail('RESTRICTED blocks create', `status=${createRes.status} body=${createRes.text?.slice(0, 200)}`);

    // multipart without file still hits auth + restrict before multer file check ideally;
    // send empty body — expect 403 restricted (or 400 no file if restrict runs after multer).
    const uploadRes = await api('POST', '/town-hall/upload', { token: tokenA, body: {} });
    // Our route checks restrict before file — but Content-Type json may skip multer.
    // Use fetch FormData for a real upload attempt.
    const fd = new FormData();
    fd.append('media', new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' }), 'x.png');
    const up = await fetch(`${BASE}/town-hall/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: fd,
    });
    if (up.status === 403) pass('RESTRICTED blocks upload', `status=403`);
    else fail('RESTRICTED blocks upload', `status=${up.status} body=${(await up.text()).slice(0, 200)}`);

    await prisma.user_tag.deleteMany({
      where: { user_id: userA.user_id, tag: 'RESTRICTED_TOWNHALL' },
    });
  }

  // ── 3. Arbitrary media_url rejected ────────────────────────────────────
  {
    const res = await api('POST', '/town-hall', {
      token: tokenA,
      body: {
        content: 'evil media',
        media_url: 'https://evil.example/malware.jpg',
        media_type: 'image',
      },
    });
    if (res.status === 400) pass('rejects arbitrary media_url', `status=400`);
    else fail('rejects arbitrary media_url', `status=${res.status} body=${res.text?.slice(0, 200)}`);
  }

  // ── 4. Delete removes replies (does not promote) ───────────────────────
  {
    const parent = await api('POST', '/town-hall', {
      token: tokenA,
      body: { content: `del-parent ${stamp}` },
    });
    const pId = parent.json?.post_id;
    if (!pId) {
      fail('delete-cascade setup parent', parent.text?.slice(0, 200));
    } else {
      createdPostIds.push(pId);
      const reply = await api('POST', '/town-hall', {
        token: tokenB,
        body: { content: `del-reply ${stamp}`, parent_id: pId },
      });
      const rId = reply.json?.post_id;
      if (rId) createdPostIds.push(rId);

      const del = await api('DELETE', `/town-hall/${pId}`, { token: tokenA });
      const replyStill = rId
        ? await prisma.town_hall_post.findUnique({ where: { post_id: rId } })
        : null;
      const replyPromoted = replyStill && replyStill.parent_id == null;

      if (del.status === 200 && !replyStill) {
        pass('delete cascades replies', `parent+reply gone`);
      } else if (replyPromoted) {
        fail('delete cascades replies', `reply promoted to top-level post_id=${rId}`);
      } else {
        fail('delete cascades replies', `del=${del.status} replyStill=${!!replyStill} parent_id=${replyStill?.parent_id}`);
      }
    }
  }

  // ── 5. Public + share hide banned / scheduled ──────────────────────────
  {
    const live = await prisma.town_hall_post.create({
      data: { user_id: userA.user_id, content: `live public ${stamp}` },
    });
    createdPostIds.push(live.post_id);

    const banned = await prisma.town_hall_post.create({
      data: { user_id: userA.user_id, content: `banned public ${stamp}`, is_banned: true },
    });
    createdPostIds.push(banned.post_id);

    const scheduled = await prisma.town_hall_post.create({
      data: {
        user_id: userA.user_id,
        content: `scheduled public ${stamp}`,
        scheduled_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });
    createdPostIds.push(scheduled.post_id);

    const pubLive = await api('GET', `/town-hall/public/${live.post_id}`);
    const pubBan = await api('GET', `/town-hall/public/${banned.post_id}`);
    const pubSched = await api('GET', `/town-hall/public/${scheduled.post_id}`);

    if (pubLive.status === 200 && pubLive.json?.post_id === live.post_id) {
      pass('GET /public/:id live', `status=200`);
    } else {
      fail('GET /public/:id live', `status=${pubLive.status} body=${pubLive.text?.slice(0, 200)}`);
    }
    if (pubBan.status === 404) pass('GET /public/:id banned → 404');
    else fail('GET /public/:id banned → 404', `status=${pubBan.status}`);
    if (pubSched.status === 404) pass('GET /public/:id scheduled → 404');
    else fail('GET /public/:id scheduled → 404', `status=${pubSched.status}`);

    const shareBan = await api('GET', `/town-hall/share/${banned.post_id}`, { raw: true });
    const shareSched = await api('GET', `/town-hall/share/${scheduled.post_id}`, { raw: true });
    const shareLive = await api('GET', `/town-hall/share/${live.post_id}`, { raw: true });

    if (shareBan.status === 404) pass('GET /share/:id banned → 404');
    else fail('GET /share/:id banned → 404', `status=${shareBan.status}`);
    if (shareSched.status === 404) pass('GET /share/:id scheduled → 404');
    else fail('GET /share/:id scheduled → 404', `status=${shareSched.status}`);
    if (shareLive.status === 200) pass('GET /share/:id live OK', `status=200`);
    else fail('GET /share/:id live OK', `status=${shareLive.status}`);
  }

  // ── 6. Search excludes banned ──────────────────────────────────────────
  {
    const marker = `zzsmokeban${stamp}`;
    const bannedSearch = await prisma.town_hall_post.create({
      data: { user_id: userA.user_id, content: marker, is_banned: true },
    });
    createdPostIds.push(bannedSearch.post_id);
    const liveSearch = await prisma.town_hall_post.create({
      data: { user_id: userA.user_id, content: marker },
    });
    createdPostIds.push(liveSearch.post_id);

    const res = await api('GET', `/town-hall/search-posts?q=${encodeURIComponent(marker)}`, {
      token: tokenB,
    });
    const posts = res.json?.posts || [];
    const hasBanned = posts.some((p) => p.post_id === bannedSearch.post_id);
    const hasLive = posts.some((p) => p.post_id === liveSearch.post_id);
    if (res.status === 200 && !hasBanned && hasLive) {
      pass('search excludes banned', `live found, banned hidden`);
    } else {
      fail('search excludes banned', `status=${res.status} hasBanned=${hasBanned} hasLive=${hasLive} n=${posts.length}`);
    }
  }

  // ── 7. Poll one-vote-per-post (incl. race) ─────────────────────────────
  // Seed via Prisma to avoid the create rate limiter (3 posts / 60s) after earlier creates.
  {
    let pollId = null;
    try {
      const pollPost = await prisma.town_hall_post.create({
        data: {
          user_id: userA.user_id,
          content: `poll ${stamp}`,
          poll_options: {
            create: [
              { option_text: 'Alpha' },
              { option_text: 'Beta' },
              { option_text: 'Gamma' },
            ],
          },
        },
      });
      pollId = pollPost.post_id;
      createdPostIds.push(pollId);
      pass('poll create (seeded)', `post_id=${pollId}`);
    } catch (e) {
      fail('poll create (seeded)', e.message);
    }

    if (pollId) {
      const options = await prisma.town_hall_poll_option.findMany({ where: { post_id: pollId } });
      if (options.length < 2) {
        fail('poll options seeded', `count=${options.length}`);
      } else {
        const [o1, o2] = options;
        // Concurrent votes on two options
        const [r1, r2] = await Promise.all([
          api('POST', `/town-hall/${pollId}/poll/vote`, { token: tokenB, body: { option_id: o1.option_id } }),
          api('POST', `/town-hall/${pollId}/poll/vote`, { token: tokenB, body: { option_id: o2.option_id } }),
        ]);
        let votes = -1;
        try {
          const rows = await prisma.$queryRaw`
            SELECT COUNT(*)::int AS c FROM town_hall_poll_vote
            WHERE post_id = ${pollId} AND user_id = ${userB.user_id}`;
          votes = rows[0]?.c ?? 0;
        } catch (e) {
          fail('poll vote count query', e.message.slice(0, 180));
          votes = await prisma.town_hall_poll_vote.count({
            where: { user_id: userB.user_id, option: { post_id: pollId } },
          }).catch(() => -1);
        }
        // One 201, one 400 (or both serialized to one success one fail)
        if (votes === 1 && [r1.status, r2.status].includes(201)) {
          pass('poll race → one vote', `statuses=${r1.status},${r2.status} votes=${votes}`);
        } else {
          fail('poll race → one vote', `statuses=${r1.status},${r2.status} votes=${votes} body1=${r1.text?.slice(0,120)} body2=${r2.text?.slice(0,120)}`);
        }

        const again = await api('POST', `/town-hall/${pollId}/poll/vote`, {
          token: tokenB,
          body: { option_id: o1.option_id },
        });
        if (again.status === 400) pass('poll second vote rejected', `status=400`);
        else fail('poll second vote rejected', `status=${again.status} body=${again.text?.slice(0, 200)}`);
      }
    }
  }

  // ── 8. Engagement blocked on banned ────────────────────────────────────
  {
    const banned = await prisma.town_hall_post.create({
      data: { user_id: userA.user_id, content: `eng ban ${stamp}`, is_banned: true },
    });
    createdPostIds.push(banned.post_id);

    const like = await api('POST', `/town-hall/${banned.post_id}/like`, { token: tokenB });
    const view = await api('POST', `/town-hall/${banned.post_id}/view`, { token: tokenB });
    const save = await api('POST', '/town-hall/save', { token: tokenB, body: { post_id: banned.post_id } });
    const repost = await api('POST', `/town-hall/${banned.post_id}/repost`, { token: tokenB });

    const all404 = [like, view, save, repost].every((r) => r.status === 404);
    if (all404) pass('engagement blocked on banned', `like/view/save/repost → 404`);
    else {
      fail(
        'engagement blocked on banned',
        `like=${like.status} view=${view.status} save=${save.status} repost=${repost.status}`,
      );
    }
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
console.log('All critical Town Hall fixes look good.');
process.exit(0);
