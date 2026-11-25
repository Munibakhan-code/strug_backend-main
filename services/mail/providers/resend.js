import { Resend } from 'resend';
import { resolveFromAddress, getRetryPolicy } from '../config.js';

let resendClient = null;

function getResendClient() {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not set in environment variables');
  }
  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }
  return resendClient;
}

/** Map facade attachments to Resend payload shape (incl. CID). */
export function mapAttachmentsForResend(attachments) {
  if (!attachments?.length) return undefined;
  return attachments.map((a) => ({
    filename: a.filename,
    ...(a.content ? { content: a.content } : {}),
    ...(a.path ? { path: a.path } : {}),
    contentType: a.contentType || a.content_type || 'image/png',
    ...(a.contentId || a.content_id
      ? { contentId: a.contentId || a.content_id }
      : {}),
  }));
}

function isTransientError(sendError) {
  const status = sendError.statusCode ?? sendError.status;
  const msg = sendError.message || sendError.name || JSON.stringify(sendError);
  const isRateLimited =
    status === 429 || /rate.?limit|too many|quota/i.test(`${sendError.name ?? ''} ${msg}`);
  const transient =
    isRateLimited ||
    /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket/i.test(msg);
  return { transient, isRateLimited, msg, status };
}

/**
 * @param {{ to: string|string[], subject: string, html: string, text?: string, attachments?: object[], tags?: object[], headers?: object }} options
 */
export async function sendViaResend({ to, subject, html, text, attachments, tags, headers }) {
  const fromAddress = resolveFromAddress();
  if (!fromAddress) {
    throw new Error(
      'Set RESEND_FROM_EMAIL (e.g. mail@strug.ca) in environment variables',
    );
  }

  const payload = {
    from: fromAddress,
    to,
    subject,
    html,
  };
  if (text) payload.text = text;
  const mapped = mapAttachmentsForResend(attachments);
  if (mapped) payload.attachments = mapped;
  if (tags?.length) payload.tags = tags;
  if (headers && typeof headers === 'object') payload.headers = headers;

  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const resend = getResendClient();
  const { maxAttempts, baseDelayMs } = getRetryPolicy();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let sendError = null;
    let data = null;
    try {
      const res = await resend.emails.send(payload);
      data = res.data;
      sendError = res.error;
    } catch (err) {
      sendError = err;
    }

    if (!sendError) {
      console.log(
        `📧 [SUCCESS] Email sent via Resend to ${recipients} (id: ${data?.id ?? 'n/a'})`,
      );
      return { id: data?.id ?? null, provider: 'resend', raw: data };
    }

    const { transient, isRateLimited, msg } = isTransientError(sendError);

    if (transient && attempt < maxAttempts) {
      const backoffMs = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `⚠️ [RESEND RETRY ${attempt}/${maxAttempts}] ${isRateLimited ? 'rate-limited' : 'transient error'} — retrying in ${backoffMs}ms: ${msg}`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }

    if (isRateLimited) {
      console.error(
        `🚫 [RESEND QUOTA/RATE-LIMIT] email to ${recipients} NOT sent after ${attempt} attempt(s). Free tier is 100/day — upgrade the Resend plan or wait for reset: ${msg}`,
      );
    } else {
      console.error('❌ [RESEND ERROR]:', msg);
    }
    throw new Error(msg);
  }
}

/** Domain verification check (Resend only). */
export async function logResendDomainStatus() {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    console.warn('[Resend] RESEND_API_KEY missing — emails will fail');
    return;
  }
  const fromAddress = resolveFromAddress();
  console.log(`[Resend] Configured sender: ${fromAddress}`);

  try {
    const resend = getResendClient();
    const { data, error } = await resend.domains.list();
    if (error) {
      console.warn('[Resend] Domain list failed:', error.message);
      return;
    }

    const domains = data?.data ?? [];
    if (!domains.length) {
      console.warn(
        '[Resend] No domains on this API key — add strug.ca at https://resend.com/domains',
      );
      return;
    }

    for (const d of domains) {
      console.log(`[Resend] Domain "${d.name}" → status: ${d.status}`);
    }

    const rawFrom = process.env.RESEND_FROM_EMAIL?.trim() || '';
    const domainPart = rawFrom.includes('@') ? rawFrom.split('@').pop() : '';
    if (domainPart) {
      const match = domains.find((d) => d.name === domainPart);
      if (!match) {
        console.warn(
          `[Resend] "${domainPart}" is not in this account — fix RESEND_FROM_EMAIL or API key`,
        );
      } else if (match.status !== 'verified') {
        console.warn(
          `[Resend] "${domainPart}" is "${match.status}" — click Verify in Resend dashboard or wait for DNS`,
        );
      } else {
        console.log(`[Resend] ✓ "${domainPart}" is verified — ready to send`);
      }
    }
  } catch (err) {
    console.warn('[Resend] Startup check error:', err.message);
  }
}

/** Test seam: reset lazy client between unit tests. */
export function __resetResendClientForTests() {
  resendClient = null;
}
