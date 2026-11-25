// Crash reporting.
//
// Until now the only record of a server-side failure was a `console.error` inside whichever
// route caught it, written to a rotating file inside an ephemeral container. Nothing aggregated
// them, so a route that threw on every single call — `PUT /categories/:id`, `PUT
// /social-interactions/:id`, both dead for months — produced a generic 500 and no signal at all.
//
// Two hard rules:
//   1. Absent SENTRY_DSN this module is inert. Local dev, CI and tests must behave exactly as
//      before, with no network calls and no init.
//   2. It never throws. Observability failing must not take down the request path, so every
//      entry point is wrapped.
import * as Sentry from '@sentry/node';
import logger from './logger.js';

let enabled = false;

/** True once initObservability() has successfully initialised a real DSN. */
export function isObservabilityEnabled() {
  return enabled;
}

// Request headers and body fields that must never leave the process. `sendDefaultPii` is off
// as well, but this is the belt-and-braces pass in case a payload is attached explicitly.
const SCRUB_KEYS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token',
  'password', 'new_password', 'old_password', 'confirm_password',
  'token', 'access_token', 'refresh_token', 'client_secret', 'secret',
  'otp', 'otp_code', 'card', 'card_number', 'cvv', 'cvc', 'pin',
  'ssn', 'sin', 'tax_id', 'bank_account', 'iban', 'routing_number',
]);

function scrub(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SCRUB_KEYS.has(k.toLowerCase()) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

/**
 * Initialise crash reporting. Call once, as early in process start as possible.
 * A missing DSN is the normal case outside production — it is not an error.
 */
export function initObservability() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info({ message: '[observability] SENTRY_DSN not set — crash reporting disabled' });
    return false;
  }

  try {
    Sentry.init({
      dsn,
      environment: process.env.APP_ENV || process.env.NODE_ENV || 'development',
      release: process.env.APP_RELEASE || process.env.GITHUB_SHA || undefined,

      // Error reporting only by default. Tracing on a 2000-endpoint API is a separate
      // (and expensive) decision — opt in explicitly with SENTRY_TRACES_SAMPLE_RATE.
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),

      // Never attach IPs, cookies or request bodies automatically.
      sendDefaultPii: false,

      beforeSend(event) {
        try {
          if (event.request) {
            if (event.request.headers) event.request.headers = scrub(event.request.headers);
            if (event.request.data) event.request.data = scrub(event.request.data);
            if (event.request.cookies) event.request.cookies = '[redacted]';
          }
          if (event.extra) event.extra = scrub(event.extra);
          // Identify the user by id only — never email, handle or IP.
          if (event.user) event.user = { id: event.user.id };
        } catch {
          // A scrubbing failure must drop the event rather than risk sending raw data.
          return null;
        }
        return event;
      },
    });

    enabled = true;
    logger.info({
      message: '[observability] crash reporting enabled',
      environment: process.env.APP_ENV || process.env.NODE_ENV,
    });
    return true;
  } catch (err) {
    logger.error({ message: `[observability] init failed (continuing without): ${err?.message}` });
    return false;
  }
}

/**
 * Report an error that has already been logged. Safe to call unconditionally — a no-op when
 * reporting is disabled, and never throws.
 * @param {unknown} err
 * @param {{ correlationId?: string, userId?: number|string, path?: string, method?: string, statusCode?: number, [k: string]: unknown }} [context]
 */
export function captureError(err, context = {}) {
  if (!enabled) return;
  try {
    const { correlationId, userId, ...rest } = context;
    Sentry.withScope((scope) => {
      if (correlationId) scope.setTag('correlation_id', correlationId);
      if (context.path) scope.setTag('route', context.path);
      if (context.statusCode) scope.setTag('status_code', String(context.statusCode));
      if (userId != null) scope.setUser({ id: String(userId) });
      scope.setExtras(scrub(rest));
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
    });
  } catch {
    // Reporting must never break the caller.
  }
}

/**
 * Flush buffered events before the process exits. Returns quickly when disabled.
 * @param {number} timeoutMs
 */
export async function flushObservability(timeoutMs = 2000) {
  if (!enabled) return true;
  try {
    return await Sentry.flush(timeoutMs);
  } catch {
    return false;
  }
}

export { Sentry };
