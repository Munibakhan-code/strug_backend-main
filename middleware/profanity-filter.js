// middleware/profanity-filter.js

// Strict regex patterns for production-grade spam, scam and malicious keywords
const SCAM_PATTERNS = [
    /spamlink\.com/i,
    /scam-domain\.net/i,
    /free-crypto-giveaway/i,
    /get-rich-quick/i,
    /double-your-btc/i,
    /phishing-scam-word/i,
    /bit\.ly\/[a-z0-9]+/i,
    /telegram\.me\/joinchat/i,
    /whatsapp\.com\/channel/i,
];

// Built-in placeholder list kept for backward-compatible tests; real ops should set
// PROFANITY_BLOCKLIST=comma,separated,words in env.
const DEFAULT_BANNED_WORDS = [
    'abuseword1',
    'offensiveword2',
    'scamlink',
    'maliciousphrase3',
];

function loadBannedWords() {
    const fromEnv = String(process.env.PROFANITY_BLOCKLIST || '')
        .split(',')
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean);
    return [...new Set([...DEFAULT_BANNED_WORDS, ...fromEnv])];
}

export function profanityFilter(req, res, next) {
    try {
        // Extract all text fields that require sanitization from req.body safely
        const content = req.body?.content || req.body?.caption_text || req.body?.text || '';
        const normalizedContent = String(content).toLowerCase().trim();

        if (!normalizedContent) {
            return next();
        }

        // 1. Scan for malicious URL and Phishing patterns using Regex
        const hasScamPattern = SCAM_PATTERNS.some(pattern => pattern.test(normalizedContent));

        // 2. Scan for individual blacklisted keywords (env-extendable)
        const banned = loadBannedWords();
        const hasBannedWord = banned.some(word => normalizedContent.includes(word.toLowerCase()));

        if (hasScamPattern || hasBannedWord) {
            return res.status(400).json({
                successful: false,
                message: 'Content violates community standards. Please remove inappropriate links or language.'
            });
        }

        next();
    } catch (err) {
        console.error('[profanityFilter] Execution error:', err.message);
        // Fail-open strategy to prevent complete block on internal processing errors
        next();
    }
}
