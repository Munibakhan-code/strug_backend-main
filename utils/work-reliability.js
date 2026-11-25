/**
 * Reliability scoring for the On-demand Jobs vertical.
 *
 * Every worker_profile has a `reliability_score` (0–100, starts at 100) that
 * decays on certain negative events and is (slowly) restored by good behaviour.
 * The score is an INT — we avoid floats to keep the audit trail simple and
 * because there is no meaningful precision at the sub-integer level.
 *
 * Scoring rules (from the spec):
 *   • No-show (worker accepted but never started)              –5
 *   • Late cancellation (< 2h before start)                    –3
 *   • Early cancellation (≥ 2h before start)                    0  (no penalty)
 *   • Successful completion (up to +1 / day)                    +1
 *
 * Every mutation writes a row to `reliability_audit` so the history is
 * always reconstructible.
 */

import prisma from './prisma-client.js';

const MIN_SCORE = 0;
const MAX_SCORE = 100;
const STREAK_DAYS = 30;

const PENALTIES = {
  no_show:           -5,
  late_cancel:        -3,
  early_cancel:        0,
};

const REWARDS = {
  completion:         +1,   // capped at +1 / day
};

/**
 * Load the current score for a worker profile.
 * Returns the score (0–100) or 100 if the profile has no score yet.
 */
async function getScore(workerProfileId) {
  const p = await prisma.worker_profile.findUnique({
    where: { worker_profile_id: workerProfileId },
    select: { reliability_score: true },
  });
  return p?.reliability_score ?? 100;
}

/**
 * Apply a reliability delta to a worker, clamped to [0, 100], and write
 * an audit trail entry.
 *
 * @param {object} opts
 * @param {number} opts.worker_profile_id
 * @param {number} opts.delta           Positive = reward, negative = penalty
 * @param {string} opts.reason          Short machine-readable key, e.g. 'no_show'
 * @param {string} [opts.reference_type]  Prisma model name, e.g. 'work_job'
 * @param {number} [opts.reference_id]    FK into that model
 * @returns {{ score_before, score_after, delta }}
 */
export async function adjustScore({ worker_profile_id, delta, reason, reference_type, reference_id }) {
  if (!worker_profile_id) throw new Error('worker_profile_id is required');
  const before = await getScore(worker_profile_id);
  const after = Math.max(MIN_SCORE, Math.min(MAX_SCORE, before + delta));

  await prisma.$transaction([
    prisma.worker_profile.update({
      where: { worker_profile_id },
      data: { reliability_score: after },
    }),
    prisma.reliability_audit.create({
      data: {
        worker_profile_id,
        delta,
        score_before: before,
        score_after: after,
        reason,
        reference_type: reference_type ?? null,
        reference_id: reference_id ?? null,
      },
    }),
  ]);

  return { score_before: before, score_after: after, delta };
}

/**
 * Convenience wrapper for the common penalty types. Keeps route code clean.
 * See PENALTIES map above for valid keys.
 */
export async function penalize(workerProfileId, key, referenceType, referenceId) {
  const delta = PENALTIES[key];
  if (delta == null) throw new Error(`Unknown penalty key: ${key}`);
  return adjustScore({
    worker_profile_id: workerProfileId,
    delta,
    reason: key,
    reference_type: referenceType,
    reference_id: referenceId,
  });
}

/**
 * Reward a worker for a completed job. The daily cap (+1 / day) is enforced
 * here before touching the DB — no point auditing a no-op.
 */
export async function rewardCompletion(workerProfileId, referenceId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Check if this worker already received a completion reward today.
  const already = await prisma.reliability_audit.findFirst({
    where: {
      worker_profile_id: workerProfileId,
      reason: 'completion',
      created_at: { gte: today },
    },
  });
  if (already) return null; // capped for today

  return adjustScore({
    worker_profile_id: workerProfileId,
    delta: REWARDS.completion,
    reason: 'completion',
    reference_type: 'work_job',
    reference_id: referenceId,
  });
}

/**
 * Reset a worker's score to 100 after STREAK_DAYS without any negative event.
 * Called by a scheduled job (cron) — not invoked inline.
 */
export async function resetAfterStreak(workerProfileId) {
  const cutoff = new Date(Date.now() - STREAK_DAYS * 24 * 60 * 60 * 1000);
  const recentPenalty = await prisma.reliability_audit.findFirst({
    where: {
      worker_profile_id: workerProfileId,
      delta: { lt: 0 },
      created_at: { gte: cutoff },
    },
  });
  if (recentPenalty) return null; // streak broken — no reset

  const before = await getScore(workerProfileId);
  if (before >= MAX_SCORE) return null; // already maxed

  const after = MAX_SCORE;
  await prisma.$transaction([
    prisma.worker_profile.update({
      where: { worker_profile_id: workerProfileId },
      data: { reliability_score: after },
    }),
    prisma.reliability_audit.create({
      data: {
        worker_profile_id: workerProfileId,
        delta: after - before,
        score_before: before,
        score_after: after,
        reason: 'streak_reset',
      },
    }),
  ]);
  return { score_before: before, score_after: after, delta: after - before };
}

/**
 * Fetch the audit trail for a worker (newest first). Used by the worker-facing
 * "Reliability History" screen and the board's investigation panel.
 */
export async function getAuditTrail(workerProfileId, { limit = 50, offset = 0 } = {}) {
  return prisma.reliability_audit.findMany({
    where: { worker_profile_id: workerProfileId },
    orderBy: { created_at: 'desc' },
    take: limit,
    skip: offset,
  });
}

