import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage } from '@langchain/core/messages';
import { VIDEO_CATEGORIES, coerceCategory, classifyByHeuristic } from './video-categories.js';

// Content-based video categorisation. Gemini is multimodal, so we feed it the actual
// thumbnail frame (the video's content) plus the title/description and ask for exactly one
// of the canonical categories. Metadata alone (title/description) is a strong signal for
// these broad buckets; the thumbnail frame grounds it in what the video actually shows.
//
// This is deliberately a SEPARATE, low-temperature model instance from the chat assistant
// (ai/nodes/*) — single-label classification wants determinism and a tiny output budget.

let model = null;
function getModel() {
    if (!model) {
        model = new ChatGoogleGenerativeAI({
            apiKey: process.env.GOOGLE_API_KEY,
            model: process.env.MODEL_NAME || 'gemini-flash-lite-latest',
            temperature: 0,
            maxOutputTokens: 16, // one label; nothing more
        });
    }
    return model;
}

// Fetch the thumbnail and inline it as a data URI. Best-effort: a missing/unreadable
// thumbnail just degrades to a text-only (title + description) classification rather than
// failing the whole call. Bounded so a slow blob host can't hang the cron.
async function fetchImagePart(thumbnailUrl) {
    if (!thumbnailUrl) return null;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(thumbnailUrl, { signal: controller.signal }).finally(() => clearTimeout(timer));
        if (!resp.ok) return null;
        const type = resp.headers.get('content-type') || 'image/jpeg';
        if (!type.startsWith('image/')) return null;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length === 0 || buf.length > 6 * 1024 * 1024) return null; // skip absurd payloads
        return { type: 'image_url', image_url: `data:${type};base64,${buf.toString('base64')}` };
    } catch {
        return null;
    }
}

function buildPrompt({ title, description }) {
    const list = VIDEO_CATEGORIES.join(', ');
    return [
        `You are categorising a video for a video platform's browse-by-category filter.`,
        `Choose the SINGLE best-fitting category from this exact list: ${list}.`,
        ``,
        `Title: ${title || '(none)'}`,
        `Description: ${(description || '(none)').slice(0, 1000)}`,
        ``,
        `Base your choice on the title, description, and the thumbnail image if provided.`,
        `Respond with ONLY the category word — nothing else. If none clearly fits, respond with: None.`,
    ].join('\n');
}

// One Gemini classification pass (multimodal: thumbnail + title/description). Returns the
// coerced category, or throws on a transient model error so the layered caller can decide.
async function classifyWithGemini({ title, description, thumbnailUrl }) {
    const text = buildPrompt({ title, description });
    const imagePart = await fetchImagePart(thumbnailUrl);
    if (imagePart) {
        try {
            const response = await getModel().invoke([new HumanMessage({ content: [{ type: 'text', text }, imagePart] })]);
            return coerceCategory(response?.content?.toString?.() ?? '');
        } catch (err) {
            // The flash-lite tier we run rejects image input ("This model does not support images").
            // Rather than fail the whole classification — which trips the circuit breaker and settles
            // EVERY ambiguous video as General — fall back to a text-only pass (title + description),
            // which the same model handles. Re-throw anything that isn't an image-support error.
            if (!/image/i.test(err?.message || '')) throw err;
        }
    }
    const response = await getModel().invoke([new HumanMessage({ content: text })]);
    return coerceCategory(response?.content?.toString?.() ?? '');
}

/**
 * Classify one video into a canonical category — LAYERED:
 *   1. A no-LLM keyword heuristic (title + description). If it's confident, we use it as-is —
 *      free, deterministic, and works with no external dependency. This is the default path.
 *   2. Only for ambiguous/weak heuristic results, and only when GOOGLE_API_KEY is configured,
 *      we ask Gemini (multimodal — it also sees the thumbnail frame) to break the tie.
 * So the feature works today with zero Gemini, and automatically gets sharper on hard cases the
 * moment Gemini is turned on — no code change.
 *
 * @returns {Promise<{ ok: boolean, category: string|null, source: string }>}
 *   ok=false → a Gemini call was attempted and failed transiently (retry later); category=null.
 *   ok=true, category=string → a label (from heuristic or Gemini).
 *   ok=true, category=null   → ran but nothing fit (caller should settle it as explicit "General"
 *                              so it isn't re-classified forever).
 */
// Circuit breaker for a misconfigured/unavailable Gemini. Without this, a persistently failing
// Gemini (bad model name, revoked key, exhausted quota) makes the 5-min auto-categorisation
// sweep retry the SAME ambiguous videos forever — each one burns the 30s classify timeout and
// logs an error every cycle, and the video never leaves the `category IS NULL` candidate set.
// After a run of consecutive failures we OPEN the breaker for a cooldown: while open, ambiguous
// videos take the no-LLM path and settle as "General" (so they stop being re-picked), and we
// stop calling Gemini entirely. The breaker auto-closes after the cooldown, so if Gemini was
// only transiently down it resumes on its own — already-settled videos simply won't re-loop.
const GEMINI_FAIL_THRESHOLD = 3;
const GEMINI_COOLDOWN_MS = 30 * 60 * 1000; // 30 min
let geminiConsecutiveFailures = 0;
let geminiCircuitOpenUntil = 0;

export async function classifyVideoCategory({ title, description, thumbnailUrl }) {
    const h = classifyByHeuristic(title, description);
    if (h.confident) return { ok: true, category: h.category, source: 'heuristic' };

    // Ambiguous. Without an LLM to arbitrate, a low-confidence keyword guess is more likely to
    // MISLABEL than to help (a vlog with one stray "iphone" is not Tech) — so settle as General
    // (null) rather than write the weak guess. Only when Gemini is available AND healthy do we
    // try harder; if it's unconfigured or the breaker is open, settle as General.
    const breakerOpen = Date.now() < geminiCircuitOpenUntil;
    if (!process.env.GOOGLE_API_KEY || breakerOpen) {
        return { ok: true, category: null, source: breakerOpen ? 'gemini-circuit-open' : 'heuristic-weak' };
    }
    try {
        const llmCategory = await classifyWithGemini({ title, description, thumbnailUrl });
        geminiConsecutiveFailures = 0; // a success closes the breaker
        // Prefer Gemini's answer; fall back to the weak heuristic guess only if Gemini found
        // nothing (Gemini also saw the thumbnail, so a weak hint is safer to accept here).
        return { ok: true, category: llmCategory ?? h.category, source: 'gemini' };
    } catch (err) {
        geminiConsecutiveFailures++;
        if (geminiConsecutiveFailures >= GEMINI_FAIL_THRESHOLD) {
            geminiCircuitOpenUntil = Date.now() + GEMINI_COOLDOWN_MS;
            console.error(`[classify-video-category] Gemini failed ${geminiConsecutiveFailures}x in a row — pausing Gemini for ${Math.round(GEMINI_COOLDOWN_MS / 60000)}m; ambiguous videos settle as General meanwhile. Last error: ${err.message}`);
            // Settle THIS video now too (don't leave it to loop one more sweep).
            return { ok: true, category: null, source: 'gemini-circuit-open' };
        }
        console.error('[classify-video-category] Gemini call failed:', err.message);
        // Transient model failure under threshold: ask the caller to retry on a later sweep rather than settle.
        return { ok: false, category: null, source: 'gemini-error' };
    }
}
