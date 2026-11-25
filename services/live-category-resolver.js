import prisma from '../utils/prisma-client.js';
import { catalogMetaForName, defaultIconForCategory } from '../data/live-category-catalog.js';

/** Normalize display name — trim and collapse whitespace. */
export function normalizeCategoryName(raw) {
    return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Find existing category (case-insensitive) or create a new active row. */
export async function resolveLiveCategoryId({ category_id, category_name }, tx = prisma) {
    if (category_id != null) {
        const id = Number(category_id);
        if (!Number.isInteger(id) || id <= 0) return null;
        const existing = await tx.live_stream_category.findUnique({ where: { category_id: id } });
        return existing?.is_active ? id : null;
    }

    const name = normalizeCategoryName(category_name);
    if (!name) return null;

    let cat = await tx.live_stream_category.findFirst({
        where: { category_name: { equals: name, mode: 'insensitive' } },
    });

    if (!cat) {
        const meta = catalogMetaForName(name);
        cat = await tx.live_stream_category.create({
            data: {
                category_name: meta?.name ?? name,
                icon_url: defaultIconForCategory(meta?.name ?? name),
                is_active: true,
            },
        });
    }

    return cat.category_id;
}
