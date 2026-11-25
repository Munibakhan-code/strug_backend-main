// utils/bug-report-context.js
//
// Server-side gatekeeper for auto-captured reporter context.
//
// The client (BugReportModal) attaches a `client_context` blob describing what the app was
// doing when the bug was filed — the SPA page, viewport, build SHA, the last few console
// errors and the last few FAILED API calls. That is the single highest-value thing we can
// collect, because it answers the questions triage would otherwise have to ask ("which
// account? which page? does it survive a refresh? what threw?").
//
// It is also the single most dangerous thing we collect. Console text and URLs can carry
// tokens and PII. So this module is a strict ALLOW-LIST, not a filter: anything the client
// sends that isn't explicitly modelled below is dropped on the floor. In particular we never
// accept — and the client never sends — request/response BODIES or HEADERS of any kind.
//
// The result is board-only. It is never returned by GET /public or GET /mine.

// Belt-and-braces redaction. The client redacts too, but the client is not a trust boundary:
// anyone can POST /bug-reports/submit with a hand-made blob, and a future frontend change
// could start logging something new. Redact here as well, always.
const SECRET_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, // JWT
  /\bBearer\s+[\w.\-+/=]{8,}/gi,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe-style keys
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email addresses
  /\b(?:token|password|passwd|secret|api[_-]?key|auth|session)\b\s*[=:]\s*\S+/gi,
];

const REDACTED = '[redacted]';

// Query strings are where tokens hide (`?token=…&user=…` is how we auth Playwright), so URLs
// are truncated at the first '?' or '#' — we keep the path, never the params.
const MAX_STR = 300;
const MAX_CONSOLE = 5;
const MAX_API = 5;
const MAX_CONTEXT_BYTES = 8 * 1024;

export function redactSecrets(input) {
  let s = String(input ?? '');
  for (const re of SECRET_PATTERNS) s = s.replace(re, REDACTED);
  return s;
}

function cleanText(input, max = MAX_STR) {
  const s = redactSecrets(input).trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Strip query + fragment from a URL, keeping origin + path. Applied to page_url as well as to
 * every captured API path — `?token=…` must never reach the database.
 */
export function stripUrlParams(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const cut = s.search(/[?#]/);
  const clean = cut === -1 ? s : s.slice(0, cut);
  return clean.slice(0, 1000) || null;
}

const DEVICE_TYPES = new Set(['mobile', 'tablet', 'desktop']);
const CONSOLE_LEVELS = new Set(['error', 'warn', 'unhandledrejection', 'window.onerror']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function toIso(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parse + sanitise the client's `client_context` field.
 *
 * @param {string|object} raw  JSON string (multipart) or already-parsed object
 * @returns {{ context: object|null, build_sha: string|null, viewport: string|null,
 *             device_type: string|null, nav_id: string|null }}
 *          Flat scalars are hoisted onto their own columns so triage can filter/group by them;
 *          the noisy arrays stay in the JSON blob. Never throws — a malformed blob degrades to
 *          nulls rather than failing the report the user was trying to file.
 */
export function sanitizeClientContext(raw) {
  const empty = { context: null, build_sha: null, viewport: null, device_type: null, nav_id: null };
  if (!raw) return empty;

  let src = raw;
  if (typeof src === 'string') {
    try {
      src = JSON.parse(src);
    } catch {
      return empty; // garbage in → nothing stored; the report itself still lands.
    }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) return empty;

  // ── flat, queryable scalars ────────────────────────────────────────────────────────
  const build_sha = /^[0-9a-f]{7,40}$/i.test(String(src.build_sha ?? '')) ? String(src.build_sha) : null;
  const viewport = /^\d{2,5}x\d{2,5}$/.test(String(src.viewport ?? '')) ? String(src.viewport) : null;
  const device_type = DEVICE_TYPES.has(src.device_type) ? src.device_type : null;
  const nav_id = /^[a-z0-9-]{1,64}$/i.test(String(src.nav_id ?? '')) ? String(src.nav_id) : null;

  // ── console ring buffer: {level, message, at} only ─────────────────────────────────
  const consoleEntries = Array.isArray(src.console)
    ? src.console
        .slice(-MAX_CONSOLE)
        .map((e) => {
          const message = cleanText(e?.message);
          if (!message) return null;
          return {
            level: CONSOLE_LEVELS.has(e?.level) ? e.level : 'error',
            message,
            at: toIso(e?.at),
          };
        })
        .filter(Boolean)
    : [];

  // ── failed API calls: method + PATH + status only. No bodies. No headers. ──────────
  const apiEntries = Array.isArray(src.api)
    ? src.api
        .slice(-MAX_API)
        .map((e) => {
          const path = stripUrlParams(e?.path);
          if (!path) return null;
          const status = Number(e?.status);
          const method = String(e?.method ?? '').toUpperCase();
          return {
            method: HTTP_METHODS.has(method) ? method : 'GET',
            path: path.slice(0, 200),
            // 0 = the request never got a response (network error / timeout) — worth keeping.
            status: Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0,
            at: toIso(e?.at),
          };
        })
        .filter(Boolean)
    : [];

  const session = src.session && typeof src.session === 'object' && !Array.isArray(src.session)
    ? {
        authenticated: src.session.authenticated === true,
        // The reporter's own id, echoed back so the board can pin the account without asking.
        // Cross-checked against the JWT by the caller — this is a hint, not an identity.
        user_id: Number.isInteger(Number(src.session.user_id)) && Number(src.session.user_id) > 0
          ? Number(src.session.user_id)
          : null,
        locale: cleanText(src.session.locale, 24),
        timezone: cleanText(src.session.timezone, 64),
        // Was this a fresh load or a long-lived tab? Distinguishes "broken on load" from
        // "broke after I'd been using it a while" without having to ask.
        session_age_s: Number.isFinite(Number(src.session.session_age_s))
          ? Math.max(0, Math.min(86400 * 7, Math.round(Number(src.session.session_age_s))))
          : null,
      }
    : null;

  const context = {
    console: consoleEntries,
    api: apiEntries,
    session,
  };

  // Nothing worth storing? Keep the column NULL rather than persisting an empty husk, so the
  // board UI can honestly say "no context captured" instead of showing three empty sections.
  if (!consoleEntries.length && !apiEntries.length && !session) {
    return { context: null, build_sha, viewport, device_type, nav_id };
  }

  // Hard size ceiling — a hostile client shouldn't be able to stuff the row.
  let serialised = JSON.stringify(context);
  if (Buffer.byteLength(serialised, 'utf8') > MAX_CONTEXT_BYTES) {
    context.console = context.console.slice(0, 2);
    context.api = context.api.slice(0, 2);
    serialised = JSON.stringify(context);
    if (Buffer.byteLength(serialised, 'utf8') > MAX_CONTEXT_BYTES) {
      return { context: null, build_sha, viewport, device_type, nav_id };
    }
  }

  return { context, build_sha, viewport, device_type, nav_id };
}

export default sanitizeClientContext;
