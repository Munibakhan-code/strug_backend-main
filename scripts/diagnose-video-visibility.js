// scripts/diagnose-video-visibility.js
//
// Answers "the creator says it's published, so why isn't it in the Videos feed?" without a
// two-hour investigation. Prints, per video, every gate it fails.
//
//   node scripts/diagnose-video-visibility.js            # all videos hidden from the feed
//   node scripts/diagnose-video-visibility.js 1234       # one video by id
//   node scripts/diagnose-video-visibility.js --all      # every video, visible or not
//
// Reads only. Points at whatever DATABASE_URL is in the environment — check that before you
// trust the output (local .env is STAGING).

import 'dotenv/config';
import prisma from '../utils/prisma-client.js';
import { visibleVideoWhere, visibilityBlockers, VISIBILITY_SELECT } from '../utils/video-visibility.js';

const REASONS = {
  not_published:      "status is not 'safe' — the worker never completed it (only the worker sets 'safe')",
  banned_by_moderation:"status='banned' — Azure Content Safety auto-banned a sampled frame",
  private:            "status='private'",
  still_processing:   "processing_status is not 'done' — still in the transcode queue",
  processing_failed:  "processing_status='error' — transcode failed and was terminalized",
  channel_inactive:   'channel.is_active = false',
  creator_banned:     'the creator\'s social profile is banned',
  missing_hls:        "processing_status='done' but hls_url is NULL — nothing to play",
};

const arg = process.argv[2];

async function main() {
  const where =
    arg && /^\d+$/.test(arg) ? { video_id: Number(arg) }
    : arg === '--all' ? {}
    : { NOT: visibleVideoWhere() };   // default: exactly the videos the feed will not show

  const videos = await prisma.video.findMany({
    where,
    orderBy: { video_id: 'desc' },
    take: 200,
    select: { video_id: true, title: true, created_at: true, ...VISIBILITY_SELECT },
  });

  const visibleCount = await prisma.video.count({ where: visibleVideoWhere() });
  const totalCount = await prisma.video.count();

  console.log(`DB: ${(process.env.DATABASE_URL || '').replace(/:[^:@]*@/, ':***@').slice(0, 70)}`);
  console.log(`${visibleCount} of ${totalCount} videos are visible in the Videos feed.\n`);

  if (!videos.length) {
    console.log('Nothing to report.');
    return;
  }

  for (const v of videos) {
    const blockers = visibilityBlockers(v);
    const title = (v.title || '(untitled)').slice(0, 44);
    if (!blockers.length) {
      console.log(`#${v.video_id}  VISIBLE   ${title}`);
      continue;
    }
    console.log(`#${v.video_id}  HIDDEN    ${title}`);
    for (const b of blockers) console.log(`             - ${b}: ${REASONS[b] ?? b}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
