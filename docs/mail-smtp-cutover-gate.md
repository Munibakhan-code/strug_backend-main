# Mail SMTP cutover gate

**Status:** Resend remains the production default (`MAIL_PROVIDER=resend`).  
**Do not** point production at SMTP until every row below is signed off in **staging**.

This checklist is the Phase 5 production cutover gate from `docs/Mail_System_Implementation_Plan.md`.

## Code prerequisites (already on this branch)

| Piece | Where |
|-------|--------|
| Provider switch | `MAIL_PROVIDER=resend\|smtp` via `services/mail/config.js` |
| Mail Health | `mail_send_log` + `GET /admin/mail/health` |
| Suppression | `mail_suppression` + pre-send check + admin APIs |
| Rate limits | Per-recipient / per-template hourly caps |
| Critical outbox | `mail_outbox` + drain cron for stale `pending` |
| Bounce stub | `POST /mail/webhook/events` (`MAIL_WEBHOOK_SECRET`) |
| Nodemailer isolation | Only `services/mail/providers/smtp.js` may import `nodemailer` (`guard:nodemailer`) |

Admin snapshot: `GET /admin/mail/cutover-status` (admin JWT).

## Staging sign-off

| Gate | Pass means | Owner / date |
|------|------------|--------------|
| Deliverability | Test inbox + spam checks; SPF/DKIM/DMARC aligned for the SMTP From domain | |
| Retry | Transient SMTP failures retry with backoff; permanent failures stop (visible in Health) | |
| Failure handling | OTP / password-reset / receipts degrade safely; Health shows last errors for `provider=smtp` | |
| Monitoring | `GET /admin/mail/health` shows success/fail counts and recent failures while on SMTP | |
| Suppression | Bounce webhook or admin suppress blocks further sends (`MAIL_SUPPRESSED`) | |
| Outbox | Kill API mid-OTP send; stale pending drains within `MAIL_OUTBOX_STALE_MS` without double user OTP when user resends | |

## Env for SMTP staging (not production)

```bash
MAIL_PROVIDER=smtp
RESEND_FROM_EMAIL=mail@strug.ca   # or verified From on the SMTP domain
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=...
SMTP_PASS=...                     # preferred; do not use EMAIL_PASSWORD
# MAIL_WEBHOOK_SECRET=...         # if the relay posts bounces
```

Legacy `EMAIL_PASSWORD` is deprecated for generic SMTP. Prefer `SMTP_PASS`. On `*.resend.com`, password is `RESEND_API_KEY` (username `resend`).

## Production flip (only after staging sign-off)

1. Confirm checklist rows above are filled.
2. Set production `MAIL_PROVIDER=smtp` with production SMTP credentials / From.
3. Watch Health for 24h; keep Resend credentials available for emergency rollback (`MAIL_PROVIDER=resend`).
4. Do not remove the Resend driver until rollback is no longer needed.

## Explicitly not this gate

- Marketing blasts / campaign builder
- Full ESP dashboard clone
- Migrating every ops raw-HTML alert to branded templates
- Contact form (marketing site)
