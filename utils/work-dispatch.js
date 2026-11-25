import prisma from './prisma-client.js';
import { haversineKm } from './ride-dispatch.js';
import { creditWorkWallet } from './work-wallet.js';
import { notifyWork } from './work-notify.js';
import { logCronError } from './cron-email.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleInterval } from './cron-lock.js';

// On-Demand Work dispatch foundation (M2: availability + candidate query).
// Mirrors utils/ride-dispatch.js but adds a CATEGORY filter so a worker is only ever
// offered jobs in a category they've added. The offer-and-wait loop + cron arrive in M3.
export const WORK_SEARCH_RADIUS_KM = Number(process.env.WORK_SEARCH_RADIUS_KM || 10);
export const WORKER_OFFER_TIMEOUT_SEC = Number(process.env.WORK_WORKER_OFFER_TIMEOUT_SEC || 45);

// A worker is reachable if online (is_available) or pinged in the last 2 min, AND has
// added the job's category. Optionally exclude workers who already declined/timed out.
function availableWorkerWhere(categoryId, excludedWorkerProfileIds = [], excludeUserId = null) {
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
  const where = {
    AND: [
      { OR: [{ is_available: true }, { last_ping: { gt: twoMinutesAgo } }] },
      { worker_category: { some: { work_category_id: Number(categoryId) } } },
    ],
  };
  if (excludedWorkerProfileIds.length) {
    where.AND.push({ worker_profile_id: { notIn: excludedWorkerProfileIds } });
  }
  // Never match a hirer to their own worker profile — a user cannot fulfil the job they
  // just booked. Without this a solo user (hirer + worker on one account) gets offered
  // their own job, and a worker could "accept" their own booking.
  if (excludeUserId != null) {
    where.AND.push({ user_id: { not: Number(excludeUserId) } });
  }
  return where;
}

// Count of reachable workers in a category — used by the booking availability guard
// (do not let a hirer pay if nobody can take the job; mirrors rideshare's no-driver 503).
export async function countAvailableWorkersInCategory(categoryId, excludedWorkerProfileIds = [], excludeUserId = null) {
  if (!categoryId) return 0;
  return prisma.worker_profile.count({ where: availableWorkerWhere(categoryId, excludedWorkerProfileIds, excludeUserId) });
}

// Nearest-first list of reachable workers in a category within the radius (bounding-box
// pre-filter + Haversine sort, like rideshare). Falls back to all reachable-in-category if
// none are inside the box. M3's offer loop consumes this.
// Workers are sorted by reliability score (highest first), then by distance (nearest first).
export async function findWorkerCandidates(lat, lng, categoryId, excludedWorkerProfileIds = [], excludeUserId = null) {
  if (lat == null || lng == null || !categoryId) return [];
  const latDelta = WORK_SEARCH_RADIUS_KM / 111;
  const longDelta = WORK_SEARCH_RADIUS_KM / (111 * Math.cos((lat * Math.PI) / 180));
  let candidates = await prisma.worker_profile.findMany({
    where: {
      ...availableWorkerWhere(categoryId, excludedWorkerProfileIds, excludeUserId),
      current_lat: { gte: lat - latDelta, lte: lat + latDelta },
      current_long: { gte: lng - longDelta, lte: lng + longDelta },
    },
  });
  if (candidates.length === 0) {
    candidates = await prisma.worker_profile.findMany({ where: availableWorkerWhere(categoryId, excludedWorkerProfileIds, excludeUserId) });
  }
  return candidates
    .map((w) => ({ ...w, distance_km: haversineKm(lat, lng, w.current_lat ?? lat, w.current_long ?? lng) }))
    .sort((a, b) => {
      // Sort by reliability score (highest first), then by distance (nearest first)
      const reliabilityDiff = (b.reliability_score || 100) - (a.reliability_score || 100);
      if (reliabilityDiff !== 0) return reliabilityDiff;
      return a.distance_km - b.distance_km;
    });
}

// ── Dispatch loop (M3) — clones ride-dispatch's offer-and-wait, but offers to the
// nearest worker who has ADDED the job's category. Active dispatch status = 'searching'
// (mirrors rideshare 'pending'); assigned_worker_id + offer_expires_at track the live offer. ──

function fmtDistanceKm(km) {
  if (!Number.isFinite(km)) return '—';
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}
function fmtEtaMin(km) {
  return `~${Math.max(1, Math.round((km / 30) * 60))} min`;
}

// What the worker sees in an offer. Payout is the NET (after 8% fee + tax). Exact address
// is included only post-accept on the FE; the offer carries the approx address string.
export function buildWorkOfferPayload(job, distanceKm) {
  return {
    work_job_id: job.work_job_id,
    category_id: job.category_id,
    title: job.title,
    instructions: job.instructions,
    address: job.address,
    scheduled_start: job.scheduled_start,
    scheduled_end: job.scheduled_end,
    price_type: job.price_type,
    worker_payout: job.worker_payout,
    photos: job.photos || [],
    distance: fmtDistanceKm(distanceKm),
    eta: fmtEtaMin(distanceKm),
    expires_at: job.offer_expires_at?.toISOString?.() ?? null,
    offer_timeout_sec: WORKER_OFFER_TIMEOUT_SEC,
  };
}

function emitWorkOffer(io, userId, payload) {
  io?.to(`user-${userId}`).emit(`work-offer-${userId}`, payload);
}

// Direct offers debit the hirer up front (decline and timeout both refund).
// external_ref is unique per job so a decline/timeout race (or overlapping cron)
// cannot credit twice — a second insert hits wallet_transaction.external_ref UNIQUE.
async function refundDirectWorkOffer(job, reason) {
  if (!job?.hirer_id) return;
  const total = Number(job.hirer_set_price) || 0;
  if (!(total > 0)) return;
  try {
    await creditWorkWallet(
      job.hirer_id,
      total,
      'ondemand_direct_offer_refund',
      `Refund — direct offer #${job.work_job_id} ${reason}`,
      `direct_offer_refund:${job.work_job_id}`,
    );
  } catch (refundErr) {
    if (refundErr?.code === 'P2002') return;
    console.error('[work-dispatch] Failed to refund direct offer:', refundErr);
  }
}

async function assignAndEmitWorkOffer(io, job, candidates) {
  if (!candidates.length) return null;
  const nearest = candidates[0];
  const offerExpiresAt = new Date(Date.now() + WORKER_OFFER_TIMEOUT_SEC * 1000);
  const updated = await prisma.work_job.update({
    where: { work_job_id: job.work_job_id },
    data: { assigned_worker_id: nearest.worker_profile_id, offer_expires_at: offerExpiresAt, status: 'searching' },
  });
  await prisma.work_job_offer
    .create({ data: { work_job_id: job.work_job_id, worker_profile_id: nearest.worker_profile_id, response: 'pending' } })
    .catch(() => {});
  if (nearest.user_id) {
    const offerPayload = buildWorkOfferPayload(updated, nearest.distance_km);
    emitWorkOffer(io, nearest.user_id, offerPayload);
    // Writes the legacy work_notification row AND mirrors into the unified bell (see work-notify.js).
    // `unified` carries what only this site knows: the offer payload the ClaimCard renders and the
    // expiry that auto-dismisses it when the offer rolls to the next worker.
    notifyWork(io, nearest.user_id, 'offer', {
      work_job_id: updated.work_job_id,
      params: { jobTitle: updated.title || '', payout: Number(updated.worker_payout || 0).toFixed(2) },
      unified: { body: updated.title || null, data: offerPayload, expiresAt: offerExpiresAt },
    });
  }
  return nearest.worker_profile_id;
}

// Offer the job to the next nearest eligible worker; mark 'no_match' if none remain.
export async function dispatchWorkToNextWorker(io, job, excludedWorkerProfileIds = []) {
  if (!job || job.location_lat == null || job.location_long == null || !job.category_id) return null;
  const candidates = await findWorkerCandidates(job.location_lat, job.location_long, job.category_id, excludedWorkerProfileIds, job.hirer_id);
  if (candidates.length === 0) {
    await prisma.work_job.update({ where: { work_job_id: job.work_job_id }, data: { status: 'no_match', assigned_worker_id: null, offer_expires_at: null } });
    // The hirer was charged at submit — refund the full amount since nobody took the job.
    if (job.hirer_id && Number(job.hirer_set_price) > 0) {
      await creditWorkWallet(job.hirer_id, Number(job.hirer_set_price), 'ondemand_work_refund', `Refund — booking #${job.work_job_id} (no worker matched)`).catch(() => {});
    }
    if (job.hirer_id) {
      io?.to(`user-${job.hirer_id}`).emit(`work-no-match-${job.hirer_id}`, { work_job_id: job.work_job_id, message: 'No workers available to accept this job.' });
      notifyWork(io, job.hirer_id, 'no_match', { work_job_id: job.work_job_id, params: { jobTitle: job.title || '' } });
    }
    return null;
  }
  return assignAndEmitWorkOffer(io, job, candidates);
}

export async function reofferWorkAfterDecline(io, jobId, decliningWorkerProfileId) {
  // Worker declined → exclude them, mark the offer declined, re-offer to nearest (or handle direct offer).
  const job = await prisma.work_job.findUnique({ where: { work_job_id: Number(jobId) } });
  if (!job) return { reoffered: false };

  // Accept both "offered" (direct) and "searching" (dispatched) as active offer states
  const isActiveOffer = job.status === 'offered' || job.status === 'searching';
  if (!isActiveOffer) return { reoffered: false };

  // Ensure the declining worker is the one currently assigned the offer
  if (job.assigned_worker_id !== Number(decliningWorkerProfileId)) {
    return { reoffered: false };
  }

  // Remember whether this was a direct offer – we’ll use it for special handling
  const isDirectOffer = job.status === 'offered';

  const excluded = [...new Set([...(job.declined_worker_ids || []).map(Number), Number(decliningWorkerProfileId)])];

  // 1️⃣ Mark the specific worker’s offer as declined
  const updateOfferResult = await prisma.work_job_offer.updateMany({
    where: {
      work_job_id: job.work_job_id,
      worker_profile_id: Number(decliningWorkerProfileId),
      response: 'pending'
    },
    data: { response: 'declined', responded_at: new Date() }
  });

  // If no pending offer was found for this worker, treat as no-op (idempotent)
  if (updateOfferResult.count === 0) {
    return { reoffered: false };
  }

  // 2️⃣ Clear the current offer on the job and record the decliner
  await prisma.work_job.update({
    where: { work_job_id: job.work_job_id },
    data: {
      declined_worker_ids: excluded,
      // For direct offers we do NOT re‑offer automatically; we clear the live offer
      // so the hirer can pick another worker or cancel.
      assigned_worker_id: null,
      offer_expires_at: null
      // Keep status as is ('offered' or 'searching') – the hirer’s UI can interpret it.
    }
  });
  // Emit a status update to the hirer so UI can refresh the job card (e.g., clear assigned worker).
  if (job.hirer_id && io) {
    io?.to(`user-${job.hirer_id}`).emit(`work-status-${job.work_job_id}`, {
      work_job_id: job.work_job_id,
      status: job.status
    });
  }

  // 3️⃣ Handle direct‑offer specifics: refund hirer and notify (no auto re‑offer)
  if (isDirectOffer && job.hirer_id) {
    await refundDirectWorkOffer(job, 'declined');
    // Notify the hirer so the UI can show “Worker declined – choose another worker”.
    // notifyWork is safe with optional chaining (io may be null/falsy)
    notifyWork(io, job.hirer_id, 'offer_declined_direct', {
      work_job_id: job.work_job_id,
      params: { jobTitle: job.title || '' }
    });
    // Emit a socket event for immediate UI update (only if io is present)
    if (io) {
      io?.to(`user-${job.hirer_id}`).emit(`work-offer-declined-${job.work_job_id}`, {
        work_job_id: job.work_job_id,
        worker_profile_id: Number(decliningWorkerProfileId),
        response: 'declined',
        responded_at: new Date()
      });
    }
    // For direct offers we do NOT attempt to re‑offer another worker.
    return { reoffered: false };
  }

  // 4️⃣ For dispatched offers (status === 'searching') try to offer to the next eligible worker
  const refreshed = await prisma.work_job.findUnique({ where: { work_job_id: job.work_job_id } });
  if (refreshed?.status !== 'searching') return { reoffered: false };

  const next = await dispatchWorkToNextWorker(io, refreshed, excluded);
  return { reoffered: !!next, next_worker_id: next };
}

// Offer timed out → treat as a decline (Codezero: no response acts like a decline) and
// move to the next nearest worker; mark 'no_match' if exhausted.
export async function processExpiredWorkOffers(io) {
  const now = new Date();
  const expired = await prisma.work_job.findMany({
    where: { status: { in: ['offered', 'searching'] }, assigned_worker_id: { not: null }, offer_expires_at: { lt: now } },
  });
  for (const job of expired) {
    const timedOut = job.assigned_worker_id;
    const excluded = [...new Set([...(job.declined_worker_ids || []).map(Number), Number(timedOut)])];
    // Claim the live offer row — overlapping crons and accept/decline races must not
    // proceed from the findMany snapshot. Postgres serializes concurrent updateMany
    // on the same row; count !== 1 means another path already took it.
    const claim = await prisma.work_job.updateMany({
      where: {
        work_job_id: job.work_job_id,
        assigned_worker_id: timedOut,
        offer_expires_at: { lt: now },
        status: { in: ['offered', 'searching'] },
      },
      data: { declined_worker_ids: excluded, assigned_worker_id: null, offer_expires_at: null },
    });
    if (claim.count !== 1) continue;

    const updateOfferResult = await prisma.work_job_offer.updateMany({
      where: { work_job_id: job.work_job_id, worker_profile_id: timedOut, response: 'pending' },
      data: { response: 'timeout', responded_at: now },
    });
    // Decline (and accept) already flipped the pending offer — bail so we don't
    // refund or re-dispatch a job another path owns.
    if (updateOfferResult.count !== 1) continue;

    // Notify hirer that the worker did not respond (offer timed out)
    if (job.hirer_id) {
      notifyWork(io, job.hirer_id, 'offer_timeout', {
        work_job_id: job.work_job_id,
        params: { jobTitle: job.title || '' }
      });
    }
    // Emit socket event for immediate UI update
    if (io && job.hirer_id) {
      io?.to(`user-${job.hirer_id}`).emit(`work-offer-timeout-${job.work_job_id}`, {
        work_job_id: job.work_job_id,
        worker_profile_id: timedOut,
        response: 'timeout',
        responded_at: now
      });
    }
    // Direct offers (including 48h catalog / Book Artist) were charged up front.
    // Decline refunds; timeout must too — otherwise an ignored offer keeps the money.
    if (job.status === 'offered') {
      await refundDirectWorkOffer(job, 'timed out');
    }
    const refreshed = await prisma.work_job.findUnique({ where: { work_job_id: job.work_job_id } });
    // For direct offers, we don't automatically re-offer another worker
    // Only for dispatched offers (status === 'searching') do we try the next worker
    if (refreshed?.status === 'searching') {
      await dispatchWorkToNextWorker(io, refreshed, excluded);
    }
    // For direct offers (status === 'offered'), the offer is cleared and the hirer is refunded.
  }
}

export function startWorkDispatchCron(io) {
  scheduleInterval('work-dispatch', () => {
    processExpiredWorkOffers(io).catch((err) => logCronError('work-dispatch', err));
  }, 5000);
}

// Pending offers currently extended to this worker (for the worker's offer inbox / polling).
export async function getIncomingWorkOffers(workerProfileId) {
  const now = new Date();
  const profile = await prisma.worker_profile.findUnique({ where: { worker_profile_id: Number(workerProfileId) } });
  if (!profile) return [];
  const jobs = await prisma.work_job.findMany({
    where: { status: { in: ['offered', 'searching'] }, assigned_worker_id: Number(workerProfileId), OR: [{ offer_expires_at: { gt: now } }, { offer_expires_at: null }] },
    orderBy: { created_at: 'desc' },
    take: 20,
    include: { work_category: { select: { name: true, slug: true } } },
  });
  return jobs.map((j) => {
    const d = haversineKm(j.location_lat ?? 0, j.location_long ?? 0, profile.current_lat ?? 0, profile.current_long ?? 0);
    return { ...buildWorkOfferPayload(j, d), category: j.work_category?.name };
  });
}
