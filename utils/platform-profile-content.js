/**
 * Curated profile-sidebar content served by GET /platform/profile-content.
 * Source of truth lives on the server so the SPA is not a marketing mock list.
 */

export const PROFILE_WHATS_NEW = [
  { text: 'Friend Journal: highlights, bucket lists, and time capsules', date: 'Jun 2025' },
  { text: 'Community polls, pinned posts & topic threads', date: 'Jun 2025' },
  { text: 'Live channel subscriptions at $4.99/mo', date: 'Jun 2025' },
];

export const PROFILE_PLATFORM_NEWS = [
  { text: 'Profile sidebar widgets you can customize.', date: 'Today' },
  { text: 'Friend Journal: highlights, bucket lists, and time capsules.', date: 'Jun 29' },
  { text: 'On-Demand Work: book skilled workers when you need them.', date: 'Jun 27' },
];

export const PROFILE_QUOTES = [
  { text: 'The best memories are the ones you never planned.', author: 'Unknown' },
  { text: 'Do something today your future self will thank you for.', author: 'Sean Patrick Flanery' },
  { text: 'Creativity is intelligence having fun.', author: 'Albert Einstein' },
  { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
  { text: 'You are never too old to set another goal or dream a new dream.', author: 'C.S. Lewis' },
  { text: 'Dream big. Start small. Act now.', author: 'Robin Sharma' },
  { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
];

export const PROFILE_FEATURES_SPOTLIGHT = [
  { name: 'Friend Journal', desc: 'Create shared highlights, bucket lists & time capsules with your friends.', nav: 'social', accent: '#ec4899' },
  { name: 'Creator Studio', desc: 'Go live, upload videos and earn from subscriber tiers.', nav: 'live', accent: '#ef4444' },
  { name: 'Community', desc: 'Join polls, pin posts and connect on local threads.', nav: 'community', accent: '#2563eb' },
  { name: 'Strug Shop', desc: 'Shop food, fashion and electronics in one checkout.', nav: 'shop', accent: '#f59e0b' },
  { name: 'On-Demand Work', desc: 'Book skilled workers for one-off tasks.', nav: 'ondemand', accent: '#10b981' },
  { name: 'Rideshare', desc: 'Book a ride with our auto-matched driver system.', nav: 'rideshare', accent: '#8b5cf6' },
];

export const PROFILE_SPIN_ITEMS = [
  'Movie Night',
  'Game Night',
  'Go Outside',
  'Call a Friend',
  'Cook Something',
  'Read a Book',
];

export const PROFILE_SPIN_COLORS = ['#8b5cf6', '#2563eb', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];

/** Bump id when the question/options change so prior votes do not mix. */
export const PROFILE_POLL = {
  id: 'platform_v1',
  question: 'Which Strug feature do you use most?',
  options: ['Videos & Live', 'Shopping & Food'],
};

export const PROFILE_DAILY_CHALLENGE = {
  text: 'Share your profile link with a friend today.',
  cta: 'Copy & Share Link',
};

export const PROFILE_DAILY_GOALS = [
  'Reply to a friend',
  'Upload something',
  'Finish your Journal',
];

/** Curated book picks when the Books catalog is empty. */
export const PROFILE_CURATED_BOOKS = [
  { id: 'curated:atomic-habits', title: 'Atomic Habits', author: 'James Clear', summary: 'Tiny 1% improvements compound into remarkable results. Build systems, not goals.', color: '#f59e0b' },
  { id: 'curated:deep-work', title: 'Deep Work', author: 'Cal Newport', summary: 'Focused work on hard things is your most valuable skill in a distracted world.', color: '#2563eb' },
  { id: 'curated:the-alchemist', title: 'The Alchemist', author: 'Paulo Coelho', summary: 'Follow your personal legend. The universe conspires to help those who dare.', color: '#10b981' },
  { id: 'curated:ikigai', title: 'Ikigai', author: 'Héctor García', summary: 'Find where passion, skill and value intersect for a life of purpose.', color: '#8b5cf6' },
  { id: 'curated:power-of-now', title: 'The Power of Now', author: 'Eckhart Tolle', summary: 'Living fully in the present moment is the path to lasting peace.', color: '#ec4899' },
  { id: 'curated:think-grow-rich', title: 'Think & Grow Rich', author: 'Napoleon Hill', summary: 'Desire, faith and persistence are the master keys to personal achievement.', color: '#f97316' },
  { id: 'curated:mans-search', title: "Man's Search for Meaning", author: 'Viktor Frankl', summary: 'Meaning, not pleasure, is the primary motivational force in human life.', color: '#06b6d4' },
];

const BOOK_COLORS = ['#f59e0b', '#2563eb', '#10b981', '#8b5cf6', '#ec4899', '#f97316', '#06b6d4'];

export function dayOfYearUTC(now = new Date()) {
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const diff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - start;
  return Math.floor(diff / 86400000);
}

export function pickByDay(list, now = new Date()) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[dayOfYearUTC(now) % list.length];
}

export function buildProfileContentPayload(now = new Date()) {
  const quote = pickByDay(PROFILE_QUOTES, now);
  const feature = PROFILE_FEATURES_SPOTLIGHT[
    Math.floor(dayOfYearUTC(now) / 2) % PROFILE_FEATURES_SPOTLIGHT.length
  ];
  return {
    as_of: now.toISOString(),
    whats_new: PROFILE_WHATS_NEW,
    platform_news: PROFILE_PLATFORM_NEWS,
    quotes: PROFILE_QUOTES,
    quote_of_day: quote,
    feature_spotlight: feature,
    features_spotlight: PROFILE_FEATURES_SPOTLIGHT,
    spin_items: PROFILE_SPIN_ITEMS,
    spin_colors: PROFILE_SPIN_COLORS,
    poll: PROFILE_POLL,
    daily_challenge: PROFILE_DAILY_CHALLENGE,
    daily_goals: PROFILE_DAILY_GOALS,
  };
}

/**
 * Map a catalog dg_content row (or curated fallback) into the profile book card shape.
 */
export function mapCatalogBook(row, index = 0) {
  if (!row) return null;
  return {
    id: String(row.content_id),
    source: 'catalog',
    title: row.content_title || 'Untitled',
    author: row.author || 'Unknown',
    summary: String(row.content_description || '').slice(0, 180) || 'A title from the Strug Books catalog.',
    color: BOOK_COLORS[index % BOOK_COLORS.length],
    cover_url: row.cover_img_url || null,
    savable: true,
  };
}

export function mapCuratedBook(book) {
  if (!book) return null;
  return {
    ...book,
    source: 'curated',
    cover_url: null,
    savable: true,
  };
}

/** Open-Meteo weather_code → short label. */
export function weatherCodeLabel(code) {
  const c = Number(code);
  if (Number.isNaN(c)) return 'Unknown';
  if (c === 0) return 'Clear';
  if (c <= 3) return 'Partly cloudy';
  if (c <= 48) return 'Foggy';
  if (c <= 57) return 'Drizzle';
  if (c <= 67) return 'Rain';
  if (c <= 77) return 'Snow';
  if (c <= 82) return 'Showers';
  if (c <= 86) return 'Snow showers';
  if (c <= 99) return 'Thunderstorm';
  return 'Unknown';
}

export const DEFAULT_WEATHER_LOCATION = {
  city: 'Toronto, ON',
  latitude: 43.6532,
  longitude: -79.3832,
};
