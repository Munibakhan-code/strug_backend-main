// Canonical video categories — the single source of truth shared by the upload path,
// the auto-classifier, and the backfill script.
//
// These MUST stay in sync with the frontend filter chips in
// strug-final-frontend/src/pages/Videos.jsx (VIDEO_CATEGORY_DEFS[].match) and the upload
// dropdown. The chips filter by EXACT string match, so any drift here silently empties a
// category. "General" is the catch-all and is NOT a browsable chip: an uncategorized video
// is stored as NULL (auto-detect pending, or genuinely miscellaneous) and the read layer
// coalesces NULL → "General" for display.
export const VIDEO_CATEGORIES = [
    'Music', 'Gaming', 'Sports', 'News', 'Entertainment', 'Education', 'Tech', 'Comedy', 'Travel',
];

// Lower-cased lookup → canonical capitalization, so "gaming"/"GAMING" both resolve.
const CANONICAL_BY_LOWER = new Map(VIDEO_CATEGORIES.map((c) => [c.toLowerCase(), c]));

/**
 * Map a raw upload-form category value to what we persist.
 *   - a known specific category (any case) → its canonical form (explicit creator choice; wins)
 *   - 'auto' / 'general' / '' / undefined / anything unrecognized → null
 *     (null = "let the content-based classifier decide", which is the new default)
 */
export function normalizeUploadCategory(raw) {
    if (raw == null) return null;
    const hit = CANONICAL_BY_LOWER.get(String(raw).trim().toLowerCase());
    return hit ?? null;
}

/**
 * Coerce any model output to a valid category or null. Accepts a loose string (the model may
 * answer "Gaming." or "Category: Gaming") and extracts the first canonical category it contains.
 * Returns null when nothing matches (treated as "uncertain → General" by callers).
 */
export function coerceCategory(text) {
    if (!text) return null;
    const lower = String(text).toLowerCase();
    for (const c of VIDEO_CATEGORIES) {
        // Word-boundary match so "newsroom" doesn't match "news" by accident is overkill here,
        // but a simple includes is fine given the tiny, distinct label set.
        if (lower.includes(c.toLowerCase())) return c;
    }
    return null;
}

// ── Heuristic (no-LLM) classifier ────────────────────────────────────────────────────────────
// Distinctive keyword/phrase signals per category, each weighted by how strongly it implies that
// category. Deliberately conservative: signals are specific phrases ("official music video",
// "gameplay") rather than generic words, so a confident hit is rarely wrong. Ambiguous titles
// (no clear winner) return confident=false so a layered classifier can defer to the LLM.
const HEURISTIC_SIGNALS = {
    Music: [['official music video', 3], ['music video', 3], ['official audio', 3], ['lyric video', 3], ['lyrics', 2], ['vevo', 3], [' ft. ', 2], [' feat.', 2], ['remix', 2], ['acoustic', 2], [' album', 2], ['concert', 2], ['soundtrack', 2], ['instrumental', 2], ['official video', 2], ['live performance', 2]],
    Gaming: [['gameplay', 3], ['gaming', 3], ['playthrough', 3], ['walkthrough', 2], ['speedrun', 3], ['speed run', 2], ["let's play", 3], ['lets play', 3], ['no commentary', 2], ['boss fight', 2], ['minecraft', 3], ['fortnite', 3], ['roblox', 3], ['valorant', 3], ['league of legends', 3], ['call of duty', 2], ['esports', 3], ['playstation', 2], ['nintendo', 2], [' xbox', 2]],
    Sports: [['highlights', 2], [' nba', 3], [' nfl', 3], [' mlb', 3], [' nhl', 3], ['fifa', 2], [' ufc', 3], [' wwe', 3], ['premier league', 3], ['champions league', 3], ['soccer', 2], ['basketball', 2], ['baseball', 2], ['boxing', 2], [' mma', 2], ['workout', 2], ['fitness', 2], ['olympics', 3], ['formula 1', 3], ['world cup', 3], ['cricket', 3], ['touchdown', 2]],
    News: [['breaking news', 3], ['headlines', 3], ['press conference', 3], ['election', 3], [' news', 2], ['politics', 2], ['government', 2], ['live coverage', 2], ['the economy', 2]],
    Entertainment: [['reaction', 2], ['prank', 3], ['celebrity', 2], ['official trailer', 3], ['movie trailer', 3], ['behind the scenes', 2], ['red carpet', 3], ['story time', 2], ['storytime', 2], ['day in my life', 2], ['day in the life', 2], [' vlog', 2], ['challenge', 2]],
    Education: [['how to', 2], ['tutorial', 3], ['explained', 3], ['crash course', 3], ['documentary', 2], ['lecture', 2], ['educational', 3], ['step by step', 2], ['ted talk', 3], ['history of', 2], ['the science of', 2]],
    Tech: [['tech review', 3], ['unboxing', 2], ['iphone', 2], ['smartphone', 3], ['pc build', 3], ['coding', 3], ['programming', 3], ['gadget', 3], ['macbook', 2], ['samsung galaxy', 3], ['artificial intelligence', 2], ['cryptocurrency', 2], [' bitcoin', 2], ['app review', 2]],
    Comedy: [['comedy', 3], ['funny', 2], ['hilarious', 2], [' skit', 3], ['parody', 3], ['stand up', 3], ['standup', 3], ['try not to laugh', 3], ['bloopers', 2], ['comedian', 3]],
    Travel: [['travel vlog', 3], ['travel', 2], ['road trip', 3], ['backpacking', 3], ['tour of', 2], ['things to do in', 3], ['wanderlust', 3], ['city tour', 3], ['national park', 2], ['itinerary', 3]],
};

/**
 * Keyword-based classification from the TITLE only. No external calls.
 *
 * Why title-only: descriptions (especially on bulk-imported catalogues) are full of boilerplate
 * — "subscribe for daily news", sponsor blurbs, hashtags, links — that the substring matcher
 * happily counts, which mislabels videos (a vlog whose description says "breaking news" became
 * News; a challenge video became Sports off its football-heavy description). Titles are the clean,
 * high-signal field. When the LLM layer is enabled it reads the description (and the thumbnail);
 * the no-LLM heuristic deliberately does not.
 *
 * @param {string} title
 * @param {string} [_description] accepted for call-site symmetry; intentionally ignored (see above).
 * @returns {{ category: string|null, confident: boolean, score: number }}
 *   confident=true  → a DISTINCTIVE title signal (a weight-3 phrase) that clearly leads — safe to
 *                     use as-is.
 *   confident=false → only weak/generic hits (e.g. "iphone", "how to") or a near-tie. `category`
 *                     is a best-guess a caller may keep, drop to General, or hand to the LLM.
 */
export function classifyByHeuristic(title, _description) {
    const text = ` ${String(title || '')} `.toLowerCase();
    let best = null, bestScore = 0, secondScore = 0, bestHasStrong = false;
    for (const [category, signals] of Object.entries(HEURISTIC_SIGNALS)) {
        let score = 0, hasStrong = false;
        for (const [phrase, weight] of signals) {
            if (text.includes(phrase)) { score += weight; if (weight >= 3) hasStrong = true; }
        }
        if (score > bestScore) { secondScore = bestScore; bestScore = score; best = category; bestHasStrong = hasStrong; }
        else if (score > secondScore) { secondScore = score; }
    }
    // Confident ONLY on a distinctive (weight-3) title phrase that clearly leads (margin ≥2).
    // Generic single hits don't qualify: better to leave a video General (safe) than mislabel it.
    const confident = bestHasStrong && bestScore - secondScore >= 2;
    return { category: bestScore > 0 ? best : null, confident, score: bestScore };
}
