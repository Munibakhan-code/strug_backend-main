# Strug Backend

The main Strug platform API — a **Node.js / Express** server backed by **Prisma**
(PostgreSQL), with **Socket.IO** realtime, **Stripe** payments, **Redis** (ioredis),
**JWT** auth, **Resend** transactional email (SMTP optional via `MAIL_PROVIDER`),
**Zod** validation, and **Winston** logging.
It serves the social/video/verticals app (`strug-final-frontend`) and the strug.ca
site (`strug_frontend-main`).

## Getting Started

```bash
npm install
cp .env.example .env      # fill in DB, Azure, Stripe, JWT, RESEND_*, etc.
npx prisma generate
npm run dev               # nodemon (dev)   |   npm start (prod)
```

Transactional mail defaults to **Resend** (`MAIL_PROVIDER=resend`). Set
`MAIL_PROVIDER=smtp` only for staging/SMTP experiments after the cutover gate
checklist (`docs/mail-smtp-cutover-gate.md`). Prefer `SMTP_PASS` (not deprecated
`EMAIL_PASSWORD`). Inventory and gaps: `docs/mail-gap-matrix.md`. Add branded
mail via templates + registry + `mailer` (not provider drivers).

## Layout

```
index.js          # Server bootstrap: Socket.IO, 18 background schedulers, graceful shutdown
app.js            # Express app: CORS, security headers, ~222 mounted routers, error handler
routes/           # REST route handlers (one file per resource/vertical)
auth-routes/      # authentication routes
middleware/       # auth, validation, error handling
services/         # business logic / integrations
sockets/          # Socket.IO handlers
workers/          # background workers
ai/               # AI/LLM features (LangChain graph, agents)
prisma/           # schema.prisma (398 models) + migrations/ (150)
templates/        # email templates
locales/          # i18n strings
infra/            # infra config (e.g. mediamtx for live streaming)
scripts/          # one-off / maintenance scripts (NOT app runtime)
```

## Environment & secrets

Copy `.env.example` and fill it in. **Never commit real secrets** — `.env` and all
`.env.*` variants are gitignored (only `.env.example` is tracked). `scripts/seed-credentials.json`
is also gitignored.

> Note: `.env.production` / `.env.backup` / `.env.local_test` were previously committed
> and have been untracked. Their values remain in git history — rotate any exposed
> credentials (DB password, Azure keys, Content-Safety key) out of band.

## Database / deploy

- Prisma migrations live in `prisma/migrations/`. Generate the client with
  `npx prisma generate`; apply with `npx prisma migrate deploy`.
- **Migration baseline (2026-07-01):** history was squashed to a single reproducible
  `prisma/migrations/0_init` (older migrations archived under
  `prisma/_archived_migrations_pre_0_init/`). **If you have a local DB created before this
  date and `prisma migrate dev`/`deploy` wants to reset it or errors "relation already
  exists" — do NOT reset. Run `npm run db:baseline` once**, then `npm run db:status`
  should print "Database schema is up to date!". Fresh/empty DBs need nothing; staging +
  prod are already baselined.
- Staging DB runs on **Neon**; production on **Azure** Postgres.
- Deploy by push: `main` → staging, `release` → prod (promote `main` → `release` via PR).
- Health probes:
  - `GET /health` — **liveness**. Process only, no dependency I/O. Never fails because a
    dependency is down, so a database blip cannot get a healthy replica restarted.
  - `GET /health/ready` — **readiness**. Checks Postgres (hard) and Redis (soft, since the
    rate limiter and caches fall back in-memory). 503 while Postgres is unreachable.
  - `GET /health/startup` — same signal as readiness, separate path so probe budgets differ.
  - `GET /social-system/health` — the older combined check. Superseded; see routes/health-routes.js.

> Prod has historically had migration drift (migrations marked-applied-without-running).
> After promoting, verify the relevant columns/tables actually exist.


## Node and npm versions

CI runs **Node 20 / npm 10**, and the container image is `node:20-slim`. `.nvmrc` and the
`engines` field record that.

**Regenerating the lockfile:** npm 11 resolves transitive dependencies differently from
npm 10 — it omits nested entries that `npm ci` on npm 10 still requires. A lockfile written
by npm 11 therefore fails CI at the install step with:

```
npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json or npm-shrinkwrap.json are in sync.
npm error Missing: <pkg>@<version> from lock file
```

If you are on npm 11 (check with `npm -v`), regenerate the lockfile with the version CI uses:

```bash
npx npm@10.8.2 install --package-lock-only
```

Then confirm it the way CI does, in a clean directory:

```bash
mkdir /tmp/lockcheck && cp package.json package-lock.json /tmp/lockcheck/
cd /tmp/lockcheck && npx npm@10.8.2 ci --ignore-scripts
```

## Adding a test

Every `*.test.js` file must be listed in exactly one vertical in
`test/verticals.manifest.json`, or `npm run guard:verify-manifest` fails CI. Cross-cutting
infrastructure tests belong in `core`, which has `always: true` — that matters for the ratchet
tests, which are only effective if they run on every PR.

## Operations

### Background jobs and horizontal scale

All background work (18 schedulers across `utils/`, `workers/`, `services/`) runs in-process.
Each tick goes through `withCronLock` in `utils/cron-lock.js`, which claims a Redis lock so
exactly one replica runs a given tick. Before this the service was pinned to
`--max-replicas 1` in `deploy.yml`, because a second replica meant duplicate ride dispatch,
duplicate saved-search emails and duplicate payout sweeps.

Two environment variables control it:

| Variable | Effect |
| --- | --- |
| `CRON_ENABLED=false` | This replica runs **no** background jobs. Set on API replicas once jobs move to a dedicated worker container. |
| `CRON_REQUIRE_LOCK=true` | If Redis is unavailable, **skip** the tick rather than run it. Required whenever `MAX_REPLICAS > 1`. |

Adding a new scheduled job: use `scheduleCron(id, expr, handler)` or
`scheduleInterval(id, handler, ms)` from `utils/cron-lock.js` — never bare `cron.schedule` or
`setInterval`, or that job will double-fire on every replica. Register it in
`utils/cron-inventory.js` too.

### Observability

- **Crash reporting** — `utils/observability.js`. Completely inert without `SENTRY_DSN`, so
  local dev and CI are unaffected. Payloads are scrubbed (auth headers, cookies, passwords,
  tokens, OTPs, card fields); the user is identified by id only. Client-caused 4xx are
  deliberately not reported.
- **Correlation ids** — `middleware/latency-monitor.js` mints one per request and stores it in
  an AsyncLocalStorage context (`utils/request-context.js`) that survives every `await`.
- **Logging** — `utils/console-bridge.js` routes every `console.*` call through Winston,
  enriched with the current request’s correlation id, user and route. Existing call sites need
  no changes; new code can use either.
- **5xx reporting** — most handlers here catch their own errors and answer `res.status(500)`
  directly, so they never reach `globalErrorHandler`. `latencyMonitor` watches the finished
  response and reports any 5xx regardless, attaching the real error when one was logged.

### Bounded list queries

Use `paginate()` / `parsePagination()` from `utils/pagination.js` for any list endpoint whose
row count grows with the platform. Page metadata rides on `X-Total-Count` / `X-Has-More` /
`X-Page-Limit` / `X-Page-Offset` headers so response bodies keep their existing shape.
`test/unit/unbounded-queries.test.js` is a ratchet: the number of unbounded `findMany` calls
may go down but never up.

### Linting

`npm run lint` fails on any error and on more warnings than the recorded cap in `package.json`,
so the warning count can only ratchet down. Errors are the defect-class rules — `no-undef`
among them, which is what catches an identifier referenced but never declared.
