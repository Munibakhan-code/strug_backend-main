import nodemailer from 'nodemailer';
import { resolveFromAddress, getRetryPolicy, getSmtpConfig } from '../config.js';

let transporter = null;

function getTransporter() {
  const smtp = getSmtpConfig();
  if (!smtp.user || !smtp.pass) {
    throw new Error(
      'SMTP requires SMTP_USER/SMTP_PASS (or Resend SMTP via RESEND_API_KEY). EMAIL_PASSWORD is deprecated.',
    );
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
    });
  }
  return transporter;
}

/** Map facade attachments to nodemailer (CID → cid). */
export function mapAttachmentsForSmtp(attachments) {
  if (!attachments?.length) return undefined;
  return attachments.map((a) => {
    const mapped = {
      filename: a.filename,
      contentType: a.contentType || a.content_type || 'image/png',
    };
    if (a.content) {
      mapped.content = Buffer.from(a.content, 'base64');
      mapped.encoding = 'base64';
    } else if (a.path) {
      mapped.path = a.path;
    }
    const cid = a.contentId || a.content_id;
    if (cid) mapped.cid = cid;
    return mapped;
  });
}

function isTransientSmtpError(err) {
  const msg = err?.message || String(err);
  const code = err?.code || err?.responseCode;
  const isRateLimited = code === 429 || /rate.?limit|too many/i.test(msg);
  const transient =
    isRateLimited ||
    /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket|421|450|451|452/i.test(
      `${code ?? ''} ${msg}`,
    );
  return { transient, isRateLimited, msg };
}

/**
 * @param {{ to: string|string[], subject: string, html: string, text?: string, attachments?: object[], headers?: object }} options
 */
export async function sendViaSmtp({ to, subject, html, text, attachments, headers }) {
  const fromAddress = resolveFromAddress();
  if (!fromAddress) {
    throw new Error(
      'Set RESEND_FROM_EMAIL or EMAIL_USER for SMTP From address',
    );
  }

  const mail = {
    from: fromAddress,
    to,
    subject,
    html,
  };
  if (text) mail.text = text;
  const mapped = mapAttachmentsForSmtp(attachments);
  if (mapped) mail.attachments = mapped;
  if (headers && typeof headers === 'object') mail.headers = headers;

  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const transport = getTransporter();
  const { maxAttempts, baseDelayMs } = getRetryPolicy();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const info = await transport.sendMail(mail);
      console.log(
        `📧 [SUCCESS] Email sent via SMTP to ${recipients} (id: ${info.messageId ?? 'n/a'})`,
      );
      return {
        id: info.messageId ?? null,
        provider: 'smtp',
        raw: info,
      };
    } catch (err) {
      const { transient, isRateLimited, msg } = isTransientSmtpError(err);
      if (transient && attempt < maxAttempts) {
        const backoffMs = baseDelayMs * 2 ** (attempt - 1);
        console.warn(
          `⚠️ [SMTP RETRY ${attempt}/${maxAttempts}] ${isRateLimited ? 'rate-limited' : 'transient error'} — retrying in ${backoffMs}ms: ${msg}`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      console.error('❌ [SMTP ERROR]:', msg);
      throw new Error(msg);
    }
  }
}

export function __resetSmtpTransportForTests() {
  transporter = null;
}
