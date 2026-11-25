// middleware/error-handler.js
import { ZodError } from 'zod';
import logger from '../utils/logger.js';
import { captureError } from '../utils/observability.js';

/**
 * PRODUCTION-GRADE GLOBAL ERROR HANDLER
 *
 * Intercepts all uncaught errors, Prisma DB errors, Zod validation errors,
 * and Multer file upload errors to return clean, standardized JSON responses.
 *
 * All responses carry the request correlation_id and every error is logged
 * through Winston (structured telemetry), so outage alerting keys off correct
 * HTTP status codes (connection/engine + schema-gap failures = 5xx).
 */
// Prisma codes that mean "the caller sent something wrong", and error names that mean the same.
// Everything else that reaches this boundary is a server fault worth alerting on.
const CLIENT_FAULT_PRISMA_CODES = new Set(['P2002', 'P2025', 'P2003']);
const CLIENT_FAULT_ERROR_NAMES = new Set(['JsonWebTokenError', 'TokenExpiredError']);

function isServerFault(err) {
  if (err instanceof ZodError) return false;
  if (CLIENT_FAULT_ERROR_NAMES.has(err?.name)) return false;
  if (err?.code === 'LIMIT_FILE_SIZE') return false;
  if (typeof err?.code === 'string' && CLIENT_FAULT_PRISMA_CODES.has(err.code)) return false;
  // An explicitly-set 4xx status is a deliberate client error, not a crash.
  const status = err?.status || err?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  return true;
}

export function globalErrorHandler(err, req, res, _next) {
  const correlationId = req.correlationId || 'N/A';

  // Structured telemetry for every error that reaches the boundary.
  logger.error({
    message: err?.message || 'Internal server error',
    code: err?.code,
    name: err?.name,
    path: req.originalUrl,
    method: req.method,
    correlation_id: correlationId,
    stack: process.env.NODE_ENV === 'production' ? undefined : err?.stack,
  });

  // Report anything that is genuinely our fault. Client-caused errors (validation, auth,
  // not-found, duplicate) are normal traffic and would drown the signal, so they are logged
  // above but not reported. No-op unless SENTRY_DSN is configured.
  if (isServerFault(err)) {
    captureError(err, {
      correlationId,
      userId: req.user?.user_id,
      path: req.originalUrl,
      method: req.method,
      source: 'error-handler',
    });
  }
  // Tell latency-monitor's 5xx sweep that this failure is already accounted for, so a single
  // error is not reported twice.
  req.reportedByErrorHandler = true;

  // 1. Zod Validation Errors (400 Bad Request)
  if (err instanceof ZodError) {
    // Zod 4 exposes `.issues`; the `.errors` alias this used to read was removed in the v3→v4
    // upgrade. Reading it returned undefined and `.map` threw *inside this handler*, so Express
    // fell through to its default handler and answered every validation failure with an HTML
    // 500 instead of this 400. `.errors` is kept as a fallback for any v3-era error object.
    const issues = err.issues ?? err.errors ?? [];
    return res.status(400).json({
      successful: false,
      message: 'Validation failed for one or more fields.',
      code: 'VALIDATION_ERROR',
      correlation_id: correlationId,
      errors: issues.map((e) => ({
        field: Array.isArray(e.path) ? e.path.join('.') : String(e.path ?? ''),
        message: e.message,
      })),
    });
  }

  // 2. Prisma Database Known Request Errors
  if (err?.code && typeof err.code === 'string' && err.code.startsWith('P')) {
    switch (err.code) {
      // --- Genuine client-caused errors (4xx) ---
      case 'P2002': {
        const target = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : 'field';
        return res.status(409).json({
          successful: false,
          message: `A record with this ${target} already exists.`,
          code: 'DUPLICATE_ENTRY',
          correlation_id: correlationId,
        });
      }
      case 'P2025': {
        return res.status(404).json({
          successful: false,
          message: 'Requested record was not found.',
          code: 'RECORD_NOT_FOUND',
          correlation_id: correlationId,
        });
      }
      case 'P2003': {
        return res.status(400).json({
          successful: false,
          message: 'Invalid reference to a related resource.',
          code: 'FOREIGN_KEY_VIOLATION',
          correlation_id: correlationId,
        });
      }

      // --- Schema gaps: table/column missing → server-side (500), masked ---
      case 'P2021':
      case 'P2022':
        return res.status(500).json({
          successful: false,
          message: 'This feature is temporarily unavailable. Please try again shortly.',
          code: 'DATABASE_ERROR',
          correlation_id: correlationId,
        });

      // --- Engine / connection failures (P1xxx) → server-side (500) ---
      // Do NOT collapse these to 400; outage alerting keys off 5xx.
      default:
        return res.status(500).json({
          successful: false,
          message: process.env.NODE_ENV === 'production'
            ? 'An unexpected server error occurred.'
            : `Database operation failed (${err.code}).`,
          code: 'DATABASE_ERROR',
          correlation_id: correlationId,
        });
    }
  }

  // 3. JWT Authentication Errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({
      successful: false,
      message: err.name === 'TokenExpiredError' ? 'Session expired. Please log in again.' : 'Invalid authentication token.',
      code: 'AUTH_FAILED',
      correlation_id: correlationId,
    });
  }

  // 4. Multer Upload Limit Errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      successful: false,
      message: 'File size exceeds the maximum allowed limit (5MB).',
      code: 'FILE_TOO_LARGE',
      correlation_id: correlationId,
    });
  }

  // 5. Uncaught General Exceptions (500 Internal Server Error)
  return res.status(err.status || err.statusCode || 500).json({
    successful: false,
    message: process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : err.message,
    code: 'INTERNAL_SERVER_ERROR',
    correlation_id: correlationId,
  });
}
