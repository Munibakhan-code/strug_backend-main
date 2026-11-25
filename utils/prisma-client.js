import { PrismaClient } from '@prisma/client';
import { encryptionMiddleware } from '../middleware/encryption.js';
import { genPublicId, slugify } from './slugify.js';

// Auto-assign the shareable-URL identity (public_id + slug) to a video row being created if the
// caller didn't set it. The upload route already does this via createVideoWithIdentity (with
// collision-retry), but other create paths (the seed scripts/seed-all.js, the synthetic probe
// workers/video-synthetic-probe.js, and any future code) would otherwise insert NULL public_id
// rows, which fall back to ugly /v/{numeric_id} links. Doing it here, at the single point every
// query flows through, makes it impossible to bypass. Only fills when absent, so the upload
// route's explicit (retried) values are left untouched.
function assignVideoIdentity(data) {
  if (!data || typeof data !== 'object') return;
  if (data.public_id == null) data.public_id = genPublicId();
  if (data.slug == null) data.slug = slugify(data.title);
}

// Globally omit password hashes from EVERY query result. ~65 route files embed these rows via
// `include: { user: true }` (and the other password-bearing tables can be returned by any
// findMany without an explicit select), which would otherwise leak the bcrypt hash to clients.
// Omitting at the client level neutralizes the whole class of leak in one place. The auth flows
// that must VERIFY a password opt back in per-query with `omit: { password: false }`:
//   - user:         login / google sign-in / change-password (auth-routes/user-auth-route.js)
//   - admin:        /admin-login (auth-routes/user-auth-route.js)
//   - board_member: /board-auth login (routes/board-auth-routes.js)
// Prisma treats a `password: undefined` write as "leave unchanged", so update routes that
// preserved the existing hash still work without the column being readable.
//
// The user omit also covers PRECISE saved location (saved_address/lat/long) + ref_code: ~217
// routes embed a (often third-party) user via `include: { user: true }`, which leaked those
// plaintext fields (including exact home coordinates) to any authenticated caller (PII-1).
// Prisma applies `omit` ONLY to reads without an explicit `select`, so every auth flow
// (USER_AUTH_SELECT) and the user-routes self-views (explicit selects, incl. the address
// editor which selects saved_*) are UNAFFECTED. A grep confirmed NO server-side code reads
// user.saved_*/ref_code off an embed, so this strips them only from third-party embeds.
//
// `email` is deliberately NOT omitted: many routes read `user.email` off a bare
// `include: { user: true }` to send transactional emails (donation receipts, carpool, etc.).
// Auth write paths store email via `encryptEmailForStorage` (deterministic AES). The Prisma
// encryption middleware (#1295) encrypts bank/withdrawal/tax/phone secrets (AEAD), not email:
// do not assume every sensitive column is middleware-encrypted.
//
// #1292: bank / withdrawal accounts, delivery OTPs, driver KYC blob URLs, ads tax ids, and
// courier/trip/event share tokens are never needed on a bare findMany/include. Opt back in
// per-query with `omit: { field: false }` or an explicit `select` (OTP verify, token mint,
// owner share/invite links, admin payout).
// Keys use Prisma Client model names (camelCase for PascalCase schema models).
export const PRISMA_CLIENT_OMIT = {
  user: {
    password: true,
    ref_code: true,
    saved_address: true,
    saved_lat: true,
    saved_long: true,
    // KYC / identity docs: an uploaded ID URL, its filename, and the verified date-of-birth.
    // These are NEVER needed on a bare `include: { user: true }` embed and were leaking through
    // ~27 provider/order routes. Omit strips them from embeds; the KYC-review + age-gate paths
    // read them with an explicit `select` (user-routes.js, dating-routes.js), which omit does
    // not touch, so those keep working. See the sweep note (2026-08-08).
    document_verification_document_url: true,
    document_verification_document_name: true,
    document_verification_dob: true,
  },
  admin: { password: true },
  board_member: { password: true },
  appointment_service_providers: { password: true },
  bank_info: { bank_account_number: true },
  withdrawalRequest: { account_number: true },
  artistWithdrawalRequest: { account_number: true },
  celebrityWithdrawalRequest: { account_number: true },
  driver_document: { document_url: true, document_name: true },
  food_order: { otp_code: true },
  active_trip: { otp_code: true, share_token: true },
  ads_account_profile: { tax_id: true, brn: true },
  courier_order: { tracking_token: true },
  event_plan: { share_token: true },
  event_guest: { invite_token: true },
};

const prisma = new PrismaClient({
  omit: PRISMA_CLIENT_OMIT,
}).$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (model === 'video') {
          if (operation === 'create') assignVideoIdentity(args.data);
          else if (operation === 'createMany') {
            const rows = Array.isArray(args.data) ? args.data : [args.data];
            rows.forEach(assignVideoIdentity);
          } else if (operation === 'upsert') assignVideoIdentity(args.create);

          if (operation === 'update' && args.data?.thumbnail_url) {
            const videoId = args.where?.video_id;
            if (videoId) {
              // The worker writes its auto-generated frame-grab WITHOUT setting
              // thumbnail_is_custom (it should never touch that field). A creator-supplied
              // thumbnail (initial upload, finalize, /upload-thumbnail) sets BOTH thumbnail_url
              // AND thumbnail_is_custom: true in the same call (see video-routes.js). So: if this
              // particular update is not itself marking the thumbnail custom, treat it as a
              // candidate auto-update and check whether a custom one is already on file.
              const thisUpdateIsCustom = args.data.thumbnail_is_custom === true;
              if (!thisUpdateIsCustom) {
                const current = await prisma.$queryRaw`SELECT "thumbnail_url", "thumbnail_is_custom" FROM "video" WHERE "video_id" = ${videoId}`;
                const row = current[0];
                // Primary signal: explicit flag. Fallback (rows created before the flag existed,
                // or any path that forgot to set it): the legacy filename-pattern heuristic, kept
                // as a safety net rather than the source of truth.
                const legacyLooksCustom = row?.thumbnail_url && !(
                  row.thumbnail_url.includes(`/thumb-${videoId}-`) || row.thumbnail_url.includes(`/thumb-${videoId}.`)
                );
                if (row?.thumbnail_is_custom === true || legacyLooksCustom) {
                  delete args.data.thumbnail_url;
                }
              }
            }
          }
        }
        const params = { model, action: operation, args };
        return encryptionMiddleware(params, (nextParams) =>
          query(nextParams.args)
        );
      },
    },
  },
});

prisma.$setContext = function (ctx) {
  this.__ctx = ctx;
};

export default prisma;
