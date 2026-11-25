/**
 * Upsert popular live_stream_category rows with Twitch box-art icon URLs.
 * Idempotent — safe to run in every environment (taxonomy/reference data).
 * Run standalone: node scripts/seed-live-categories.js
 * Or call seedLiveCategories(prismaClient) from the main seed.
 */
import prisma from '../utils/prisma-client.js';
import { LIVE_CATEGORY_CATALOG, twitchBoxArt } from '../data/live-category-catalog.js';

export async function seedLiveCategories(client = prisma) {
    for (const entry of LIVE_CATEGORY_CATALOG) {
        const icon_url = entry.icon_url ?? twitchBoxArt(entry.name);
        await client.live_stream_category.upsert({
            where: { category_name: entry.name },
            update: { icon_url, is_active: true },
            create: { category_name: entry.name, icon_url, is_active: true },
        });
    }
    console.log(`Seeded ${LIVE_CATEGORY_CATALOG.length} live categories.`);
    return LIVE_CATEGORY_CATALOG.length;
}

// Standalone entrypoint: only runs when invoked directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
    seedLiveCategories()
        .catch((e) => {
            console.error(e);
            process.exit(1);
        })
        .finally(() => prisma.$disconnect());
}
