/**
 * Phase 5: durable outbox for critical transactional mail (crash recovery).
 * Write-ahead before provider send; drain only retries rows stuck in `pending`
 * (process crash between enqueue and completion). Provider failures mark `failed`
 * without automatic payload retry (avoids double OTP when the user resends).
 */
import prisma from '../../utils/prisma-client.js';
import { encryptEmailForStorage, decrypt } from '../../utils/crypto.js';
import {
  hashMailRecipient,
  hintMailRecipient,
  sanitizeMailText,
  templateFromTags,
  verticalFromTags,
} from './send-log.js';
import { isCriticalMailTemplate } from './rate-limit.js';

/** Stuck pending rows older than this are assumed crash mid-send. */
function stalePendingMs() {
  const n = Number(process.env.MAIL_OUTBOX_STALE_MS);
  return Number.isFinite(n) && n >= 5000 ? Math.floor(n) : 120_000;
}

export function shouldUseMailOutbox(tags) {
  if (process.env.MAIL_OUTBOX_DISABLED === 'true' || process.env.MAIL_OUTBOX_DISABLED === '1') {
    return false;
  }
  return isCriticalMailTemplate(templateFromTags(tags));
}

/**
 * @param {{
 *   to: string|string[],
 *   subject: string,
 *   html: string,
 *   text?: string,
 *   tags?: Array<{name?:string,value?:string}>,
 *   headers?: Record<string,string>,
 * }} mail
 */
export async function enqueueMailOutbox(mail) {
  const primary = Array.isArray(mail.to) ? mail.to[0] : mail.to;
  const normalized = String(primary || '').trim().toLowerCase();
  if (!normalized) throw new Error('Outbox requires a recipient');

  return prisma.mail_outbox.create({
    data: {
      status: 'pending',
      attempts: 0,
      next_attempt_at: new Date(),
      to_hash: hashMailRecipient(normalized),
      to_hint: hintMailRecipient(normalized).slice(0, 128),
      to_ciphertext: encryptEmailForStorage(normalized),
      subject: String(mail.subject || '').slice(0, 500),
      template: templateFromTags(mail.tags),
      vertical: verticalFromTags(mail.tags),
      payload: {
        html: mail.html,
        text: mail.text ?? null,
        tags: mail.tags ?? null,
        headers: mail.headers ?? null,
      },
    },
  });
}

export async function markMailOutboxSent(id, providerMessageId) {
  return prisma.mail_outbox.update({
    where: { id: Number(id) },
    data: {
      status: 'sent',
      attempts: { increment: 1 },
      provider_message_id: providerMessageId
        ? String(providerMessageId).slice(0, 255)
        : null,
      sent_at: new Date(),
      last_error: null,
    },
  });
}

export async function markMailOutboxFailed(id, error, { suppressed = false } = {}) {
  return prisma.mail_outbox.update({
    where: { id: Number(id) },
    data: {
      status: suppressed ? 'suppressed' : 'failed',
      attempts: { increment: 1 },
      last_error: sanitizeMailText(error, 1000),
    },
  });
}

/**
 * @param {number} id
 * @param {{ deliver: (opts: object) => Promise<{ id: string|null, provider: string }> }} deps
 */
export async function processMailOutboxRow(id, { deliver }) {
  const row = await prisma.mail_outbox.findUnique({ where: { id: Number(id) } });
  if (!row) return { skipped: true, reason: 'missing' };
  if (row.status !== 'pending') return { skipped: true, reason: row.status };

  let to;
  try {
    to = decrypt(row.to_ciphertext);
  } catch {
    await markMailOutboxFailed(row.id, 'Failed to decrypt outbox recipient');
    return { ok: false, reason: 'decrypt' };
  }

  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  try {
    const result = await deliver({
      to,
      subject: row.subject,
      html: payload.html,
      text: payload.text || undefined,
      tags: payload.tags || undefined,
      headers: payload.headers || undefined,
      __skipOutbox: true,
      __fromOutbox: true,
    });
    await markMailOutboxSent(row.id, result?.id);
    return { ok: true, result };
  } catch (err) {
    const msg = err?.message || String(err);
    const suppressed = /MAIL_SUPPRESSED|suppressed/i.test(msg);
    await markMailOutboxFailed(row.id, msg, { suppressed });
    throw err;
  }
}

/**
 * Crash-recovery drain: only stale pending rows (never auto-retry provider failures).
 */
export async function drainMailOutbox({ deliver, limit = 20 } = {}) {
  const take = Math.min(100, Math.max(1, Number(limit) || 20));
  const staleBefore = new Date(Date.now() - stalePendingMs());
  const due = await prisma.mail_outbox.findMany({
    where: {
      status: 'pending',
      created_at: { lte: staleBefore },
    },
    orderBy: { created_at: 'asc' },
    take,
    select: { id: true },
  });

  const results = [];
  for (const row of due) {
    try {
      results.push({ id: row.id, ...(await processMailOutboxRow(row.id, { deliver })) });
    } catch (err) {
      results.push({ id: row.id, ok: false, error: err?.message || String(err) });
    }
  }
  return { scanned: due.length, results };
}

export async function getMailOutboxSummary({ hours = 24 } = {}) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const whereSince = { created_at: { gte: since } };
  const [pending, sent, failed, suppressed] = await Promise.all([
    prisma.mail_outbox.count({ where: { status: 'pending' } }),
    prisma.mail_outbox.count({ where: { ...whereSince, status: 'sent' } }),
    prisma.mail_outbox.count({ where: { ...whereSince, status: 'failed' } }),
    prisma.mail_outbox.count({ where: { ...whereSince, status: 'suppressed' } }),
  ]);
  return { window_hours: hours, counts: { pending, sent, failed, suppressed } };
}
