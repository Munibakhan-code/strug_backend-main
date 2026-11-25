// Per-request context, available anywhere without threading `req` through every function.
//
// latency-monitor.js already mints a correlation id per request, but only the middleware itself
// could see it — the 1,900 `console.*` calls scattered through routes, services and utils had no
// way to reach it. So a failure logged deep in a service could not be tied back to the request
// that caused it, which is most of why the logs were unusable in an incident.
//
// AsyncLocalStorage carries the context across every await in a request, so a log line written
// five layers down still knows which request it belongs to.
import { AsyncLocalStorage } from 'async_hooks';

/** @typedef {{ correlationId?: string, userId?: number|string|null, method?: string, path?: string, lastError?: unknown }} RequestContext */

/** @type {AsyncLocalStorage<RequestContext>} */
const storage = new AsyncLocalStorage();

/** Run `fn` with `context` attached to everything it awaits. */
export function runWithRequestContext(context, fn) {
  return storage.run(context, fn);
}

/** The current request's context, or undefined outside a request (cron ticks, boot). */
export function getRequestContext() {
  return storage.getStore();
}

/** Correlation id for the current request, or null. */
export function getCorrelationId() {
  return storage.getStore()?.correlationId ?? null;
}

/**
 * Remember the most recent error seen during this request.
 *
 * Most routes here catch their own errors and answer `res.status(500)` directly, so the error
 * object never reaches globalErrorHandler and is lost. Recording it means the 5xx reporter can
 * still attach a real stack trace to the failure it observes on the way out.
 */
export function noteRequestError(error) {
  const store = storage.getStore();
  if (store) store.lastError = error;
}

/** The error recorded for this request, if any. */
export function getRequestError() {
  return storage.getStore()?.lastError;
}
