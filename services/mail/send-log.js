import crypto from 'crypto';
import prisma from '../../utils/prisma-client.js';

/**
 * Hash recipient for storage (no full address in the ledger).
 * @param {string | string[]} to
 */
export function hashMailRecipient(to) {
  const primary = Array.isArray(to) ? String(to[0] || '') : String(to || '');
  const normalized = primary.trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Truncated hint for ops (e.g. u***@example.com). Never the full local-part.
 * @param {string | string[]} to
 */
export function hintMailRecipient(to) {
  const primary = Array.isArray(to) ? String(to[0] || '') : String(to || '');
  const normalized = primary.trim().toLowerCase();
  const at = normalized.indexOf('@');
  if (at <= 0) return normalized.slice(0, 1) + '***';
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * @param {Array<{ name?: string, value?: string }>|undefined} tags
 */
export function templateFromTags(tags) {
  if (!Array.isArray(tags)) return null;
  const hit = tags.find((t) => t?.name === 'template' && t?.value);
  return hit ? String(hit.value).slice(0, 100) : null;
}

/**
 * @param {Array<{ name?: string, value?: string }>|undefined} tags
 */
export function verticalFromTags(tags) {
  if (!Array.isArray(tags)) return null;
  const hit = tags.find((t) => t?.name === 'vertical' && t?.value);
  return hit ? String(hit.value).slice(0, 64) : null;
}

/**
 * Strip email-like tokens from free-text before ledger storage / Health API.
 * @param {string|null|undefined} text
 * @param {number} [maxLen=500]
 */
export function sanitizeMailText(text, maxLen = 500) {
  if (!text) return null;
  const scrubbed = String(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\s+/g, ' ')
    .trim();
  return scrubbed ? scrubbed.slice(0, maxLen) : null;
}

/** @deprecated Prefer sanitizeMailText */
export function sanitizeMailSubject(subject) {
  return sanitizeMailText(subject, 500);
}

/**
 * Best-effort persist of a send outcome. Never throws to callers.
 * @param {{
 *   provider: string,
 *   to: string|string[],
 *   subject?: string,
 *   template?: string|null,
 *   status: 'success'|'failure',
 *   provider_message_id?: string|null,
 *   error?: string|null,
 *   vertical?: string|null,
 *   tags?: object,
 * }} entry
 */
export async function recordMailSend(entry) {
  try {
    await prisma.mail_send_log.create({
      data: {
        provider: String(entry.provider || 'unknown').slice(0, 32),
        to_hash: hashMailRecipient(entry.to),
        to_hint: hintMailRecipient(entry.to).slice(0, 128),
        subject: sanitizeMailText(entry.subject, 500),
        template: entry.template ? String(entry.template).slice(0, 100) : null,
        status: String(entry.status || 'failure').slice(0, 32),
        provider_message_id: entry.provider_message_id
          ? String(entry.provider_message_id).slice(0, 255)
          : null,
        error: sanitizeMailText(entry.error, 1000),
        vertical: entry.vertical ? String(entry.vertical).slice(0, 64) : null,
        tags: entry.tags ?? undefined,
      },
    });
  } catch (err) {
    console.warn('[Mail Health] failed to write send log:', err?.message || err);
  }
}

/**
 * Aggregate last N hours + recent failures for admin Health.
 * @param {{ hours?: number, recentLimit?: number }} [opts]
 */
export async function getMailHealthSummary({ hours = 24, recentLimit = 25 } = {}) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const whereSince = { created_at: { gte: since } };

  const [total, success, failure, recentFailures, recent] = await Promise.all([
    prisma.mail_send_log.count({ where: whereSince }),
    prisma.mail_send_log.count({ where: { ...whereSince, status: 'success' } }),
    prisma.mail_send_log.count({ where: { ...whereSince, status: 'failure' } }),
    prisma.mail_send_log.findMany({
      where: { ...whereSince, status: 'failure' },
      orderBy: { created_at: 'desc' },
      take: recentLimit,
      select: {
        id: true,
        created_at: true,
        provider: true,
        to_hint: true,
        subject: true,
        template: true,
        status: true,
        provider_message_id: true,
        error: true,
        vertical: true,
      },
    }),
    prisma.mail_send_log.findMany({
      where: whereSince,
      orderBy: { created_at: 'desc' },
      take: recentLimit,
      select: {
        id: true,
        created_at: true,
        provider: true,
        to_hint: true,
        subject: true,
        template: true,
        status: true,
        provider_message_id: true,
        error: true,
        vertical: true,
      },
    }),
  ]);

  return {
    window_hours: hours,
    counts: { total, success, failure },
    recent_failures: recentFailures,
    recent,
  };
}

/**
 * Join registry catalog with last send status per template (Phase 3 Organization).
 * @param {{ hours?: number }} [opts]
 */
export async function getMailCatalog({ hours = 168 } = {}) {
  const { EMAIL_TEMPLATE_REGISTRY } = await import('../../scripts/email-template-registry.js');
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const recentByTemplate = await prisma.mail_send_log.findMany({
    where: {
      created_at: { gte: since },
      template: { not: null },
    },
    orderBy: { created_at: 'desc' },
    select: {
      template: true,
      status: true,
      created_at: true,
      provider: true,
      provider_message_id: true,
      error: true,
    },
  });

  const lastByTemplate = new Map();
  for (const row of recentByTemplate) {
    if (!row.template || lastByTemplate.has(row.template)) continue;
    lastByTemplate.set(row.template, row);
  }

  const templates = EMAIL_TEMPLATE_REGISTRY.map((row) => {
    const last = lastByTemplate.get(row.template) || null;
    return {
      template: row.template,
      subjectKey: row.subjectKey,
      trigger: row.trigger,
      vertical: row.vertical,
      owner: row.owner,
      audience: row.audience,
      priority: row.priority,
      last_send: last
        ? {
            status: last.status,
            created_at: last.created_at,
            provider: last.provider,
            provider_message_id: last.provider_message_id,
            error: last.error,
          }
        : null,
    };
  });

  const byVertical = {};
  for (const t of templates) {
    byVertical[t.vertical] = (byVertical[t.vertical] || 0) + 1;
  }

  return {
    window_hours: hours,
    total: templates.length,
    by_vertical: byVertical,
    templates,
  };
}
