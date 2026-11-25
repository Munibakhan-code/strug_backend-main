#!/usr/bin/env node
/**
 * Assign scraped comments/reactions/views to feed targets using @strug-dummy.ca seed accounts.
 * DB-direct (no API login) — mirrors Sathsara's VPS assigner; see issue #1220.
 *
 * Input: JSON manifest (see scripts/fixtures/seed-engagement-sample.json)
 *
 * SAFE BY DEFAULT: dry-run. Pass --apply to write.
 *
 *   node scripts/seed-engagement-assign.mjs --manifest=scripts/fixtures/seed-engagement-sample.json
 *   node scripts/seed-engagement-assign.mjs --manifest=./my-targets.json --apply
 *
 * Tables touched:
 *   social  → social_interactions, social_comments, social_post_view
 *   townhall → town_hall_post_like, town_hall_post (replies), town_hall_post_view + view_count
 *   video   → video_likes, video_comments, video_view + views_count
 *
 * RE-RUNS: likes and views are idempotent — they rely on the unique constraints on
 * social_post_view, town_hall_post_view, town_hall_post_like, video_likes and video_view,
 * and the counters increment by the number of rows actually inserted. COMMENTS ARE NOT.
 * social_comments, town hall replies and video_comments have no uniqueness, so running the
 * same manifest twice posts every comment twice. Run a manifest once, or trim the comment
 * lists before re-running.
 */
import fs from 'node:fs';
import path from 'node:path';
import prisma from '../utils/prisma-client.js';
import {
  capCountsToPool,
  computeEngagementCounts,
  DUMMY_EMAIL_SUFFIX,
  parseEngagementManifest,
  pickComments,
  pickDistinct,
  staggerTimestamps,
} from '../utils/seed-engagement.js';

const APPLY = process.argv.includes('--apply');
const manifestArg = process.argv.find((a) => a.startsWith('--manifest='));
const MANIFEST_PATH = manifestArg
  ? path.resolve(manifestArg.split('=').slice(1).join('='))
  : path.join(process.cwd(), 'scripts/fixtures/seed-engagement-sample.json');

async function loadSeedPool() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: DUMMY_EMAIL_SUFFIX } },
    select: {
      user_id: true,
      social_profile: { select: { profile_id: true, handle: true } },
    },
  });
  return users
    .filter((u) => u.social_profile?.profile_id)
    .map((u) => ({
      user_id: u.user_id,
      profile_id: u.social_profile.profile_id,
      handle: u.social_profile.handle,
    }));
}

async function assertTargetExists(type, id) {
  if (type === 'social') {
    const row = await prisma.social_feed.findUnique({
      where: { social_post_id: id },
      select: { social_post_id: true, profile_id: true, created_at: true },
    });
    if (!row) throw new Error(`social post ${id} not found`);
    return row;
  }
  if (type === 'townhall') {
    const row = await prisma.town_hall_post.findUnique({
      where: { post_id: id },
      select: { post_id: true, user_id: true, parent_id: true, created_at: true },
    });
    if (!row) throw new Error(`town hall post ${id} not found`);
    if (row.parent_id) throw new Error(`town hall ${id} is a reply — use parent post id`);
    return row;
  }
  if (type === 'video') {
    const row = await prisma.video.findUnique({
      where: { video_id: id },
      select: { video_id: true, channel_id: true, created_at: true },
    });
    if (!row) throw new Error(`video ${id} not found`);
    return row;
  }
  throw new Error(`unknown type ${type}`);
}

function ageDaysFrom(createdAt) {
  if (!createdAt) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000));
}

async function existingSocialLikers(postId) {
  const rows = await prisma.social_interactions.findMany({
    where: { social_post_id: postId, reaction_type: 'like' },
    select: { profile_id: true },
  });
  return new Set(rows.map((r) => r.profile_id));
}

async function existingTownhallLikers(postId) {
  const rows = await prisma.town_hall_post_like.findMany({
    where: { post_id: postId },
    select: { user_id: true },
  });
  return new Set(rows.map((r) => r.user_id));
}

async function existingVideoLikers(videoId) {
  const rows = await prisma.video_likes.findMany({
    where: { video_id: videoId, is_like: true },
    select: { user_id: true },
  });
  return new Set(rows.map((r) => r.user_id));
}

async function assignSocial(targetId, pool, counts, commentTexts, apply) {
  const usedLikers = apply ? await existingSocialLikers(targetId) : new Set();
  const likePool = pool.filter((p) => !usedLikers.has(p.profile_id));
  const likeActors = pickDistinct(likePool, counts.likes);
  const commentActors = pickDistinct(pool, counts.comments);
  const viewActors = pickDistinct(pool, counts.views);
  // social_interactions has no timestamp column — likes land at insert time.
  const commentTimes = staggerTimestamps(commentActors.length);
  const viewTimes = staggerTimestamps(viewActors.length);

  console.log(`    social #${targetId}: views=${viewActors.length} likes=${likeActors.length} comments=${commentActors.length}`);

  if (!apply) return;

  for (let i = 0; i < likeActors.length; i++) {
    await prisma.social_interactions.create({
      data: {
        social_post_id: targetId,
        profile_id: likeActors[i].profile_id,
        reaction_type: 'like',
      },
    });
  }

  for (let i = 0; i < commentActors.length; i++) {
    await prisma.social_comments.create({
      data: {
        social_post_id: targetId,
        profile_id: commentActors[i].profile_id,
        text: commentTexts[i] || 'Nice post!',
        timestamp: commentTimes[i],
      },
    });
  }

  for (let i = 0; i < viewActors.length; i++) {
    await prisma.social_post_view.createMany({
      data: [{
        post_id: targetId,
        profile_id: viewActors[i].profile_id,
        created_at: viewTimes[i],
      }],
      skipDuplicates: true,
    });
  }
}

async function assignTownhall(targetId, pool, counts, commentTexts, apply) {
  const usedLikers = apply ? await existingTownhallLikers(targetId) : new Set();
  const likePool = pool.filter((p) => !usedLikers.has(p.user_id));
  const likeActors = pickDistinct(likePool, counts.likes);
  const commentActors = pickDistinct(pool, counts.comments);
  const viewActors = pickDistinct(pool, counts.views);
  const likeTimes = staggerTimestamps(likeActors.length);
  const commentTimes = staggerTimestamps(commentActors.length);
  const viewTimes = staggerTimestamps(viewActors.length);

  console.log(`    townhall #${targetId}: views=${viewActors.length} likes=${likeActors.length} replies=${commentActors.length}`);

  if (!apply) return;

  for (let i = 0; i < likeActors.length; i++) {
    await prisma.town_hall_post_like.createMany({
      data: [{ post_id: targetId, user_id: likeActors[i].user_id, created_at: likeTimes[i] }],
      skipDuplicates: true,
    });
  }

  for (let i = 0; i < commentActors.length; i++) {
    await prisma.town_hall_post.create({
      data: {
        user_id: commentActors[i].user_id,
        parent_id: targetId,
        content: (commentTexts[i] || 'Well said.').slice(0, 280),
        created_at: commentTimes[i],
      },
    });
  }

  let newViews = 0;
  for (let i = 0; i < viewActors.length; i++) {
    const inserted = await prisma.town_hall_post_view.createMany({
      data: [{ post_id: targetId, user_id: viewActors[i].user_id, viewed_at: viewTimes[i] }],
      skipDuplicates: true,
    });
    newViews += inserted.count;
  }
  if (newViews > 0) {
    await prisma.town_hall_post.update({
      where: { post_id: targetId },
      data: { view_count: { increment: newViews } },
    });
  }
}

async function assignVideo(targetId, pool, counts, commentTexts, apply) {
  const usedLikers = apply ? await existingVideoLikers(targetId) : new Set();
  const likePool = pool.filter((p) => !usedLikers.has(p.user_id));
  const likeActors = pickDistinct(likePool, counts.likes);
  const commentActors = pickDistinct(pool, counts.comments);
  const viewActors = pickDistinct(pool, counts.views);
  const likeTimes = staggerTimestamps(likeActors.length);
  const commentTimes = staggerTimestamps(commentActors.length);
  const viewTimes = staggerTimestamps(viewActors.length);

  console.log(`    video #${targetId}: views=${viewActors.length} likes=${likeActors.length} comments=${commentActors.length}`);

  if (!apply) return;

  for (let i = 0; i < likeActors.length; i++) {
    await prisma.video_likes.createMany({
      data: [{
        video_id: targetId,
        user_id: likeActors[i].user_id,
        is_like: true,
        created_at: likeTimes[i],
      }],
      skipDuplicates: true,
    });
  }

  for (let i = 0; i < commentActors.length; i++) {
    await prisma.video_comments.create({
      data: {
        video_id: targetId,
        user_id: commentActors[i].user_id,
        content: commentTexts[i] || 'Great video!',
        created_at: commentTimes[i],
      },
    });
  }

  // A view is a video_view row PLUS the counter, the way video-engagement-routes.js writes it.
  // Incrementing the counter alone would double-count on a re-run and drift the number away
  // from the video_view table that board analytics reads.
  let newViews = 0;
  for (let i = 0; i < viewActors.length; i++) {
    const inserted = await prisma.video_view.createMany({
      data: [{
        video_id: targetId,
        identifier: `seed:${viewActors[i].user_id}`,
        viewed_at: viewTimes[i],
      }],
      skipDuplicates: true,
    });
    newViews += inserted.count;
  }
  if (newViews > 0) {
    await prisma.video.update({
      where: { video_id: targetId },
      data: { views_count: { increment: newViews } },
    });
  }
}

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`[seed-engagement] manifest not found: ${MANIFEST_PATH}`);
    process.exitCode = 1;
    return;
  }

  const manifest = parseEngagementManifest(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')));
  const pool = await loadSeedPool();

  console.log(`[seed-engagement] mode: ${APPLY ? 'COMMIT' : 'DRY RUN'}`);
  console.log(`[seed-engagement] manifest: ${MANIFEST_PATH}`);
  console.log(`[seed-engagement] seed pool: ${pool.length} ${DUMMY_EMAIL_SUFFIX} account(s)`);
  console.log(`[seed-engagement] targets: ${manifest.targets.length}  scraped comments: ${manifest.comments.length}`);

  if (!pool.length) {
    console.error('[seed-engagement] no seed accounts — run seed-feed-users.mjs --apply first');
    process.exitCode = 1;
    return;
  }

  for (const target of manifest.targets) {
    const row = await assertTargetExists(target.type, target.id);
    const ageDays = ageDaysFrom(row.created_at);
    const rawCounts = computeEngagementCounts({ ...manifest.ratios, ageDays });
    const counts = capCountsToPool(rawCounts, pool.length);
    const commentTexts = pickComments(manifest.comments, counts.comments);

    console.log(`  ${target.type} #${target.id} (age ${ageDays}d) → planned views=${counts.views} likes=${counts.likes} comments=${counts.comments}`);

    if (target.type === 'social') {
      await assignSocial(target.id, pool, counts, commentTexts, APPLY);
    } else if (target.type === 'townhall') {
      await assignTownhall(target.id, pool, counts, commentTexts, APPLY);
    } else if (target.type === 'video') {
      await assignVideo(target.id, pool, counts, commentTexts, APPLY);
    }
  }

  if (!APPLY) {
    console.log('\n[seed-engagement] DRY RUN — pass --apply to insert engagements.');
  }
}

main()
  .catch((err) => {
    console.error('[seed-engagement] fatal:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
