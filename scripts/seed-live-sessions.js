// Seed a few LIVE sessions on the modern live_session system so the unified viewer
// browse page (GET /live-session/live) is populated. Idempotent: skips a streamer that
// already has a STARTING/LIVE session. Uses real public HLS test streams as playback_url
// until real RTMP->HLS egress lands (see LIVE_STREAMING_AUDIT_PLAN.md §F).
//
// Run:  node scripts/seed-live-sessions.js
import crypto from 'crypto';
import prisma from '../utils/prisma-client.js';

const HLS = [
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
  'https://test-streams.mux.dev/pts_shift/master.m3u8',
];

const TITLES = [
  'LIVE: Ranked Grind to Diamond',
  'LIVE: Lo-fi Beats & Chill Coding',
  'LIVE: Q&A — Ask Me Anything',
];

async function main() {
  const profiles = await prisma.live_streamer_profile.findMany({
    take: 3,
    orderBy: { streamer_id: 'asc' },
    include: { category: true },
  });

  if (profiles.length === 0) {
    console.log('No live_streamer_profile rows — create streamer profiles first. Nothing seeded.');
    return;
  }

  let created = 0;
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    const existing = await prisma.live_session.findFirst({
      where: { streamer_id: p.streamer_id, status: { in: ['STARTING', 'LIVE'] } },
    });
    if (existing) {
      console.log(`streamer ${p.streamer_id} (@${p.handle}) already live (session ${existing.session_id}) — skip`);
      continue;
    }

    const session = await prisma.live_session.create({
      data: {
        streamer_id: p.streamer_id,
        stream_key: `strug_seed_${crypto.randomBytes(10).toString('hex')}`,
        ingest_url: 'rtmp://acs-strug-staging.canada.communication.azure.com/live',
        playback_url: HLS[i % HLS.length],
        title: TITLES[i % TITLES.length],
        description: 'Seeded live session for the unified browse page.',
        status: 'LIVE',
        started_at: new Date(),
      },
    });
    created++;
    console.log(`+ session ${session.session_id} LIVE for @${p.handle} (${p.category?.category_name ?? 'General'})`);
  }

  console.log(`Done. ${created} session(s) created.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
