import prisma from '../utils/prisma-client.js';
import { viewerCounts } from './live-presence.js';
import {
    catalogMetaForName,
    defaultIconForCategory,
    LIVE_CATEGORY_CATALOG,
} from '../data/live-category-catalog.js';

function mapCategoryRow(cat, stats, followerCount) {
    const meta = catalogMetaForName(cat.category_name);
    const icon = cat.icon_url || defaultIconForCategory(cat.category_name);
    return {
        category_id: cat.category_id,
        id: String(cat.category_id),
        name: cat.category_name,
        icon_url: icon,
        thumb: icon,
        tags: meta?.tags ?? [],
        description: meta?.description ?? '',
        live_viewers: stats.viewers,
        viewers: stats.viewers,
        live_channels: stats.channels,
        followers: followerCount,
        featured: meta?.featured ?? false,
        isNew: false,
    };
}

/** Active categories enriched with live viewer/channel aggregates. */
export async function getBrowseCategories({ featuredOnly = false, io = null } = {}) {
    const categories = await prisma.live_stream_category.findMany({
        where: { is_active: true },
        orderBy: { category_name: 'asc' },
    });

    const liveSessions = await prisma.live_session.findMany({
        where: { status: 'LIVE', streamer: { is_active: true } },
        select: {
            session_id: true,
            streamer: { select: { category_id: true, user_id: true } },
        },
    });

    // One batched lookup instead of N sequential SCARDs. These aggregates read 0 on a
    // Redis-less prod before live-presence.js existed, which made every category on the
    // browse page show "0 viewers" no matter how busy it was.
    const counts = await viewerCounts(io, liveSessions.map((s) => ({
        session_id: s.session_id,
        hostUserId: s.streamer?.user_id ?? null,
    })));

    const statsByCategory = new Map();
    for (const s of liveSessions) {
        const cid = s.streamer?.category_id;
        if (!cid) continue;
        const vc = Number(counts.get(s.session_id)) || 0;
        const prev = statsByCategory.get(cid) || { channels: 0, viewers: 0 };
        statsByCategory.set(cid, {
            channels: prev.channels + 1,
            viewers: prev.viewers + vc,
        });
    }

    const streamerCounts = await prisma.live_streamer_profile.groupBy({
        by: ['category_id'],
        // category_id is a non-nullable column on live_streamer_profile, so `{ not: null }`
        // here throws (Prisma rejects not-null filters on required fields) — which the route
        // swallows into an empty list. All rows have a category_id, so just filter is_active.
        where: { is_active: true },
        _count: { streamer_id: true },
    });
    const followersByCat = new Map(
        streamerCounts.map((r) => [r.category_id, r._count.streamer_id]),
    );

    let rows = categories.map((cat) => {
        const stats = statsByCategory.get(cat.category_id) || { channels: 0, viewers: 0 };
        return mapCategoryRow(cat, stats, followersByCat.get(cat.category_id) ?? 0);
    });

    if (featuredOnly) {
        rows = rows.filter((r) => r.featured);
    }

    rows.sort((a, b) => {
        if (a.featured !== b.featured) return a.featured ? -1 : 1;
        return (b.live_viewers ?? 0) - (a.live_viewers ?? 0) || a.name.localeCompare(b.name);
    });

    return rows;
}

/** Top sidebar picks — featured catalog games first, then by live viewers. */
export async function getRecommendedCategories(limit = 5, io = null) {
    const all = await getBrowseCategories({ io });
    const featured = all.filter((c) => c.featured);
    const picked = featured.length >= limit
        ? featured.slice(0, limit)
        : [...featured, ...all.filter((c) => !c.featured)].slice(0, limit);
    return picked;
}

export { LIVE_CATEGORY_CATALOG };
