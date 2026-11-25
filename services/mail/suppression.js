/**
 * Phase 5: mail suppression list (bounce / complaint / manual).
 */
import prisma from '../../utils/prisma-client.js';
import { hashMailRecipient, hintMailRecipient, sanitizeMailText } from './send-log.js';

export const SUPPRESSION_REASONS = Object.freeze([
  'bounce',
  'complaint',
  'manual',
  'unsubscribe',
]);

/**
 * @param {string|string[]} to
 * @returns {Promise<boolean>}
 */
export async function isMailSuppressed(to) {
  const hash = hashMailRecipient(to);
  if (!hash || hash.length < 16) return false;
  const row = await prisma.mail_suppression.findUnique({
    where: { to_hash: hash },
    select: { active: true },
  });
  return Boolean(row?.active);
}

/**
 * @param {{
 *   to: string|string[],
 *   reason: string,
 *   source?: string|null,
 *   note?: string|null,
 * }} opts
 */
export async function upsertMailSuppression({ to, reason, source = null, note = null }) {
  const r = String(reason || '').trim().toLowerCase();
  if (!SUPPRESSION_REASONS.includes(r)) {
    throw new Error(`Invalid suppression reason "${reason}"`);
  }
  const to_hash = hashMailRecipient(to);
  const to_hint = hintMailRecipient(to).slice(0, 128);
  return prisma.mail_suppression.upsert({
    where: { to_hash },
    create: {
      to_hash,
      to_hint,
      reason: r,
      source: source ? String(source).slice(0, 64) : null,
      note: sanitizeMailText(note, 500),
      active: true,
    },
    update: {
      to_hint,
      reason: r,
      source: source ? String(source).slice(0, 64) : null,
      note: sanitizeMailText(note, 500),
      active: true,
    },
  });
}

/**
 * Soft-deactivate a suppression (allows mail again).
 * @param {string} toHash
 */
export async function deactivateMailSuppression(toHash) {
  const hash = String(toHash || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error('Invalid suppression hash');
  }
  return prisma.mail_suppression.update({
    where: { to_hash: hash },
    data: { active: false },
  });
}

/**
 * @param {{ limit?: number, activeOnly?: boolean }} [opts]
 */
export async function listMailSuppressions({ limit = 50, activeOnly = true } = {}) {
  const take = Math.min(200, Math.max(1, Number(limit) || 50));
  return prisma.mail_suppression.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: { created_at: 'desc' },
    take,
    select: {
      id: true,
      created_at: true,
      to_hash: true,
      to_hint: true,
      reason: true,
      source: true,
      active: true,
      note: true,
    },
  });
}
