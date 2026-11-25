// utils/client-error.js
//
// Shield internal error details (DB/Prisma text, stack fragments, driver messages)
// from client responses on server-side (5xx) failures.
//
// In production we never echo `err.message` back to the caller for a server error —
// e.g. Prisma's "Can't reach database server at psql-...:5432" must not reach clients.
// Outside production the real message is returned to keep local/staging debugging easy.
// This mirrors the policy already enforced by middleware/error-handler.js.
export function clientErrorMessage(err, fallback = 'Internal server error') {
  if (process.env.NODE_ENV === 'production') return fallback;
  return err?.message || fallback;
}
