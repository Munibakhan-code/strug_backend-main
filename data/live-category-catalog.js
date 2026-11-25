/** Curated live browse metadata + box-art URLs for popular categories. */

export function twitchBoxArt(categoryName, w = 285, h = 380) {
    return `https://static-cdn.jtvnw.net/ttv-boxart/${encodeURIComponent(categoryName)}-${w}x${h}.jpg`;
}

/** @type {Array<{ name: string, tags: string[], description: string, icon_url?: string, featured?: boolean }>} */
export const LIVE_CATEGORY_CATALOG = [
    {
        name: 'Grand Theft Auto V',
        tags: ['FPS', 'Shooter'],
        description: 'Open-world action in Los Santos — roleplay servers, heists, and freeroam dominate the live scene.',
        featured: true,
    },
    {
        name: 'League of Legends',
        tags: ['MOBA', 'Action'],
        description: '5v5 MOBA where champions clash to destroy the enemy Nexus. Ranked ladders and esports keep the community thriving.',
        featured: true,
    },
    {
        name: 'VALORANT',
        tags: ['FPS', 'Shooter'],
        description: '5v5 character-based tactical shooter. Precise aim, unique agents, and ranked competitive play.',
        featured: true,
    },
    {
        name: 'Minecraft',
        tags: ['Simulation'],
        description: 'Sandbox survival and creativity — builds, hardcore worlds, modded adventures, and community events.',
        featured: true,
    },
    {
        name: 'Dota 2',
        tags: ['MOBA', 'Action'],
        description: 'Deep competitive MOBA with a legendary esports scene. Two teams of five heroes battle for map control.',
        featured: true,
    },
    {
        name: 'Counter-Strike',
        tags: ['FPS', 'Shooter', 'Action'],
        description: 'Team-based tactical FPS. Economy rounds, precise gunplay, and esports at the highest level.',
        featured: true,
    },
    {
        name: 'Call of Duty: Warzone',
        tags: ['FPS', 'Shooter'],
        description: 'Free-to-play battle royale. Drop in, loot up, and fight to be the last squad standing.',
    },
    {
        name: 'Just Chatting',
        tags: ['IRL'],
        description: 'Hang out, react, and talk with your community — no game required.',
    },
    {
        name: 'Fortnite',
        tags: ['Shooter', 'Action'],
        description: 'Battle royale and creative modes with building mechanics and seasonal updates.',
    },
    {
        name: 'Gaming',
        tags: ['Gaming'],
        description: 'General gaming streams across all titles and platforms.',
    },
    {
        name: 'Music',
        tags: ['Music'],
        description: 'Live music, DJ sets, production, and listening parties.',
    },
    {
        name: 'Art & Creative',
        tags: ['Creative'],
        description: 'Digital art, illustration, design, and creative process streams.',
    },
    {
        name: 'Education',
        tags: ['Education'],
        description: 'Tutorials, lectures, and learn-with-me sessions.',
    },
    {
        name: 'Sports',
        tags: ['Sports'],
        description: 'Sports talk, watch-alongs, and athletic content.',
    },
    {
        name: 'Software Development',
        tags: ['Technology'],
        description: 'Coding, debugging, and building software live.',
    },
];

export function catalogMetaForName(name) {
    if (!name) return null;
    const key = String(name).trim().toLowerCase();
    return LIVE_CATEGORY_CATALOG.find((c) => c.name.toLowerCase() === key) ?? null;
}

export function defaultIconForCategory(name) {
    const meta = catalogMetaForName(name);
    if (meta?.icon_url) return meta.icon_url;
    if (name) return twitchBoxArt(name);
    return twitchBoxArt('Gaming');
}
