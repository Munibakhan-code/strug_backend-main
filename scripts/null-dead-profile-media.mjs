// Board #481 — "no profile photos or banners in Town Hall".
//
// Root cause: a large number of social_profile rows point profile_pic_url / banner_url at
// Azure blobs that were purged (they 404). The DB kept the dead URL. The frontend already
// degrades gracefully to initials (SafeImage/Avatar), but the dead URLs still fire a wasted
// 404 per render and leave the data in a lying state.
//
// This idempotent maintenance script HEAD-checks every non-null profile_pic_url / banner_url
// and NULLs the ones whose blob no longer exists (any non-2xx / network error). Real users
// re-upload to restore; demo/seed accounts fall back to initials.
//
// SAFE BY DEFAULT: dry-run (reports only). Pass --apply to write. Pass --limit=N to cap.
//
//   node scripts/null-dead-profile-media.mjs                 # dry-run, report what WOULD change
//   node scripts/null-dead-profile-media.mjs --apply         # actually NULL the dead URLs
//   node scripts/null-dead-profile-media.mjs --apply --limit=500
//
// Writes the affected user_ids to stdout (JSON) at the end so a follow-up re-upload notice
// (#11) can target exactly those accounts.

import prisma from '../utils/prisma-client.js';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 0) : null;
const CONCURRENCY = 12;

async function blobIsAlive(url) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) return true; // not a blob URL — leave it
  try {
    // HEAD is enough; Azure blob returns 404 for a purged blob and 200 when it exists.
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(12000) });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false; // network error / timeout — treat as dead (idempotent: re-run confirms)
  }
}

async function mapPool(items, fn, concurrency) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

async function main() {
  console.log(`\n[null-dead-profile-media] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}${LIMIT ? ` limit=${LIMIT}` : ''}\n`);

  const rows = await prisma.social_profile.findMany({
    where: { OR: [{ profile_pic_url: { not: null } }, { banner_url: { not: null } }] },
    select: { profile_id: true, user_id: true, handle: true, profile_pic_url: true, banner_url: true },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(`Scanning ${rows.length} profiles with a non-null pic/banner…`);

  const results = await mapPool(
    rows,
    async (r) => {
      const [picAlive, bannerAlive] = await Promise.all([
        r.profile_pic_url ? blobIsAlive(r.profile_pic_url) : Promise.resolve(true),
        r.banner_url ? blobIsAlive(r.banner_url) : Promise.resolve(true),
      ]);
      return { r, deadPic: r.profile_pic_url && !picAlive, deadBanner: r.banner_url && !bannerAlive };
    },
    CONCURRENCY,
  );

  const affected = results.filter((x) => x.deadPic || x.deadBanner);
  const deadPics = affected.filter((x) => x.deadPic).length;
  const deadBanners = affected.filter((x) => x.deadBanner).length;
  console.log(`\nDead: ${deadPics} profile_pic_url, ${deadBanners} banner_url  (across ${affected.length} profiles)`);

  if (APPLY && affected.length) {
    for (const x of affected) {
      await prisma.social_profile.update({
        where: { profile_id: x.r.profile_id },
        data: {
          ...(x.deadPic ? { profile_pic_url: null } : {}),
          ...(x.deadBanner ? { banner_url: null } : {}),
          // #11: flag the account for a one-time "please re-upload" notice.
          avatar_reset_notice: true,
        },
      });
    }
    console.log(`✅ Nulled dead media on ${affected.length} profiles.`);
  } else if (affected.length) {
    console.log('DRY-RUN — no writes. Re-run with --apply to null these.');
    for (const x of affected.slice(0, 20)) {
      console.log(`  @${x.r.handle} (user ${x.r.user_id}) ${x.deadPic ? 'pic ' : ''}${x.deadBanner ? 'banner' : ''}`);
    }
    if (affected.length > 20) console.log(`  …and ${affected.length - 20} more`);
  }

  // Emit affected user_ids so #11 (one-time re-upload notice) can target exactly these accounts.
  console.log('\nAFFECTED_USER_IDS=' + JSON.stringify(affected.map((x) => x.r.user_id)));
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
