/**
 * Mail send facade (Phases 1–2 + Phase 5 hardening).
 * Single contract for product + ops mail. Providers: resend | smtp.
 * Phase 5: suppression check, rate limits, critical-mail outbox (crash recovery).
 */
import {
  getMailProvider,
  isMailConfigured,
  getMailConfigSnapshot,
  resolveFromAddress,
} from './mail/config.js';
import {
  sendViaResend,
  logResendDomainStatus,
  __resetResendClientForTests,
} from './mail/providers/resend.js';
import {
  sendViaSmtp,
  __resetSmtpTransportForTests,
} from './mail/providers/smtp.js';
import {
  recordMailSend,
  templateFromTags,
  verticalFromTags,
} from './mail/send-log.js';
import { isMailSuppressed } from './mail/suppression.js';
import { checkMailRateLimit } from './mail/rate-limit.js';
import {
  shouldUseMailOutbox,
  enqueueMailOutbox,
  markMailOutboxSent,
  markMailOutboxFailed,
} from './mail/outbox.js';

export {
  isMailConfigured,
  getMailProvider,
  getMailConfigSnapshot,
  resolveFromAddress,
};

/** @deprecated Prefer isMailConfigured(); kept for existing call sites. */
export function isResendConfigured() {
  return isMailConfigured();
}

async function deliverViaProvider({
  to,
  subject,
  html,
  text,
  attachments,
  tags,
  headers,
  provider,
}) {
  return provider === 'smtp'
    ? await sendViaSmtp({ to, subject, html, text, attachments, headers })
    : await sendViaResend({
        to,
        subject,
        html,
        text,
        attachments,
        tags,
        headers,
      });
}

/**
 * Send an email via the configured provider.
 * @param {{
 *   to: string | string[],
 *   subject: string,
 *   html: string,
 *   text?: string,
 *   attachments?: Array<object>,
 *   tags?: Array<{ name: string, value: string }>,
 *   headers?: Record<string, string>,
 *   __skipOutbox?: boolean,
 *   __fromOutbox?: boolean,
 * }} options
 * @returns {Promise<{ id: string|null, provider: string, raw?: unknown, outbox_id?: number }>}
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
  attachments,
  tags,
  headers,
  __skipOutbox = false,
  __fromOutbox = false,
}) {
  if (!to || !subject || !html) {
    throw new Error('sendEmail requires to, subject, and html');
  }

  const template = templateFromTags(tags);
  const vertical = verticalFromTags(tags);

  let provider;
  try {
    provider = getMailProvider();
  } catch (err) {
    await recordMailSend({
      provider: 'unknown',
      to,
      subject,
      template,
      vertical,
      status: 'failure',
      error: err.message,
      tags,
    });
    throw err;
  }

  if (!isMailConfigured()) {
    const msg = `Mail is not configured for provider "${provider}". Check MAIL_PROVIDER and provider credentials.`;
    await recordMailSend({
      provider,
      to,
      subject,
      template,
      vertical,
      status: 'failure',
      error: msg,
      tags,
    });
    throw new Error(msg);
  }

  // Phase 5 guards.
  if (await isMailSuppressed(to)) {
    const msg = 'MAIL_SUPPRESSED: recipient is on the do-not-send list';
    await recordMailSend({
      provider,
      to,
      subject,
      template,
      vertical,
      status: 'failure',
      error: msg,
      tags,
    });
    const err = new Error(msg);
    err.code = 'MAIL_SUPPRESSED';
    throw err;
  }

  // Outbox crash-recovery drain skips rate limits (row was already accepted).
  if (!__fromOutbox) {
    const rate = await checkMailRateLimit({ to, tags });
    if (!rate.ok) {
      await recordMailSend({
        provider,
        to,
        subject,
        template,
        vertical,
        status: 'failure',
        error: rate.message,
        tags,
      });
      const err = new Error(rate.message);
      err.code = rate.code;
      throw err;
    }
  }

  // Critical mail: write-ahead outbox, then send (crash recovery via drain).
  if (!__skipOutbox && shouldUseMailOutbox(tags)) {
    const row = await enqueueMailOutbox({
      to,
      subject,
      html,
      text,
      tags,
      headers,
    });
    try {
      const result = await deliverViaProvider({
        to,
        subject,
        html,
        text,
        attachments,
        tags,
        headers,
        provider,
      });
      await markMailOutboxSent(row.id, result.id);
      await recordMailSend({
        provider: result.provider || provider,
        to,
        subject,
        template,
        vertical,
        status: 'success',
        provider_message_id: result.id,
        tags,
      });
      console.log(
        JSON.stringify({
          event: 'mail.send',
          status: 'success',
          provider: result.provider || provider,
          template,
          message_id: result.id,
          outbox_id: row.id,
        }),
      );
      return { ...result, outbox_id: row.id };
    } catch (err) {
      const msg = err?.message || String(err);
      const suppressed = err?.code === 'MAIL_SUPPRESSED' || /MAIL_SUPPRESSED/i.test(msg);
      await markMailOutboxFailed(row.id, msg, { suppressed });
      await recordMailSend({
        provider,
        to,
        subject,
        template,
        vertical,
        status: 'failure',
        error: msg,
        tags,
      });
      console.error(
        JSON.stringify({
          event: 'mail.send',
          status: 'failure',
          provider,
          template,
          error: msg,
          outbox_id: row.id,
        }),
      );
      throw err;
    }
  }

  try {
    const result = await deliverViaProvider({
      to,
      subject,
      html,
      text,
      attachments,
      tags,
      headers,
      provider,
    });

    await recordMailSend({
      provider: result.provider || provider,
      to,
      subject,
      template,
      vertical,
      status: 'success',
      provider_message_id: result.id,
      tags,
    });

    console.log(
      JSON.stringify({
        event: 'mail.send',
        status: 'success',
        provider: result.provider || provider,
        template,
        message_id: result.id,
      }),
    );

    return result;
  } catch (err) {
    const msg = err?.message || String(err);
    await recordMailSend({
      provider,
      to,
      subject,
      template,
      vertical,
      status: 'failure',
      error: msg,
      tags,
    });
    console.error(
      JSON.stringify({
        event: 'mail.send',
        status: 'failure',
        provider,
        template,
        error: msg,
      }),
    );
    throw err;
  }
}

/** Log active provider + From; Resend domain check only when provider=resend. */
export async function logMailStartupStatus() {
  let snapshot;
  try {
    snapshot = getMailConfigSnapshot();
  } catch (err) {
    console.warn('[Mail] Invalid config:', err.message);
    return;
  }

  console.log(
    `[Mail] provider=${snapshot.provider} from=${snapshot.from ?? '(none)'} configured=${snapshot.configured}`,
  );

  if (!snapshot.configured) {
    console.warn(
      '[Mail] Not fully configured — transactional email will fail until env is set',
    );
    return;
  }

  if (snapshot.provider === 'resend') {
    await logResendDomainStatus();
  } else {
    console.log('[Mail] SMTP driver active — skipping Resend domain check');
  }
}

/** @deprecated Prefer logMailStartupStatus() */
export async function logResendStartupStatus() {
  return logMailStartupStatus();
}

/** Test helpers */
export function __resetMailClientsForTests() {
  __resetResendClientForTests();
  __resetSmtpTransportForTests();
}
