import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { computeWorkPricing, resolveWorkRegion } from '../utils/work-pricing.js';
import { countAvailableWorkersInCategory, dispatchWorkToNextWorker, WORKER_OFFER_TIMEOUT_SEC } from '../utils/work-dispatch.js';
import { catalogOfferExpiresAt } from '../utils/work-catalog-offer.js';
import { debitWorkWallet, creditWorkWallet, workerUserId } from '../utils/work-wallet.js';
import { notifyWork } from '../utils/work-notify.js';
import { penalize, rewardCompletion } from '../utils/work-reliability.js';
import { resolveRangeParam, resolveRange, RANGE_DAYS, buildEarningsSeries } from '../utils/analytics-buckets.js';

const router = express.Router();

const MIN_LEAD_MS = 30 * 60 * 1000; // job must start >= 30 min in the future
const MIN_DURATION_HRS = 1;         // minimum booking = 1 hour
const round2 = (n) => parseFloat(Number(n || 0).toFixed(2));

function validateJobInput(b, { allowMissingPrice = false } = {}) {
  const errors = [];
  if (!b.category_id) errors.push('category_id is required');
  const start = b.scheduled_start ? new Date(b.scheduled_start) : null;
  const end = b.scheduled_end ? new Date(b.scheduled_end) : null;
  if (!start || isNaN(start.getTime())) errors.push('scheduled_start is required (ISO datetime)');
  else if (start.getTime() < Date.now() + MIN_LEAD_MS) errors.push('scheduled_start must be at least 30 minutes in the future');
  if (!end || isNaN(end.getTime())) errors.push('scheduled_end is required (ISO datetime)');
  else if (start && end.getTime() - start.getTime() < MIN_DURATION_HRS * 3600 * 1000) errors.push('scheduled_end must be at least 1 hour after scheduled_start');
  const priceType = b.price_type === 'hourly' ? 'hourly' : 'flat';
  if (!allowMissingPrice) {
    if (priceType === 'flat' && !(Number(b.hirer_set_price) > 0)) errors.push('hirer_set_price must be > 0 for a flat job');
    if (priceType === 'hourly' && !(Number(b.hourly_rate) > 0)) errors.push('hourly_rate must be > 0 for an hourly job');
  }
  if (Array.isArray(b.photos) && b.photos.length > 5) errors.push('a maximum of 5 photos is allowed');
  if (typeof b.instructions === 'string' && b.instructions.length > 2000) errors.push('instructions must be 2000 characters or fewer');
  return { errors, start, end, priceType };
}

/** Resolve creator catalog pricing (rate or package) onto job price fields. */
async function resolveCreatorJobPricing(b, { workerProfileId, categoryId, durationHours }) {
  if (b.worker_package_id) {
    const pkg = await prisma.worker_package.findUnique({
      where: { worker_package_id: Number(b.worker_package_id) },
      include: { worker_category: true },
    });
    if (!pkg || !pkg.is_active) return { error: 'Package not found' };
    if (pkg.worker_category.worker_profile_id !== Number(workerProfileId)) {
      return { error: 'Package does not belong to this worker' };
    }
    if (pkg.worker_category.work_category_id !== Number(categoryId)) {
      return { error: 'Package does not match this category' };
    }
    return {
      priceType: 'flat',
      hirer_set_price: Number(pkg.price),
      hourly_rate: null,
      duration_hours: Number(pkg.duration_hours) > 0 ? Number(pkg.duration_hours) : durationHours,
      package_name: pkg.name,
    };
  }

  if (b.use_worker_rate) {
    const wc = await prisma.worker_category.findFirst({
      where: { worker_profile_id: Number(workerProfileId), work_category_id: Number(categoryId) },
    });
    if (!wc) return { error: 'Worker does not offer this category' };
    if (wc.price_type === 'hourly' && Number(wc.hourly_rate) > 0) {
      return {
        priceType: 'hourly',
        hirer_set_price: null,
        hourly_rate: Number(wc.hourly_rate),
        duration_hours: durationHours,
      };
    }
    if (Number(wc.flat_rate) > 0) {
      return {
        priceType: 'flat',
        hirer_set_price: Number(wc.flat_rate),
        hourly_rate: null,
        duration_hours: durationHours,
      };
    }
    // Prefer hourly if set even when price_type missing/legacy
    if (Number(wc.hourly_rate) > 0) {
      return {
        priceType: 'hourly',
        hirer_set_price: null,
        hourly_rate: Number(wc.hourly_rate),
        duration_hours: durationHours,
      };
    }
    return { error: 'This worker has not set a rate for this category yet' };
  }

  return null;
}

// POST /work-jobs — create a draft job with computed pricing (flat or hourly).
router.post('/', authenticateToken, async (req, res) => {
  try {
    const b = req.body || {};
    const { errors, start, end, priceType } = validateJobInput(b);
    if (errors.length) return res.status(400).json({ message: 'Invalid job', errors });

    const category = await prisma.work_category.findUnique({ where: { work_category_id: Number(b.category_id) } });
    if (!category || category.parent_id == null) return res.status(400).json({ message: 'category_id must be a valid worker-type (leaf category)' });

    const duration_hours = (end.getTime() - start.getTime()) / 3600000;
    const region = await resolveWorkRegion(b.location_lat, b.location_long);
    const pricing = computeWorkPricing({
      price_type: priceType,
      hirer_set_price: b.hirer_set_price,
      hourly_rate: b.hourly_rate,
      duration_hours,
      taxRate: region.tax,
      currency: region.currency,
    });

    const job = await prisma.work_job.create({
      data: {
        hirer_id: req.user.user_id,
        category_id: category.work_category_id,
        title: (b.title || category.name).slice(0, 200),
        instructions: b.instructions || null,
        location_lat: b.location_lat ?? null,
        location_long: b.location_long ?? null,
        address: b.address || null,
        scheduled_start: start,
        scheduled_end: end,
        status: 'draft',
        service_mode: b.service_mode === 'in_shop' ? 'in_shop' : 'mobile',
        price_type: priceType,
        hirer_set_price: priceType === 'flat' ? Number(b.hirer_set_price) : pricing.total_charged,
        hourly_rate: priceType === 'hourly' ? Number(b.hourly_rate) : null,
        duration_hours,
        platform_fee_pct: pricing.platform_fee_pct,
        tax_amount: pricing.tax_amount,
        worker_payout: pricing.worker_payout,
        photos: Array.isArray(b.photos) ? b.photos.slice(0, 5) : [],
        payment_method: b.payment_method || null,
        created_at: new Date(),
      },
    });
    res.status(201).json({ ...job, pricing });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to create job' });
  }
});

// POST /work-jobs/quote — price preview (no job created), for live worker-take-home display.
router.post('/quote', authenticateToken, async (req, res) => {
  try {
    const b = req.body || {};
    const priceType = b.price_type === 'hourly' ? 'hourly' : 'flat';
    let duration_hours = Number(b.duration_hours) || null;
    if (!duration_hours && b.scheduled_start && b.scheduled_end) {
      duration_hours = (new Date(b.scheduled_end).getTime() - new Date(b.scheduled_start).getTime()) / 3600000;
    }
    const region = await resolveWorkRegion(b.location_lat, b.location_long);
    const pricing = computeWorkPricing({ price_type: priceType, hirer_set_price: b.hirer_set_price, hourly_rate: b.hourly_rate, duration_hours, taxRate: region.tax, currency: region.currency });
    res.json(pricing);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to compute quote' });
  }
});

// GET /work-jobs — the hirer's active (not completed/cancelled) jobs.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const jobs = await prisma.work_job.findMany({
      where: { hirer_id: req.user.user_id, status: { notIn: ['completed', 'cancelled'] } },
      orderBy: { created_at: 'desc' },
      take: Math.min(Math.max(Number(req.query.limit) || 50, 1), 100),
      include: { work_category: { select: { name: true, slug: true } } },
    });
    res.json(jobs);
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch jobs' }); }
});

// GET /work-jobs/history — completed/cancelled jobs. (Defined before /:id so it isn't shadowed.)
// Order-history entry point for the buyer (#work-jobs never showed up in Account >
// Order History before this — only booking-engine verticals (mechanic/professional) did).
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const jobs = await prisma.work_job.findMany({
      where: { hirer_id: req.user.user_id, status: { in: ['completed', 'cancelled'] } },
      orderBy: { created_at: 'desc' },
      take: Math.min(Math.max(Number(req.query.limit) || 50, 1), 100),
      include: {
        work_category: { select: { name: true, slug: true } },
        work_review: { select: { rating: true } },
      },
    });
    // assigned_worker_id has no Prisma relation to worker_profile (plain FK column),
    // so the worker's display name needs a manual lookup rather than an `include`.
    const workerIds = [...new Set(jobs.map((j) => j.assigned_worker_id).filter(Boolean))];
    const workerNames = new Map();
    if (workerIds.length) {
      const workers = await prisma.worker_profile.findMany({
        where: { worker_profile_id: { in: workerIds } },
        select: { worker_profile_id: true, user: { select: { name: true } } },
      });
      workers.forEach((w) => workerNames.set(w.worker_profile_id, w.user?.name || null));
    }
    res.json(jobs.map((j) => ({ ...j, worker_name: workerNames.get(j.assigned_worker_id) || null })));
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch history' }); }
});

// POST /work-jobs/direct-offer — hirer targets a specific worker.
// On-demand: worker must be online (45s offer window).
// Catalog / Book Artist: offline workers with that service can be booked; longer accept window.
router.post('/direct-offer', authenticateToken, async (req, res) => {
  try {
    const b = req.body || {};
    const useCreatorPrice = !!(b.use_worker_rate || b.worker_package_id);
    const { errors, start, end, priceType: inputPriceType } = validateJobInput(b, { allowMissingPrice: useCreatorPrice });
    if (errors.length) return res.status(400).json({ message: 'Invalid job', errors });
    if (!b.worker_profile_id) return res.status(400).json({ message: 'worker_profile_id is required' });

    const worker = await prisma.worker_profile.findUnique({
      where: { worker_profile_id: Number(b.worker_profile_id) },
      select: { worker_profile_id: true, user_id: true, is_available: true },
    });
    if (!worker) return res.status(404).json({ message: 'Worker not found' });

    const category = await prisma.work_category.findUnique({ where: { work_category_id: Number(b.category_id) } });
    if (!category || category.parent_id == null) return res.status(400).json({ message: 'category_id must be a valid leaf category' });

    const offersCategory = await prisma.worker_category.findFirst({
      where: { worker_profile_id: worker.worker_profile_id, work_category_id: category.work_category_id },
      select: { worker_category_id: true },
    });
    if (!offersCategory) return res.status(400).json({ message: 'This provider does not offer that service' });

    const catalogBooking = b.catalog_booking === true || b.catalog_booking === 1 || b.catalog_booking === 'true';
    if (!worker.is_available && !catalogBooking) {
      return res.status(409).json({ message: 'This worker is not available right now' });
    }

    let duration_hours = (end.getTime() - start.getTime()) / 3600000;
    let priceType = inputPriceType;
    let hirer_set_price = b.hirer_set_price;
    let hourly_rate = b.hourly_rate;
    let titleExtra = '';
    let scheduledEnd = end;

    if (useCreatorPrice) {
      const resolved = await resolveCreatorJobPricing(b, {
        workerProfileId: worker.worker_profile_id,
        categoryId: category.work_category_id,
        durationHours: duration_hours,
      });
      if (resolved?.error) return res.status(400).json({ message: resolved.error });
      priceType = resolved.priceType;
      hirer_set_price = resolved.hirer_set_price;
      hourly_rate = resolved.hourly_rate;
      // Package bookings: lock the scheduled window to the package duration from start.
      if (b.worker_package_id && Number(resolved.duration_hours) > 0) {
        duration_hours = Number(resolved.duration_hours);
        scheduledEnd = new Date(start.getTime() + duration_hours * 3600000);
        if (scheduledEnd.getTime() - start.getTime() < MIN_DURATION_HRS * 3600 * 1000) {
          return res.status(400).json({ message: 'Package duration must be at least 1 hour' });
        }
      }
      if (resolved.package_name) titleExtra = ` — ${resolved.package_name}`;
    }

    const region = await resolveWorkRegion(b.location_lat, b.location_long);
    const pricing = computeWorkPricing({
      price_type: priceType,
      hirer_set_price,
      hourly_rate,
      duration_hours,
      taxRate: region.tax,
      currency: region.currency,
    });

    const job = await prisma.work_job.create({
      data: {
        hirer_id: req.user.user_id,
        assigned_worker_id: worker.worker_profile_id,
        category_id: category.work_category_id,
        title: `${(b.title || category.name).slice(0, 180)}${titleExtra}`.slice(0, 200),
        instructions: b.instructions || null,
        location_lat: b.location_lat ?? null,
        location_long: b.location_long ?? null,
        address: b.address || null,
        scheduled_start: start,
        scheduled_end: scheduledEnd,
        status: 'draft',
        service_mode: b.service_mode === 'in_shop' ? 'in_shop' : 'mobile',
        price_type: priceType,
        hirer_set_price: priceType === 'flat' ? Number(hirer_set_price) : pricing.total_charged,
        hourly_rate: priceType === 'hourly' ? Number(hourly_rate) : null,
        duration_hours,
        platform_fee_pct: pricing.platform_fee_pct,
        tax_amount: pricing.tax_amount,
        worker_payout: pricing.worker_payout,
        photos: Array.isArray(b.photos) ? b.photos.slice(0, 5) : [],
        payment_method: null,
        created_at: new Date(),
      },
    });

    // Debit hirer wallet upfront (refunded on decline or timeout)
    const total = Number(job.hirer_set_price) || 0;
    const pay = await debitWorkWallet(req.user.user_id, total, 'ondemand_direct_offer', `Direct offer #${job.work_job_id} — ${job.title}`);
    if (!pay.ok) {
      await prisma.work_job.delete({ where: { work_job_id: job.work_job_id } }).catch(() => {});
      return res.status(402).json({ status: 402, error: 'insufficient_balance', message: `Insufficient wallet balance. You have $${pay.balance.toFixed(2)} but $${total.toFixed(2)} is required.`, balance: pay.balance, required: total });
    }

    const offerExpiresAt = catalogBooking
      ? catalogOfferExpiresAt(start)
      : new Date(Date.now() + WORKER_OFFER_TIMEOUT_SEC * 1000);

    // Flip to offered and create offer record atomically
    const [updated] = await prisma.$transaction([
      prisma.work_job.update({
        where: { work_job_id: job.work_job_id },
        data: { status: 'offered', payment_method: 'wallet', offer_expires_at: offerExpiresAt, updated_at: new Date() },
      }),
      prisma.work_job_offer.create({
        data: { work_job_id: job.work_job_id, worker_profile_id: worker.worker_profile_id, response: 'pending' },
      }),
    ]);

    // Notify the targeted worker (socket + bell/push — they may be offline for catalog bookings)
    const io = req.app.get('io');
    if (worker.user_id) {
      if (io) io.emit(`work-offer-${worker.user_id}`, { work_job_id: job.work_job_id });
      notifyWork(io, worker.user_id, 'offer', {
        work_job_id: job.work_job_id,
        params: { jobTitle: job.title || '', payout: Number(job.worker_payout || 0).toFixed(2) },
      });
    }

    res.status(201).json({ ...updated, pricing });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to create direct offer' });
  }
});

// GET /work-jobs/:id — full job detail.
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });
    const job = await prisma.work_job.findUnique({ where: { work_job_id: id }, include: { work_category: { select: { name: true, slug: true } } } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    // For in-shop (reversed-map) jobs, surface the provider's location once assigned so the
    // hirer can navigate to them (instead of the worker travelling to the hirer).
    let provider_location = null;
    if (job.service_mode === 'in_shop' && job.assigned_worker_id && ['accepted', 'worker_en_route', 'in_progress', 'completed'].includes(job.status)) {
      const wp = await prisma.worker_profile.findUnique({ where: { worker_profile_id: job.assigned_worker_id }, select: { current_lat: true, current_long: true } });
      if (wp?.current_lat != null) provider_location = { lat: wp.current_lat, lng: wp.current_long };
    }
    res.json({ ...job, provider_location });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch job' }); }
});

// PATCH /work-jobs/:id/submit — availability guard, then enter the matching queue.
// Stripe pre-auth + the dispatch loop are wired in M3/M7; this guards + flips to 'searching'.
router.patch('/:id/submit', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const job = await prisma.work_job.findUnique({ where: { work_job_id: id } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (job.hirer_id !== req.user.user_id) return res.status(403).json({ message: 'Not your job' });
    if (job.status !== 'draft') return res.status(409).json({ message: `Job is already ${job.status}` });

    // Do not let the hirer pay if nobody can take the job (mirrors rideshare's no-driver 503).
    // Exclude the hirer themselves — a user can never be their own provider.
    const available = await countAvailableWorkersInCategory(job.category_id, [], req.user.user_id);
    if (available < 1) {
      return res.status(503).json({ status: 503, error: 'no_worker_available', message: 'No workers available in your area for this category right now. Please try again later.' });
    }
    // Charge the hirer's wallet for the all-in price up front (held by the platform; refunded
    // on no-match / cancellation, worker paid out on completion). Atomic — never overdraws.
    const total = Number(job.hirer_set_price) || 0;
    const pay = await debitWorkWallet(req.user.user_id, total, 'ondemand_work_charge', `On-demand booking #${job.work_job_id} — ${job.title}`);
    if (!pay.ok) {
      return res.status(402).json({ status: 402, error: 'insufficient_balance', message: `Insufficient wallet balance. You have $${pay.balance.toFixed(2)} but $${total.toFixed(2)} is required.`, balance: pay.balance, required: total });
    }
    const updated = await prisma.work_job.update({ where: { work_job_id: id }, data: { status: 'searching', payment_method: 'wallet', updated_at: new Date() } });
    // Activate the matching engine immediately (spec §3.1) — offer to the nearest worker
    // in this category. Fire-and-forget so the response isn't blocked by dispatch I/O.
    dispatchWorkToNextWorker(req.app.get('io'), updated).catch((err) => console.error('[work] dispatch on submit failed:', err.message));
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to submit job' }); }
});

// PATCH /work-jobs/:id/cancel — cancel with refund tiers (refund to hirer wallet;
// worker compensated for late cancels / mid-shift).
router.patch('/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const job = await prisma.work_job.findUnique({ where: { work_job_id: id } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (job.hirer_id !== req.user.user_id) return res.status(403).json({ message: 'Not your job' });
    if (['completed', 'cancelled'].includes(job.status)) return res.status(409).json({ message: `Job is already ${job.status}` });

    const total = Number(job.hirer_set_price) || 0;
    const hoursToStart = job.scheduled_start ? (new Date(job.scheduled_start).getTime() - Date.now()) / 3600000 : 999;
    let refund = 0, fee = 0, workerComp = 0, note = '';

    if (job.status === 'draft' || job.status === 'no_match') {
      note = 'no charge to refund'; // draft never charged; no_match already refunded at dispatch
    } else if (job.status === 'searching') {
      refund = total; note = 'full refund (no worker had accepted)';
    } else if (job.status === 'offered') {
      refund = total; note = 'full refund (offer not yet accepted)';
    } else if (job.status === 'accepted' || job.status === 'worker_en_route') {
      if (hoursToStart >= 2) { fee = round2(total * 0.10); refund = round2(total - fee); note = 'cancelled >2h before start — 10% fee'; }
      else { fee = round2(total * 0.50); workerComp = round2(total * 0.25); refund = round2(total - fee); note = 'cancelled <2h before start — 50% fee, worker compensated'; }
    } else if (job.status === 'in_progress') {
      workerComp = round2(Number(job.worker_payout) || 0); note = 'cancelled mid-shift — worker paid for the job';
    }

    if (refund > 0) {
      const directOffer = job.status === 'offered';
      try {
        // Direct offers share the timeout/decline ledger key so a cancel racing
        // processExpiredWorkOffers cannot credit twice (external_ref is UNIQUE).
        await creditWorkWallet(
          job.hirer_id,
          refund,
          directOffer ? 'ondemand_direct_offer_refund' : 'ondemand_work_refund',
          directOffer ? `Refund — direct offer #${id} cancelled` : `Refund — booking #${id} (${note})`,
          directOffer ? `direct_offer_refund:${id}` : undefined,
        );
      } catch (refundErr) {
        if (refundErr?.code !== 'P2002') throw refundErr;
      }
    }
    if (workerComp > 0) { const wuid = await workerUserId(job.assigned_worker_id); if (wuid) await creditWorkWallet(wuid, workerComp, 'ondemand_work_comp', `Cancellation compensation — booking #${id}`); }

    // Notify the assigned worker (if any) that the job was cancelled.
    if (job.assigned_worker_id) {
      const wuid = await workerUserId(job.assigned_worker_id);
      if (wuid) notifyWork(req.app.get('io'), wuid, 'cancelled', { work_job_id: id, params: { jobTitle: job.title || '', compensated: workerComp > 0, amount: workerComp > 0 ? workerComp.toFixed(2) : '0' } });
    }
    const updated = await prisma.work_job.update({ where: { work_job_id: id }, data: { status: 'cancelled', cancellation_reason: req.body?.reason || note, offer_expires_at: null, updated_at: new Date() } });
    res.json({ ...updated, refund, fee, worker_comp: workerComp, note });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to cancel job' }); }
});

// POST /work-jobs/:id/tip — hirer tips; 100% to the worker (separate wallet charge).
router.post('/:id/tip', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const amount = round2(req.body?.amount);
    if (!(amount > 0)) return res.status(400).json({ message: 'Tip amount must be greater than 0' });
    const job = await prisma.work_job.findUnique({ where: { work_job_id: id } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (job.hirer_id !== req.user.user_id) return res.status(403).json({ message: 'Not your job' });
    if (!job.assigned_worker_id) return res.status(409).json({ message: 'No worker to tip' });
    const pay = await debitWorkWallet(req.user.user_id, amount, 'ondemand_work_tip', `Tip — booking #${id}`);
    if (!pay.ok) return res.status(402).json({ error: 'insufficient_balance', message: `Insufficient wallet balance ($${pay.balance.toFixed(2)}).` });
    const wuid = await workerUserId(job.assigned_worker_id);
    if (wuid) { await creditWorkWallet(wuid, amount, 'ondemand_work_tip', `Tip received — booking #${id}`); notifyWork(req.app.get('io'), wuid, 'tip', { work_job_id: id, params: { jobTitle: job.title || '', amount: amount.toFixed(2) } }); }
    const updated = await prisma.work_job.update({ where: { work_job_id: id }, data: { tip_amount: round2((Number(job.tip_amount) || 0) + amount) } });
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to process tip' }); }
});

// POST /work-jobs/:id/review — hirer rates the worker after completion.
router.post('/:id/review', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rating = Number(req.body?.rating);
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ message: 'rating must be between 1 and 5' });
    const job = await prisma.work_job.findUnique({ where: { work_job_id: id } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (job.hirer_id !== req.user.user_id) return res.status(403).json({ message: 'Not your job' });
    if (job.status !== 'completed') return res.status(409).json({ message: 'Job must be completed before reviewing' });
    if (!job.assigned_worker_id) return res.status(409).json({ message: 'No worker to review' });
    const existing = await prisma.work_review.findFirst({ where: { work_job_id: id, reviewer_id: req.user.user_id } });
    if (existing) return res.status(409).json({ message: 'You already reviewed this job' });
    const review = await prisma.work_review.create({ data: { work_job_id: id, reviewer_id: req.user.user_id, worker_profile_id: job.assigned_worker_id, rating, comment: req.body?.comment || null } });
    const agg = await prisma.work_review.aggregate({ where: { worker_profile_id: job.assigned_worker_id }, _avg: { rating: true } });
    await prisma.worker_profile.update({ where: { worker_profile_id: job.assigned_worker_id }, data: { rating: agg._avg.rating } }).catch(() => {});
    res.status(201).json(review);
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to submit review' }); }
});

// PATCH /work-jobs/:id/employer-cancel — employer cancels job up to 15 minutes before shift start.
// No penalty to worker, full refund to employer, worker is notified.
router.patch('/:id/employer-cancel', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const job = await prisma.work_job.findUnique({ where: { work_job_id: id } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (job.hirer_id !== req.user.user_id) return res.status(403).json({ message: 'Not your job' });
    if (['completed', 'cancelled'].includes(job.status)) return res.status(409).json({ message: `Job is already ${job.status}` });

    // Only allow cancellation for accepted or worker_en_route jobs
    if (!['accepted', 'worker_en_route'].includes(job.status)) {
      return res.status(409).json({ message: `Cannot cancel job in status ${job.status}` });
    }

    // Check if job is at least 15 minutes before start
    const minutesToStart = job.scheduled_start ? (new Date(job.scheduled_start).getTime() - Date.now()) / 60000 : 999;
    if (minutesToStart < 15) {
      return res.status(409).json({ message: `Cannot cancel job less than 15 minutes before start. ${Math.ceil(15 - minutesToStart)} minutes remaining.` });
    }

    const total = Number(job.hirer_set_price) || 0;
    const note = 'cancelled by employer — full refund, no worker penalty';

    // Full refund to employer
    if (total > 0) {
      await creditWorkWallet(job.hirer_id, total, 'ondemand_work_refund', `Refund — booking #${id} (${note})`);
    }

    // Notify the assigned worker that the job was cancelled by employer
    if (job.assigned_worker_id) {
      const wuid = await workerUserId(job.assigned_worker_id);
      if (wuid) {
        notifyWork(req.app.get('io'), wuid, 'cancelled', {
          work_job_id: id,
          params: { jobTitle: job.title || '', cancelledByEmployer: true, noPenalty: true },
        });
      }
    }

    const updated = await prisma.work_job.update({
      where: { work_job_id: id },
      data: {
        status: 'cancelled',
        cancellation_reason: req.body?.reason || note,
        offer_expires_at: null,
        updated_at: new Date(),
      },
    });

    res.json({ ...updated, refund: total, note });
  } catch (e) {
    res.status(500).json({ message: 'Failed to cancel job' });
  }
});

// PATCH /work-jobs/:id/worker-cancel — worker cancels their assigned job before shift starts.
router.patch('/:id/worker-cancel', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const job = await prisma.work_job.findUnique({ where: { work_job_id: id } });
    if (!job) return res.status(404).json({ message: 'Job not found' });

    // Get the worker profile for the current user
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.status(400).json({ message: 'Not a worker' });

    // Verify that the worker is assigned to this job
    if (job.assigned_worker_id !== p.worker_profile_id) {
      return res.status(403).json({ message: 'You are not assigned to this job' });
    }

    // Only allow cancellation before the job starts (accepted or worker_en_route)
    if (!['accepted', 'worker_en_route'].includes(job.status)) {
      return res.status(409).json({ message: `Cannot cancel job in status ${job.status}` });
    }

const reason = req.body?.reason || 'No reason provided';

    // Determine if the cancellation is late (< 2h before start) or early
    const hoursToStart = job.scheduled_start
      ? (new Date(job.scheduled_start).getTime() - Date.now()) / 3600000
      : 999;
    const isLateCancellation = hoursToStart < 2;

    // Apply reliability penalty for late cancellations only
    let reliabilityResult = null;
    if (isLateCancellation) {
      reliabilityResult = await penalize(
        p.worker_profile_id,
        'late_cancel',
        'work_job',
        id,
      );
    }

    // Update the job: set status to cancelled, keep assigned_worker_id for analytics tracking, store reason
    const updated = await prisma.work_job.update({
      where: { work_job_id: id },
      data: {
        status: 'cancelled',
        cancellation_reason: reason,
        updated_at: new Date(),
      },
    });

    // Notify the hirer that the job was cancelled by the worker
    if (job.hirer_id) {
      const io = req.app.get('io');
      notifyWork(io, job.hirer_id, 'cancelled', {
        work_job_id: id,
        params: { jobTitle: job.title || '', cancelledByWorker: true },
      });
    }

    // Notify the worker if their reliability score was affected
    if (isLateCancellation && reliabilityResult) {
      notifyWork(req.app.get('io'), req.user.user_id, 'reliability_decreased', {
        work_job_id: id,
        params: {
          jobTitle: job.title || '',
          scoreBefore: reliabilityResult.score_before,
          scoreAfter: reliabilityResult.score_after,
          pointsLost: Math.abs(reliabilityResult.delta),
        },
      });
    }

    res.json({ ...updated, reliability: reliabilityResult });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to cancel job' });
  }
});

// PATCH /work-jobs/:id/no-show — hirer marks worker as no-show after shift start.
// Deducts 5 reliability points, notifies worker, and prepares for replacement.
router.patch('/:id/no-show', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const job = await prisma.work_job.findUnique({ where: { work_job_id: id } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (job.hirer_id !== req.user.user_id) return res.status(403).json({ message: 'Not your job' });
    
    // Only allow no-show marking after shift start (accepted or worker_en_route)
    if (!['accepted', 'worker_en_route'].includes(job.status)) {
      return res.status(409).json({ message: `Cannot mark no-show for job in status ${job.status}` });
    }
    if (!job.assigned_worker_id) return res.status(409).json({ message: 'No worker assigned to this job' });

    // Only allow no-show if 15 minutes have passed since scheduled start time
    const minutesSinceStart = job.scheduled_start
      ? (Date.now() - new Date(job.scheduled_start).getTime()) / 60000
      : 999;
    if (minutesSinceStart < 15) {
      return res.status(409).json({ 
        message: `Cannot mark no-show until 15 minutes after scheduled start time. ${Math.ceil(15 - minutesSinceStart)} minutes remaining.` 
      });
    }

    // Apply reliability penalty for no-show (-5 points)
    const reliabilityResult = await penalize(
      job.assigned_worker_id,
      'no_show',
      'work_job',
      id,
    );

    // Update the job: unassign the worker but do NOT cancel - let employer decide
    const updated = await prisma.work_job.update({
      where: { work_job_id: id },
      data: {
        assigned_worker_id: null,
        no_show_marked: true,
        no_show_worker_id: job.assigned_worker_id,
        updated_at: new Date(),
      },
    });

    // Notify the worker about the no-show and reliability penalty
    const wuid = await workerUserId(job.assigned_worker_id);
    const io = req.app.get('io');
    if (wuid) {
      notifyWork(io, wuid, 'no_show', {
        work_job_id: id,
        params: {
          jobTitle: job.title || '',
          scoreBefore: reliabilityResult.score_before,
          scoreAfter: reliabilityResult.score_after,
          pointsLost: Math.abs(reliabilityResult.delta),
        },
      });
    }

    // Prepare replacement job data (editable copy of original job)
    const replacementJob = {
      category_id: job.category_id,
      title: job.title,
      instructions: job.instructions,
      location_lat: job.location_lat,
      location_long: job.location_long,
      address: job.address,
      scheduled_start: job.scheduled_start,
      scheduled_end: job.scheduled_end,
      service_mode: job.service_mode,
      price_type: job.price_type,
      hirer_set_price: job.hirer_set_price,
      hourly_rate: job.hourly_rate,
      duration_hours: job.duration_hours,
      photos: job.photos,
    };

    res.json({ 
      ...updated, 
      reliability: reliabilityResult,
      replacement_job: replacementJob,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to mark worker as no-show' });
  }
});


/**
 * GET /work-jobs/hirer/analytics/overview?range=7d|28d|90d|365d|lifetime
 *
 * Employer-side analytics for the on-demand Jobs portal. This is a SPEND view, not an
 * earnings one — the caller is the hirer, so "gross"/"net" both map to what they paid.
 * Returns the shared SellerAnalyticsPanel shape: summary (spend + deltas), per-day
 * timeseries, breakdown (jobs by status), top (top spend by work category).
 *
 * Scoping mirrors the hirer's own job lists (`hirer_id === req.user.user_id`). Draft jobs
 * were never posted/charged, so they're excluded. Total spend = hirer_set_price + tips
 * (both debited from the hirer's work wallet). Buckets use created_at.
 */
router.get('/hirer/analytics/overview', authenticateToken, async (req, res) => {
  try {
    const hirer_id = req.user.user_id;
    const rangeParam = resolveRangeParam(req.query.range);
    const days = RANGE_DAYS[rangeParam];
    const { start, prevStart, prevEnd } = resolveRange(days);

    const notDraft = { not: 'draft' };
    const baseSelect = { work_job_id: true, title: true, status: true, category_id: true, hirer_set_price: true, tip_amount: true, created_at: true };
    const [rows, prevRows] = await Promise.all([
      prisma.work_job.findMany({
        where: { hirer_id, status: notDraft, created_at: { gte: start } },
        select: baseSelect,
      }),
      prisma.work_job.findMany({
        where: { hirer_id, status: notDraft, created_at: { gte: prevStart, lte: prevEnd } },
        select: { hirer_set_price: true, tip_amount: true },
      }),
    ]);

    const spendOf = j => (j.hirer_set_price || 0) + (j.tip_amount || 0);
    const { timeseries, summary } = buildEarningsSeries({ rows, prevRows, dateField: 'created_at', gross: spendOf, net: spendOf, start, days });

    // breakdown: jobs by status
    const statusMap = new Map();
    rows.forEach(j => { const k = j.status || 'unknown'; statusMap.set(k, (statusMap.get(k) || 0) + 1); });
    const breakdown = [...statusMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

    // top spend by work category — aggregate by category_id, resolve names in a guarded
    // query so a drifted work_category table can't break the endpoint.
    const byCat = new Map();
    for (const j of rows) {
      const key = j.category_id ?? `job-${j.work_job_id}`;
      const e = byCat.get(key) || { id: key, category_id: j.category_id, gross: 0, count: 0 };
      e.gross += spendOf(j);
      e.count += 1;
      byCat.set(key, e);
    }
    const catIds = [...byCat.values()].map(e => e.category_id).filter(v => v != null);
    const nameByCat = new Map();
    if (catIds.length) {
      try {
        const cats = await prisma.work_category.findMany({
          where: { work_category_id: { in: catIds } },
          select: { work_category_id: true, name: true },
        });
        cats.forEach(c => nameByCat.set(c.work_category_id, c.name));
      } catch (e) { /* work_category drift — fall back to "Job" */ }
    }
    const top = [...byCat.values()]
      .map(e => ({ id: e.id, title: nameByCat.get(e.category_id) || 'Job', subtitle: `${e.count} job${e.count === 1 ? '' : 's'}`, gross: round2(e.gross), net: round2(e.gross), count: e.count }))
      .sort((a, b) => b.gross - a.gross)
      .slice(0, 8);

    res.json({ successful: true, data: { range: rangeParam, currency: 'CAD', summary, timeseries, breakdown, top } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to load analytics.' });
  }
});

export default router;
