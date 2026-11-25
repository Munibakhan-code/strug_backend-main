// middleware/latency-monitor.js
import logger from '../utils/logger.js';
import crypto from 'crypto';
import { runWithRequestContext, getRequestError } from '../utils/request-context.js';
import { captureError } from '../utils/observability.js';

/**
 * 16.7 & 16.8: Telemetry Middleware
 * Automatically injects unique Correlation IDs (X-Correlation-ID)
 * and measures request latency with high precision.
 *
 * It also establishes the per-request AsyncLocalStorage context, which is what lets the ~1,900
 * `console.*` calls scattered through routes and services emit a correlation id without any of
 * them being rewritten (see utils/console-bridge.js).
 *
 * And it closes the reporting gap: 1,540 route handlers catch their own errors and answer
 * `res.status(500)` directly, so those failures never reach globalErrorHandler and were never
 * reported anywhere. Watching the finished response catches them regardless of how the handler
 * chose to answer.
 */
export function latencyMonitor(req, res, next) {
    const startTime = process.hrtime();

    // 16.8: Request correlation ID tracing context binding
    const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
    req.correlationId = correlationId;
    res.setHeader('X-Correlation-ID', correlationId);

    const context = {
        correlationId,
        // req.user is populated later by authenticateToken; read it lazily at finish time.
        get userId() { return req.user?.user_id ?? null; },
        method: req.method,
        path: req.originalUrl,
        lastError: undefined,
    };

    res.on('finish', () => {
        const diff = process.hrtime(startTime);
        const durationMs = parseFloat(((diff[0] * 1e9 + diff[1]) / 1e6).toFixed(3)); // nanoseconds to high-precision milliseconds

        // 16.7 & 16.10: Logging high-performance latency telemetry as structured JSON payload
        logger.info({
            message: `HTTP ${req.method} ${req.originalUrl} - ${res.statusCode} (${durationMs}ms)`,
            method: req.method,
            path: req.originalUrl,
            status_code: res.statusCode,
            duration_ms: durationMs,
            correlation_id: correlationId,
            user_id: req.user?.user_id || null,
            ip: req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1'
        });

        // Any 5xx is a server fault worth alerting on, however the handler produced it.
        // globalErrorHandler reports the ones routed through next(err); this catches the rest.
        if (res.statusCode >= 500) {
            // `req.reportedByErrorHandler` is set by globalErrorHandler so a single failure is
            // not reported twice.
            if (!req.reportedByErrorHandler) {
                const recorded = getRequestError();
                captureError(
                    recorded ?? new Error(`HTTP ${res.statusCode} ${req.method} ${req.originalUrl}`),
                    {
                        correlationId,
                        userId: req.user?.user_id,
                        path: req.originalUrl,
                        method: req.method,
                        statusCode: res.statusCode,
                        durationMs,
                        // Distinguishes "the handler swallowed it" from "it reached the boundary".
                        source: recorded ? 'handled-in-route' : 'status-only',
                    },
                );
            }
        }
    });

    // Everything downstream — including every await inside a route handler — runs inside this
    // context, so a log line written deep in a service still knows its request.
    runWithRequestContext(context, () => next());
}
