// Routes every `console.*` call through Winston.
//
// This service has ~1,900 `console.log/warn/error` calls in production code and exactly two
// files that import the logger. So the well-built structured logging in utils/logger.js was
// carrying almost nothing, while the real operational signal went to raw stdout with no level,
// no timestamp discipline, no correlation id and no request path — unusable for aggregation and
// unusable in an incident.
//
// Rewriting 1,900 call sites would be a large, risky diff for no behavioural gain. Bridging the
// global console instead is one file: every existing call keeps working unchanged and starts
// emitting structured JSON enriched with the current request's correlation id.
//
// Deliberate properties:
//   * Idempotent. Installing twice is a no-op.
//   * Reversible via restoreConsole(), so tests can assert on real console output.
//   * Never throws. A logging failure falls back to the original console.
//   * Preserves console's formatting semantics (%s/%d, multiple args, Error stacks) via
//     util.format, so existing call sites read the same in the console transport.
import util from 'util';
import logger from './logger.js';
import { getRequestContext, noteRequestError } from './request-context.js';

const METHODS = /** @type {const} */ (['log', 'info', 'warn', 'error', 'debug', 'trace']);

/** console method -> winston level (utils/logger.js defines error/warn/info/http/debug). */
const LEVEL_FOR = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
  trace: 'debug',
};

// The ORIGINAL function references, stored unbound so restoreConsole() puts back the exact same
// function object it replaced — a bound copy would behave identically but break identity, and a
// test (or another bridge) checking whether console is pristine would be misled.
/** @type {Partial<Record<typeof METHODS[number], (...args: unknown[]) => void>>} */
const original = {};
let installed = false;

/** First Error among the arguments — that is the one worth keeping a stack for. */
function firstError(args) {
  for (const a of args) if (a instanceof Error) return a;
  return null;
}

export function installConsoleBridge() {
  if (installed) return false;

  for (const method of METHODS) {
    original[method] = console[method];
    console[method] = (...args) => {
      try {
        const ctx = getRequestContext();
        const err = firstError(args);

        // Remember it so the 5xx reporter can attach a real stack to a route that caught its
        // own error and answered res.status(500) without ever calling next(err).
        if (method === 'error' && err) noteRequestError(err);

        logger.log({
          level: LEVEL_FOR[method],
          message: util.format(...args),
          ...(ctx?.correlationId ? { correlation_id: ctx.correlationId } : {}),
          ...(ctx?.userId != null ? { user_id: ctx.userId } : {}),
          ...(ctx?.path ? { path: ctx.path, method: ctx.method } : {}),
          ...(err?.stack ? { stack: err.stack } : {}),
        });
      } catch {
        // Logging must never break the caller — fall back to the real console.
        // Called through .apply so the stored (unbound) reference still gets its receiver.
        try { original[method].apply(console, args); } catch { /* nothing left to try */ }
      }
    };
  }

  installed = true;
  return true;
}

/** Put the real console back. Used by tests that assert on console output. */
export function restoreConsole() {
  if (!installed) return false;
  for (const method of METHODS) {
    if (original[method]) console[method] = original[method];
  }
  installed = false;
  return true;
}

export function isConsoleBridged() {
  return installed;
}
