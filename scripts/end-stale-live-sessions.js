import 'dotenv/config';
import prisma from '../utils/prisma-client.js';

const live = await prisma.live_session.findMany({
  where: { status: { in: ['LIVE', 'STARTING'] } },
  select: { session_id: true, status: true, stream_key: true, title: true },
});
console.log('Active sessions before:', JSON.stringify(live, null, 2));

const base = (process.env.LIVE_HLS_BASE || '').replace(/\/$/, '');
for (const s of live) {
  if (s.status === 'STARTING') {
    await prisma.live_session.update({
      where: { session_id: s.session_id },
      data: { status: 'CANCELLED', ended_at: new Date() },
    });
    console.log('Cancelled STARTING', s.session_id);
    continue;
  }
  if (!s.stream_key || !base) continue;
  const url = `${base}/${s.stream_key}/index.m3u8`;
  let ok = false;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    ok = r.ok;
  } catch {
    ok = false;
  }
  if (!ok) {
    await prisma.live_session.update({
      where: { session_id: s.session_id },
      data: { status: 'FINISHED', ended_at: new Date() },
    });
    console.log('Ended dead LIVE session', s.session_id, url);
  } else {
    console.log('Still publishing', s.session_id);
  }
}

const after = await prisma.live_session.findMany({
  where: { status: { in: ['LIVE', 'STARTING'] } },
  select: { session_id: true, status: true, title: true },
});
console.log('Active sessions after:', JSON.stringify(after));
await prisma.$disconnect();
