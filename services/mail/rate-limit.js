/**
 * Phase 5: simple mail rate limits (per recipient + per template hour).
 * Uses mail_send_log counts so limits survive process restarts.
 */
import prisma from '../../utils/prisma-client.js';
import { hashMailRecipient, templateFromTags } from './send-log.js';

/** Templates that get a higher per-recipient cap (auth / money). */
export const CRITICAL_MAIL_TEMPLATES = Object.freeze([
  'otp',
  'password-reset',
  'password-change-success',
  'welcome',
  'shop-order-receipt',
  'food-order-receipt',
  'ride-receipt',
  'digital-delivery',
]);

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getMailRateLimits() {
  return {
    perRecipientHour: envInt('MAIL_RATE_PER_RECIPIENT_HOUR', 40),
    perRecipientHourCritical: envInt('MAIL_RATE_PER_RECIPIENT_HOUR_CRITICAL', 20),
    perTemplateHour: envInt('MAIL_RATE_PER_TEMPLATE_HOUR', 2000),
    windowMs: 60 * 60 * 1000,
  };
}

export function isCriticalMailTemplate(template) {
  if (!template) return false;
  return CRITICAL_MAIL_TEMPLATES.includes(String(template));
}

/**
 * @param {{ to: string|string[], tags?: Array<{name?:string,value?:string}> }} opts
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
 */
export async function checkMailRateLimit({ to, tags } = {}) {
  const limits = getMailRateLimits();
  const since = new Date(Date.now() - limits.windowMs);
  const to_hash = hashMailRecipient(to);
  const template = templateFromTags(tags);
  const recipientCap = isCriticalMailTemplate(template)
    ? limits.perRecipientHourCritical
    : limits.perRecipientHour;

  const [recipientCount, templateCount] = await Promise.all([
    prisma.mail_send_log.count({
      where: { to_hash, created_at: { gte: since } },
    }),
    template
      ? prisma.mail_send_log.count({
          where: { template, created_at: { gte: since } },
        })
      : Promise.resolve(0),
  ]);

  if (recipientCount >= recipientCap) {
    return {
      ok: false,
      code: 'MAIL_RATE_RECIPIENT',
      message: `Mail rate limit: too many messages to this recipient in the last hour (${recipientCap})`,
    };
  }

  if (template && templateCount >= limits.perTemplateHour) {
    return {
      ok: false,
      code: 'MAIL_RATE_TEMPLATE',
      message: `Mail rate limit: template "${template}" exceeded hourly budget (${limits.perTemplateHour})`,
    };
  }

  return { ok: true };
}
