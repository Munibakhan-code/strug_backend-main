/**
 * Central mail configuration (Phase 1 + Phase 5 cutover prep).
 * Call sites must not read RESEND_* / SMTP env directly for send decisions.
 * EMAIL_PASSWORD is deprecated for generic SMTP; prefer SMTP_PASS.
 */

export const MAIL_PROVIDERS = Object.freeze(['resend', 'smtp']);

const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
});

let legacyPasswordWarned = false;

/**
 * @returns {'resend' | 'smtp'}
 */
export function getMailProvider() {
  const raw = (process.env.MAIL_PROVIDER || 'resend').trim().toLowerCase();
  if (!MAIL_PROVIDERS.includes(raw)) {
    throw new Error(
      `Unknown MAIL_PROVIDER "${raw}". Use one of: ${MAIL_PROVIDERS.join(', ')}`,
    );
  }
  return raw;
}

/**
 * Resolve From address for the active provider.
 * Prefer RESEND_FROM_EMAIL; fall back to EMAIL_USER.
 */
export function resolveFromAddress() {
  if (process.env.RESEND_FROM_EMAIL) {
    const raw = process.env.RESEND_FROM_EMAIL.trim();
    if (!raw) return null;
    if (raw.includes('<')) return raw;
    return `"Strug" <${raw}>`;
  }
  if (process.env.EMAIL_USER) {
    const raw = process.env.EMAIL_USER.trim();
    if (!raw) return null;
    return `"Strug Platform" <${raw}>`;
  }
  return null;
}

export function getRetryPolicy() {
  const maxAttempts = Number(process.env.MAIL_RETRY_MAX_ATTEMPTS);
  const baseDelayMs = Number(process.env.MAIL_RETRY_BASE_DELAY_MS);
  return {
    maxAttempts:
      Number.isFinite(maxAttempts) && maxAttempts > 0
        ? Math.floor(maxAttempts)
        : DEFAULT_RETRY.maxAttempts,
    baseDelayMs:
      Number.isFinite(baseDelayMs) && baseDelayMs >= 0
        ? Math.floor(baseDelayMs)
        : DEFAULT_RETRY.baseDelayMs,
  };
}

function warnLegacyEmailPasswordOnce() {
  if (legacyPasswordWarned) return;
  legacyPasswordWarned = true;
  console.warn(
    '[Mail] EMAIL_PASSWORD is deprecated for SMTP. Set SMTP_PASS instead (EMAIL_PASSWORD still works as a temporary fallback).',
  );
}

/**
 * SMTP transport settings.
 * Resend's SMTP endpoint (`smtp.resend.com`) requires username `resend` and the
 * API key as the password. Prefer SMTP_USER / SMTP_PASS for other relays.
 * @returns {{ host: string, port: number, secure: boolean, user: string, pass: string, legacy_email_password: boolean }}
 */
export function getSmtpConfig() {
  const host = (process.env.SMTP_HOST || 'smtp.resend.com').trim();
  const port = Number(process.env.SMTP_PORT || 465);
  const secure =
    process.env.SMTP_SECURE === 'false'
      ? false
      : process.env.SMTP_SECURE === 'true'
        ? true
        : port === 465;

  const isResendSmtp = /(?:^|\.)resend\.com$/i.test(host);
  const user = (
    process.env.SMTP_USER ||
    (isResendSmtp ? 'resend' : process.env.EMAIL_USER) ||
    ''
  ).trim();

  const smtpPass = (process.env.SMTP_PASS || '').trim();
  const legacyPass = (process.env.EMAIL_PASSWORD || '').trim();
  // Resend SMTP password must be the API key. Prefer SMTP_PASS, then RESEND_API_KEY.
  // Do not fall back to EMAIL_PASSWORD on *.resend.com (legacy SMTP leftovers break auth).
  let pass = smtpPass;
  let legacy_email_password = false;
  if (!pass) {
    if (isResendSmtp) {
      pass = (process.env.RESEND_API_KEY || '').trim();
    } else if (legacyPass) {
      pass = legacyPass;
      legacy_email_password = true;
      warnLegacyEmailPasswordOnce();
    }
  }

  return { host, port, secure, user, pass, legacy_email_password };
}

/**
 * Whether the active provider has enough env to attempt a send.
 */
export function isMailConfigured() {
  const from = resolveFromAddress();
  if (!from) return false;
  try {
    const provider = getMailProvider();
    if (provider === 'resend') {
      return Boolean((process.env.RESEND_API_KEY || '').trim());
    }
    const smtp = getSmtpConfig();
    return Boolean(smtp.host && smtp.user && smtp.pass);
  } catch {
    return false;
  }
}

/**
 * Whether SMTP env alone would be enough (cutover-status; does not flip provider).
 */
export function isSmtpEnvConfigured() {
  if (!resolveFromAddress()) return false;
  try {
    const smtp = getSmtpConfig();
    return Boolean(smtp.host && smtp.user && smtp.pass);
  } catch {
    return false;
  }
}

export function getMailConfigSnapshot() {
  let provider;
  try {
    provider = getMailProvider();
  } catch (err) {
    provider = `invalid:${err.message}`;
  }
  let smtp = null;
  try {
    smtp = getSmtpConfig();
  } catch {
    smtp = null;
  }
  return {
    provider,
    from: resolveFromAddress(),
    configured: isMailConfigured(),
    retry: getRetryPolicy(),
    smtp_legacy_email_password: Boolean(smtp?.legacy_email_password),
  };
}

/** Test helper */
export function __resetMailConfigWarningsForTests() {
  legacyPasswordWarned = false;
}
