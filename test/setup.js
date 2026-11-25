import dotenv from 'dotenv';

// Tests load their own env from .env.test (gitignored), never the dev/staging .env.
dotenv.config({ path: '.env.test' });

// Make sure no code path takes the "production" branch (CORS allowlist, fail-fast, etc.).
process.env.NODE_ENV = 'test';

// Keep webhook tests on the signed-code path. Without a local secret the booking
// webhook falls back to JSON parsing in tests, which masks forged signatures.
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
}

// Safety guard: never let a test run point at a shared Neon (staging/prod) database by
// accident. CI uses an ephemeral Neon branch and sets ALLOW_REMOTE_TEST_DB=1 to opt in.
const dbUrl = process.env.DATABASE_URL || '';
if (/neon\.tech/.test(dbUrl) && !process.env.ALLOW_REMOTE_TEST_DB) {
  throw new Error(
    'Refusing to run tests: DATABASE_URL points at a Neon host but ALLOW_REMOTE_TEST_DB ' +
    'is not set. Point .env.test at a dedicated test DB, or set ALLOW_REMOTE_TEST_DB=1 ' +
    'in CI for an ephemeral branch.'
  );
}

// Pure-unit tests (Phase 1) need no DB. Several utils call dotenv.config() at import time,
// which would load the dev/staging .env and leave a real DATABASE_URL in the environment.
// dotenv never overrides an already-set var, so claim DATABASE_URL now with an unreachable
// placeholder — a stray Prisma query then fails fast instead of touching a shared DB.
// Phase 2 supplies a real test DATABASE_URL via .env.test (loaded above first).
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/strug_unit_placeholder';
}
