// Board #482 / #481 — "I can't see profiles or banners on town hall".
//
// A storage purge removed the demo personas' profile_pic_url / banner_url blobs and
// null-dead-profile-media.mjs (correctly) NULLed the dead URLs. The originals are NOT recoverable:
// the prod storage account has soft-delete, versioning, change-feed and point-in-time restore all
// DISABLED, and the local purge-prep folders hold only video DB backups. So they must be re-created.
//
// A first pass attached initials-on-a-gradient SVGs. That was letters, not pictures — not what was
// reported. This version matches each persona to a REAL image by name/handle and, critically, only
// uses it when the licence actually permits it.
//
// ─── SOURCING + LICENCE ───────────────────────────────────────────────────────────────────────────
// Images come from Wikipedia/Wikimedia Commons, because it is the one large source where "is this
// fine to use?" is answerable programmatically — every file carries machine-readable licence
// metadata. We accept ONLY free licences (public domain / CC0 / CC BY / CC BY-SA) and reject
// anything non-free (fair-use stills, "used with permission", unknown).
//
// ⚠️ CC BY and CC BY-SA are free but REQUIRE ATTRIBUTION. Dropping the credit is a licence breach,
// so every accepted image is recorded (artist, licence, source page) into an attribution manifest
// written next to this script. That manifest has to be surfaced somewhere user-visible (a /credits
// page) for the CC BY-SA images to be genuinely compliant — see the summary this prints at the end.
//
// Personas with no free-licensed match fall back to a deterministic Unsplash-licensed photo, so
// every profile still ends up with a real picture rather than a blank disc.
//
// ─── SAFETY: this cannot touch a real member's profile ─────────────────────────────────────────────
//   oatmeal -> dummy_oatmeal_1a5515bf@strug-dummy.ca   (demo)
//   xavier  -> xavywinters@gmail.com                   (REAL)
// Selector is user.email endsWith '@strug-dummy.ca'. Within those, only media that is NULL or that
// THIS script generated (the seed-avatars/ prefix) is replaced — a member upload
// (profile-<id>-<ts>.png) matches neither branch.
//
// SAFE BY DEFAULT: dry-run. Pass --apply to write.
//
//   node scripts/reseed-dummy-avatars.mjs                 # report matches + licences, write nothing
//   node scripts/reseed-dummy-avatars.mjs --apply
//   node scripts/reseed-dummy-avatars.mjs --apply --limit=50

import fs from 'node:fs';
import path from 'node:path';
import prisma from '../utils/prisma-client.js';
import { uploadPublicBlob } from '../utils/azure-storage.js';

const APPLY = process.argv.includes('--apply');
const AVATARS_ONLY = process.argv.includes('--avatars-only');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 0) : null;

const DUMMY_EMAIL_SUFFIX = '@strug-dummy.ca';
const CONTAINER = process.env.AZURE_SOCIAL_POSTS_CONTAINER;
// Anything this script generated lives under this prefix — the ONLY media it may replace.
const SEED_PREFIX = 'seed-avatars/';
// Wikimedia requires a descriptive User-Agent; anonymous scraping gets rate-limited or blocked.
const UA = 'strug-seed-avatars/1.0 (https://strug.ca; contact: senudak@strug.ca)';
const POLITE_DELAY_MS = 150;

// Free licences only. Anything not matching (fair use, "permission", unknown) is REJECTED.
//
// ⚠️ NC (NonCommercial) and ND (NoDerivatives) must be rejected explicitly and FIRST. An earlier
// version used /^cc-by(-sa)?(-\d...)?/ with no end anchor, so "cc-by-nc-2.0" matched on the `cc-by`
// prefix alone and NonCommercial images sailed through the gate — unusable on a commercial platform
// and exactly the licence breach this check exists to prevent. Anchor the pattern; test the NC/ND
// exclusion whenever this regex is touched.
const NONFREE_CLAUSE = /(^|-)(nc|nd)(-|$)/i;
const FREE_LICENCE = /^(cc0(-\d(\.\d)?)?|cc-by(-sa)?(-\d(\.\d)?)?|pd|pd-[\w-]+|public\s*domain|cc-pd)$/i;
const isFreeLicence = (l) => {
    const s = String(l || '').trim();
    return !!s && !NONFREE_CLAUSE.test(s) && FREE_LICENCE.test(s);
};
const NEEDS_ATTRIBUTION = /^cc-by/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').trim();

async function wiki(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
}

// "The Oatmeal ( Fan )" -> "The Oatmeal"; "Tity Boi (2 Chainz) ( Fan )" -> "Tity Boi"
//
// ⚠️ Fold accents FIRST. `\w` is ASCII-only, so stripping with /[^\w\s.'-]/ turned
// "Yung Rénzél 👑 ( Fan )" into "Yung R nz l" — a nonsense query that still returned a
// confident-looking Commons hit ("Hyundai Ioniq Hybrid at Cabanatuan.jpg" on Rick Ross's page).
// NFD + combining-mark strip maps é->e and keeps the name searchable.
function searchNameFor(displayName, handle) {
    const folded = String(displayName || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
    const cleaned = folded.replace(/\([^)]*\)/g, ' ').replace(/[^\w\s.'-]/g, ' ')
        .replace(/\s+/g, ' ').replace(/[.\s'-]+$/, '').trim();
    return cleaned.length >= 3 ? cleaned : String(handle || '').replace(/[_\d]+/g, ' ').trim();
}

// Resolve a persona name to its CANONICAL Wikipedia title, following redirects ("Drizzy" ->
// "Drake (musician)"). Used for two things: it is the better banner search term, and it is the
// yardstick for whether a banner hit is actually about this subject. No article => no match at
// all, which is correct: a generic fallback photo beats a confidently wrong one.
async function canonicalTitle(name) {
    try {
        const d = await wiki(`https://en.wikipedia.org/w/api.php?action=query&format=json`
            + `&titles=${encodeURIComponent(name)}&redirects=1`);
        const page = Object.values(d?.query?.pages || {})[0];
        if (!page || page.missing !== undefined) return null;
        return page.title || null;
    } catch { return null; }
}

// Every image actually used on the subject's Wikipedia article.
//
// This replaced a Commons keyword search + filename-relevance heuristic, which could not be made
// safe: searching "Rick Ross" off a mangled name returned a Hyundai, and once the name was fixed,
// "Drake (musician)" -> token "drake" happily matched "Wood duck drake vocalizing in Central Park".
// Fuzzy matching a name against a filename is the wrong instrument. Images embedded in the person's
// own article are on-topic by construction, so relevance stops being a guess.
async function articleImages(canonical) {
    try {
        const d = await wiki(`https://en.wikipedia.org/w/api.php?action=query&format=json`
            + `&titles=${encodeURIComponent(canonical)}&prop=images&imlimit=40`);
        const page = Object.values(d?.query?.pages || {})[0];
        return (page?.images || [])
            .map((i) => i.title)
            // Skip the chrome Wikipedia embeds on every article (icons, audio, commons logos).
            .filter((t) => /\.(jpe?g|png)$/i.test(t))
            .filter((t) => !/(commons-logo|wiki|icon|ambox|question_book|edit-|padlock|symbol|flag of|loudspeaker|sound-icon)/i.test(t));
    } catch { return []; }
}

// Resolve a Commons/Wikipedia File: title to {url, licence, artist, source} IF the licence is free.
async function fileIfFree(site, fileTitle, width) {
    const q = `https://${site}/w/api.php?action=query&format=json&titles=${encodeURIComponent(fileTitle)}`
        + `&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=${width}`;
    const d = await wiki(q);
    const page = Object.values(d?.query?.pages || {})[0];
    const ii = (page?.imageinfo || [])[0];
    if (!ii) return null;
    const em = ii.extmetadata || {};
    const licence = (em.License?.value || '').trim();
    const restrictions = (em.Restrictions?.value || '').trim();
    if (!isFreeLicence(licence)) return null;           // non-free / NC / ND -> refuse
    if (restrictions) return null;                      // trademark/personality restrictions -> refuse
    return {
        url: ii.thumburl || ii.url,
        width: ii.thumbwidth || ii.width,
        height: ii.thumbheight || ii.height,
        licence,
        licenceName: stripTags(em.LicenseShortName?.value) || licence,
        artist: stripTags(em.Artist?.value).slice(0, 160) || 'Unknown',
        source: ii.descriptionurl || `https://${site}/wiki/${encodeURIComponent(fileTitle)}`,
        file: fileTitle,
    };
}

// Avatar: the subject's own Wikipedia lead image, when it is free-licensed.
async function matchAvatar(name) {
    try {
        const d = await wiki(`https://en.wikipedia.org/w/api.php?action=query&format=json`
            + `&titles=${encodeURIComponent(name)}&prop=pageimages&piprop=name&redirects=1`);
        const page = Object.values(d?.query?.pages || {})[0];
        if (!page?.pageimage) return null;
        return await fileIfFree('commons.wikimedia.org', `File:${page.pageimage}`, 512);
    } catch { return null; }
}

// Banner: a LANDSCAPE image from the subject's own Wikipedia article (see articleImages), skipping
// the one already used as the avatar so a profile is not the same photo twice.
async function matchBanner(canonical, avatarFile) {
    if (!canonical) return null;                 // no article => nothing on-topic to choose from
    const titles = await articleImages(canonical);
    for (const title of titles) {
        if (avatarFile && title === avatarFile) continue;
        if (/signature|logo|coat of arms|map|chart|diagram|album cover/i.test(title)) continue;
        const hit = await fileIfFree('commons.wikimedia.org', title, 1200);
        await sleep(POLITE_DELAY_MS);
        if (!hit) continue;
        if (!hit.width || !hit.height) continue;
        if (hit.width / hit.height < 1.3) continue;   // want landscape for a banner
        if (hit.width < 800) continue;
        return hit;
    }
    return null;
}

// Deterministic real photograph (Unsplash licence) for personas with no free-licensed match.
async function fallbackPhoto(seed, w, h) {
    const res = await fetch(`https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`,
        { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`fallback ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('fallback not a JPEG');
    return { buf, licence: 'unsplash', licenceName: 'Unsplash License', artist: 'Lorem Picsum / Unsplash', source: 'https://picsum.photos', file: null, matched: false };
}

async function download(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error('image too small / not an image');
    return buf;
}

function extOf(url, fallback = '.jpg') {
    const m = String(url).toLowerCase().match(/\.(jpe?g|png|webp|gif)(?:$|\?)/);
    return m ? `.${m[1].replace('jpeg', 'jpg')}` : fallback;
}
const mimeOf = (ext) => ({ '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'image/jpeg');

async function main() {
    if (!CONTAINER) {
        console.error('[reseed] AZURE_SOCIAL_POSTS_CONTAINER is not set — refusing to guess a container.');
        process.exitCode = 1;
        return;
    }
    console.log(`[reseed] container: ${CONTAINER}  |  mode: ${APPLY ? 'COMMIT' : 'DRY RUN'}`);

    const dummies = await prisma.user.findMany({
        where: { email: { endsWith: DUMMY_EMAIL_SUFFIX } },
        select: { user_id: true },
    });
    if (!dummies.length) { console.log('[reseed] no demo accounts found — nothing to do.'); return; }
    const ids = dummies.map((u) => u.user_id);
    console.log(`[reseed] ${ids.length} demo account(s) matched ${DUMMY_EMAIL_SUFFIX}`);

    const replaceable = (f) => [{ [f]: null }, { [f]: { contains: SEED_PREFIX } }];
    const where = {
        user_id: { in: ids },
        OR: AVATARS_ONLY ? replaceable('profile_pic_url') : [...replaceable('profile_pic_url'), ...replaceable('banner_url')],
    };
    const rows = await prisma.social_profile.findMany({
        where,
        select: { profile_id: true, handle: true, display_name: true, profile_pic_url: true, banner_url: true },
        orderBy: { profile_id: 'asc' },
        ...(LIMIT ? { take: LIMIT } : {}),
    });
    console.log(`[reseed] ${rows.length} demo profile(s) to (re)media.\n`);
    if (!rows.length) return;

    const attributions = [];
    const stats = { avatarMatched: 0, avatarFallback: 0, bannerMatched: 0, bannerFallback: 0, failed: 0, attributionRequired: 0 };

    for (const r of rows) {
        const name = searchNameFor(r.display_name, r.handle);
        const canonical = await canonicalTitle(name);
        await sleep(POLITE_DELAY_MS);
        const data = {};
        try {
            // ---- avatar ----
            const hit = await matchAvatar(name);
            await sleep(POLITE_DELAY_MS);
            let media;
            if (hit) { media = { ...hit, buf: APPLY ? await download(hit.url) : null, matched: true }; stats.avatarMatched++; }
            else if (APPLY) { media = await fallbackPhoto(r.handle, 512, 512); stats.avatarFallback++; }
            else { media = { ...(await Promise.resolve({ licence: 'unsplash', licenceName: 'Unsplash License', artist: 'Lorem Picsum', source: 'https://picsum.photos', file: null })), matched: false }; stats.avatarFallback++; }

            console.log(`  #${r.profile_id} @${r.handle} — "${name}"${canonical && canonical !== name ? ` -> ${canonical}` : ''}`);
            console.log(`      avatar: ${media.matched ? `MATCHED ${media.file} [${media.licenceName}]` : 'no free-licensed match → fallback photo'}`);
            if (media.matched && NEEDS_ATTRIBUTION.test(media.licence)) stats.attributionRequired++;

            if (APPLY) {
                const ext = media.matched ? extOf(media.url) : '.jpg';
                data.profile_pic_url = await uploadPublicBlob(CONTAINER, `${SEED_PREFIX}avatar-${r.profile_id}${ext}`, media.buf, mimeOf(ext));
            }
            attributions.push({ profile_id: r.profile_id, handle: r.handle, kind: 'avatar', matched: media.matched, licence: media.licenceName, artist: media.artist, source: media.source });

            // ---- banner ----
            if (!AVATARS_ONLY) {
                const bhit = await matchBanner(canonical, hit?.file);
                await sleep(POLITE_DELAY_MS);
                let bmedia;
                if (bhit) { bmedia = { ...bhit, buf: APPLY ? await download(bhit.url) : null, matched: true }; stats.bannerMatched++; }
                else if (APPLY) { bmedia = await fallbackPhoto(`${r.handle}-banner`, 1200, 400); stats.bannerFallback++; }
                else { bmedia = { licence: 'unsplash', licenceName: 'Unsplash License', artist: 'Lorem Picsum', source: 'https://picsum.photos', file: null, matched: false }; stats.bannerFallback++; }

                console.log(`      banner: ${bmedia.matched ? `MATCHED ${bmedia.file} [${bmedia.licenceName}]` : 'no free-licensed match → fallback photo'}`);
                if (bmedia.matched && NEEDS_ATTRIBUTION.test(bmedia.licence)) stats.attributionRequired++;

                if (APPLY) {
                    const bext = bmedia.matched ? extOf(bmedia.url) : '.jpg';
                    data.banner_url = await uploadPublicBlob(CONTAINER, `${SEED_PREFIX}banner-${r.profile_id}${bext}`, bmedia.buf, mimeOf(bext));
                }
                attributions.push({ profile_id: r.profile_id, handle: r.handle, kind: 'banner', matched: bmedia.matched, licence: bmedia.licenceName, artist: bmedia.artist, source: bmedia.source });
            }

            if (APPLY && Object.keys(data).length) {
                await prisma.social_profile.update({ where: { profile_id: r.profile_id }, data });
            }
        } catch (err) {
            stats.failed++;
            console.error(`  #${r.profile_id} @${r.handle}: ${err.message}`);
        }
    }

    const manifest = path.join(process.cwd(), 'scripts', 'seed-avatar-attributions.json');
    if (APPLY) {
        fs.writeFileSync(manifest, JSON.stringify(attributions, null, 2));
        console.log(`\n[reseed] attribution manifest written: ${manifest}`);
    }
    console.log(`\n[reseed] avatars: ${stats.avatarMatched} matched / ${stats.avatarFallback} fallback`);
    console.log(`[reseed] banners: ${stats.bannerMatched} matched / ${stats.bannerFallback} fallback`);
    console.log(`[reseed] failed: ${stats.failed}`);
    if (stats.attributionRequired) {
        console.log(`\n[reseed] ⚠️  ${stats.attributionRequired} image(s) are CC BY / CC BY-SA — FREE TO USE **WITH ATTRIBUTION**.`);
        console.log(`[reseed]     Credits are in the manifest and must be surfaced somewhere user-visible`);
        console.log(`[reseed]     (a /credits page) for these to be licence-compliant.`);
    }
    if (!APPLY) console.log('\n[reseed] DRY RUN — pass --apply to download, upload and attach.');
}

// Exported so the matching + licence gating can be exercised without opening a DB connection.
export { searchNameFor, matchAvatar, matchBanner, fileIfFree, isFreeLicence, NEEDS_ATTRIBUTION, canonicalTitle, articleImages };

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    main()
        .catch((err) => { console.error('[reseed] fatal:', err); process.exitCode = 1; })
        .finally(() => prisma.$disconnect());
}
