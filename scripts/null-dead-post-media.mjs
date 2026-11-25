// Board #482 follow-up — the third casualty of the same storage purge.
//
// #481 established the pattern: a purge removed blobs while the DB kept pointing at them, so every
// render fires a wasted 404 and the data lies about what exists. scripts/null-dead-profile-media.mjs
// swept `social_profile.profile_pic_url` / `banner_url` for exactly that.
//
// It never touched `town_hall_post.media_url`. So post media was left in the same broken state and
// nothing has cleaned it since: @drake's posts return 6/6 HTTP 404 on prod. It is PARTIAL, not total
// (@fuckjerry's media still resolves), consistent with one bulk-import batch being caught by the
// purge — drake's URLs are all stamped within ~2 seconds of each other.
//
// This is the same idempotent HEAD-check-then-NULL sweep, pointed at posts.
//
// ─── Why nulling is safe here ─────────────────────────────────────────────────────────────────────
// `town_hall_post.content` is NOT NULL, so a post always keeps its text — nulling dead media
// degrades it to a text post rather than emptying it. Posts whose content is nevertheless blank are
// NOT deleted; they are reported at the end so a human can decide. This script never deletes rows.
//
// SAFE BY DEFAULT: dry-run (reports only). Pass --apply to write. --limit=N to cap.
//
//   node scripts/null-dead-post-media.mjs                 # report what WOULD change
//   node scripts/null-dead-post-media.mjs --apply
//   node scripts/null-dead-post-media.mjs --apply --limit=500

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
        // ⚠️ Deliberately conservative: a network error/timeout is NOT treated as dead here.
        // The profile sweep counted it as dead, which is fine for an avatar (the user re-uploads),
        // but nulling a post's media on a transient blip destroys the only pointer to media that may
        // be perfectly alive. Only a definitive non-2xx HTTP response counts.
        return true;
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
    console.log(`\n[null-dead-post-media] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}${LIMIT ? ` limit=${LIMIT}` : ''}\n`);

    const rows = await prisma.town_hall_post.findMany({
        where: { media_url: { not: null } },
        select: { post_id: true, user_id: true, content: true, media_url: true, media_type: true },
        orderBy: { post_id: 'asc' },
        ...(LIMIT ? { take: LIMIT } : {}),
    });
    console.log(`Scanning ${rows.length} town hall post(s) with a non-null media_url…`);
    if (!rows.length) { await prisma.$disconnect(); return; }

    const results = await mapPool(rows, async (r) => ({ r, dead: !(await blobIsAlive(r.media_url)) }), CONCURRENCY);
    const affected = results.filter((x) => x.dead);

    const byType = {};
    for (const x of affected) byType[x.r.media_type || 'unknown'] = (byType[x.r.media_type || 'unknown'] || 0) + 1;

    console.log(`\nDead media: ${affected.length} / ${rows.length} posts`);
    for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${t}`);

    // A post that loses its media AND has no text is left with nothing to render. Report, never delete.
    const blanked = affected.filter((x) => !String(x.r.content || '').trim());
    if (blanked.length) {
        console.log(`\n⚠️  ${blanked.length} of these have EMPTY content — nulling leaves a post with nothing to show.`);
        console.log(`    Not deleted by this script. Review: ${JSON.stringify(blanked.slice(0, 50).map((x) => x.r.post_id))}`);
    }

    if (!APPLY) {
        console.log('\nDRY-RUN — no writes. Re-run with --apply to null these.');
        for (const x of affected.slice(0, 20)) {
            console.log(`  post ${x.r.post_id} (user ${x.r.user_id}) ${x.r.media_type || '?'} — ${(x.r.media_url || '').slice(-46)}`);
        }
        if (affected.length > 20) console.log(`  …and ${affected.length - 20} more`);
        await prisma.$disconnect();
        return;
    }

    let done = 0;
    for (const x of affected) {
        // Clear media_type alongside media_url — a type with no URL is the same lying state this
        // sweep exists to remove, and the renderer branches on media_type.
        await prisma.town_hall_post.update({
            where: { post_id: x.r.post_id },
            data: { media_url: null, media_type: null },
        });
        done++;
    }
    console.log(`\n✅ Nulled dead media on ${done} post(s).`);
    await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
