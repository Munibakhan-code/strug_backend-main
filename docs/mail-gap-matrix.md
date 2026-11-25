# Mail gap matrix (Phase 0 inventory)

**Date:** 11 Sep 2026 (Phase 5 cutover prep)  
**SSOT for branded templates:** `scripts/email-template-registry.js` (`EMAIL_TEMPLATE_REGISTRY`)  
**Send facade:** `services/email-service.js` → `services/mail/*`  
**Branded path:** `utils/mailer.js` + `utils/mailer-event.js`

## Env (runtime truth)

| Variable | Role |
|----------|------|
| `MAIL_PROVIDER` | `resend` (default) or `smtp` |
| `RESEND_API_KEY` | Required when provider=resend; also Resend SMTP password on `*.resend.com` |
| `RESEND_FROM_EMAIL` | Preferred From (Resend verified domain) |
| `EMAIL_USER` | Fallback From local-part / generic SMTP username when `SMTP_USER` unset |
| `EMAIL_PASSWORD` | **Deprecated** temporary fallback for generic SMTP when `SMTP_PASS` unset (never used on `*.resend.com`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP driver (default host `smtp.resend.com`) |
| `SMTP_USER`, `SMTP_PASS` | Preferred SMTP auth. On `*.resend.com`, defaults are username `resend` + `RESEND_API_KEY` |
| `MAIL_PROBE_ALLOWLIST` | Admin probe recipients for `POST /admin/mail/probe` |
| `MAIL_WEBHOOK_SECRET` | Shared secret for `POST /mail/webhook/events` (bounce/complaint stub) |
| `MAIL_OUTBOX_DISABLED` | Set `true` to skip critical-mail write-ahead outbox |
| `MAIL_OUTBOX_STALE_MS` | Pending outbox age before crash-recovery drain (default 120000) |
| `MAIL_RATE_PER_RECIPIENT_HOUR` | Soft cap per recipient (default 40) |
| `MAIL_RATE_PER_RECIPIENT_HOUR_CRITICAL` | Cap for OTP/receipts (default 20) |
| `MAIL_RATE_PER_TEMPLATE_HOUR` | Cap per template key (default 2000) |
| `JOB_SAVED_SEARCH_EMAIL` | Opt-in branded `job-saved-search` from jobs cron |
| `PROPERTY_SAVED_SEARCH_EMAIL` | Opt-in branded `property-saved-search` from property cron |
| `BOARD_URL` / `MARKETING_URL` | Board login base for `board-invite` (default `https://strug.ca/board`) |

Production stays on **Resend** until the Phase 5 **cutover gate** is signed off in staging (`docs/mail-smtp-cutover-gate.md`). This PR does **not** flip production provider.

## Branded templates (registry freeze)

36 templates in `EMAIL_TEMPLATE_REGISTRY` (excludes `layout.hbs`):

| Vertical | Templates |
|----------|-----------|
| auth | welcome, otp, password-reset, login-alert, password-change-success |
| shop | shop-order-receipt, shop-order-status, digital-delivery |
| food | food-order-receipt, food-order-status |
| rides | ride-receipt, ride-status, ghost-driver, carpool-booking |
| services | service-appointment, rental-expiry |
| ads | ads-low-balance, ads-spend-alert |
| jobs / HR | shift-update, leave-status, payslip, job-application-alert, job-application-status, job-saved-search |
| donations | fintech-mail, community-mail |
| events | event-invite |
| board | board-invite |
| property | property-saved-search |
| dating | dating-match, dating-worth-it-invite |
| medical | medical-booking-confirmed, medical-booking-request |
| venues | venue-booking-confirmed, venue-booking-request |
| social | social-new-follower |

## Raw HTML callers (`email-service.sendEmail`)

| Path | Kind | Notes |
|------|------|-------|
| `services/support-email-service.js` | ops | Support chat agent alert |
| `utils/bug-report-notify.js` | ops | Bug alert |
| `utils/video-pipeline-monitor.js` | ops | Video pipeline alert |
| `services/job-chat-email-service.js` | product | Opt-in `JOB_CHAT_EMAIL` (still raw HTML) |

## Phase 4 closed (this PR)

| Vertical | Outcome |
|----------|---------|
| board | Comment no longer claims SMTP is down; `board-invite` on admin create member |
| property | Opt-in `PROPERTY_SAVED_SEARCH_EMAIL` branded mail |
| jobs | Saved-search email upgraded from raw HTML to `job-saved-search` |
| events | Guest invite uses branded `event-invite` via mailer |
| dating | `dating-match` on mutual match; `dating-worth-it-invite` on Worth It invite |
| medical | `medical-booking-confirmed` / `medical-booking-request` via booking-engine |
| venues | `venue-booking-confirmed` / `venue-booking-request` via booking-engine |
| social | `social-new-follower` on accepted follow |

## Phase 5 landed (hardening; no prod SMTP cutover)

| Piece | Outcome |
|-------|---------|
| Suppression | `mail_suppression` + check before send; admin list/add/deactivate |
| Bounce stub | `POST /mail/webhook/events` with `MAIL_WEBHOOK_SECRET` → upsert suppression |
| Rate limits | Per-recipient + per-template hourly caps from `mail_send_log` |
| Critical outbox | Write-ahead for OTP/receipts; drain cron every 2m for stale `pending` only (no auto-retry of provider failures) |
| Health | `GET /admin/mail/health` includes outbox counts + rate limit snapshot |
| Cutover prep | `docs/mail-smtp-cutover-gate.md` + `GET /admin/mail/cutover-status`; `EMAIL_PASSWORD` deprecated; `guard:nodemailer` isolates nodemailer to SMTP driver |

**Still deferred:** production Resend → SMTP flip (after staging sign-off); full ESP signature verification; marketing unsubscribe product UX; migrating ops raw HTML.

## Remaining gaps

| Vertical | Gap |
|----------|-----|
| contact form | Lives in **marketing** `src/app/api/contact/route.ts` (Resend ops notify), not this backend |
| LMS / community | `emails.lms_community` i18n orphan; no product trigger yet (do not delete without product OK) |
| dating / medical / venues / social | Branded mails wired (match, Worth It invite, booking confirmed/request, new follower) |
| ops raw HTML | Support / bug / video / job-chat left for later |

## Add a branded mail (Phase 1 contract)

1. Add `templates/emails/<name>.hbs`
2. Add locale keys under `emails.*` in `locales/*/translation.json`
3. Add a row to `EMAIL_TEMPLATE_REGISTRY`
4. Emit via `mailerEvents` or call `utils/mailer.sendEmail`
5. Extend smoke sample vars in the registry helper

Do **not** edit provider drivers for new product mail.
