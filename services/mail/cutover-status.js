/**
 * Phase 5: code-side SMTP cutover readiness (does not flip production provider).
 */
import {
  getMailConfigSnapshot,
  isSmtpEnvConfigured,
} from './config.js';
import { getMailRateLimits } from './rate-limit.js';

/**
 * @returns {Promise<object>}
 */
export async function getMailCutoverStatus() {
  const config = getMailConfigSnapshot();
  const outboxDisabled =
    process.env.MAIL_OUTBOX_DISABLED === 'true' ||
    process.env.MAIL_OUTBOX_DISABLED === '1';
  const webhookConfigured = Boolean(String(process.env.MAIL_WEBHOOK_SECRET || '').trim());
  const smtpReady = isSmtpEnvConfigured();
  const rates = getMailRateLimits();
  const activeIsSmtp = String(config.provider || '').toLowerCase() === 'smtp';

  const gates = {
    health_ledger: true,
    suppression: true,
    rate_limits: true,
    critical_outbox: !outboxDisabled,
    bounce_webhook_secret: webhookConfigured,
    smtp_env_configured: smtpReady,
    nodemailer_isolated: true,
    no_legacy_email_password: !config.smtp_legacy_email_password,
  };

  // Webhook secret is recommended but not required for code readiness (admin suppress works).
  const code_ready =
    gates.health_ledger &&
    gates.suppression &&
    gates.rate_limits &&
    gates.critical_outbox &&
    gates.smtp_env_configured &&
    gates.nodemailer_isolated &&
    gates.no_legacy_email_password;

  return {
    production_default_provider: 'resend',
    active_provider: config.provider,
    active_is_smtp: activeIsSmtp,
    configured: config.configured,
    smtp_legacy_email_password: Boolean(config.smtp_legacy_email_password),
    rate_limits: rates,
    gates,
    code_ready,
    staging_signoff_required: [
      'deliverability',
      'retry',
      'failure_handling',
      'monitoring',
      'suppression_e2e',
      'outbox_crash_recovery',
    ],
    checklist_doc: 'docs/mail-smtp-cutover-gate.md',
    note:
      'Do not set MAIL_PROVIDER=smtp in production until staging signs off docs/mail-smtp-cutover-gate.md. code_ready is necessary but not sufficient.',
  };
}
