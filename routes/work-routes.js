import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { getIncomingWorkOffers, reofferWorkAfterDecline } from '../utils/work-dispatch.js';
import { creditWorkWallet } from '../utils/work-wallet.js';
import { creditRecruiterShares } from '../utils/recruiter-share.js';
import { notifyWork } from '../utils/work-notify.js';
import { rewardCompletion } from '../utils/work-reliability.js';
import { RANGE_DAYS, resolveRangeParam, resolveRange, buildEarningsSeries, round2 } from '../utils/analytics-buckets.js';

const router = express.Router();

// A work_job's full customer charge (what the hirer paid) — flat price or hourly × hours,
// falling back to the worker payout if neither is set. Net (worker take-home) = payout + tip.
function workJobGross(j) {
  if (j.price_type === 'hourly' && j.hourly_rate != null) return (j.hourly_rate || 0) * (j.duration_hours || 0);
  if (j.hirer_set_price != null) return j.hirer_set_price || 0;
  return j.worker_payout || 0;
}
function workJobNet(j) { return (j.worker_payout || 0) + (j.tip_amount || 0); }

// A worker_profile is created on first availability toggle / first added service —
// the "become a worker" entry point (reuses the existing provider flow on the FE in M5).
// upsert (not findFirst-then-create) so two concurrent first-time calls for the same
// user can't race into two worker_profile rows — user_id is @unique in the schema.
async function getOrCreateWorkerProfile(userId) {
  return prisma.worker_profile.upsert({
    where: { user_id: Number(userId) },
    update: {},
    create: { user_id: Number(userId), is_available: false },
  });
}

function mapWorkerService(wc) {
  return {
    ...wc.work_category,
    worker_category_id: wc.worker_category_id,
    price_type: wc.price_type || 'hourly',
    hourly_rate: wc.hourly_rate,
    flat_rate: wc.flat_rate,
    packages: (wc.worker_package || []).map((p) => ({
      worker_package_id: p.worker_package_id,
      name: p.name,
      price: p.price,
      duration_hours: p.duration_hours,
      is_active: p.is_active,
    })),
  };
}

function parseServiceRates(body = {}) {
  const price_type = body.price_type === 'flat' ? 'flat' : 'hourly';
  const hourly_rate = body.hourly_rate != null && body.hourly_rate !== '' ? Number(body.hourly_rate) : null;
  const flat_rate = body.flat_rate != null && body.flat_rate !== '' ? Number(body.flat_rate) : null;
  if (hourly_rate != null && !(hourly_rate > 0)) return { error: 'hourly_rate must be > 0' };
  if (flat_rate != null && !(flat_rate > 0)) return { error: 'flat_rate must be > 0' };
  return { price_type, hourly_rate, flat_rate };
}

async function listWorkerServices(workerProfileId) {
  const rows = await prisma.worker_category.findMany({
    where: { worker_profile_id: workerProfileId },
    include: {
      work_category: { select: { work_category_id: true, name: true, slug: true } },
      worker_package: { where: { is_active: true }, orderBy: { worker_package_id: 'asc' } },
    },
    orderBy: { worker_category_id: 'asc' },
  });
  return rows.map(mapWorkerService);
}

// GET /workers/me — my worker profile + the categories I've added (with rates/packages).
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const p = await prisma.worker_profile.findUnique({
      where: { user_id: req.user.user_id },
      include: {
        worker_category: {
          include: {
            work_category: { select: { work_category_id: true, name: true, slug: true } },
            worker_package: { where: { is_active: true }, orderBy: { worker_package_id: 'asc' } },
          },
        },
      },
    });
    if (!p) return res.json(null);
    const { worker_category, ...rest } = p;
    res.json({ ...rest, categories: worker_category.map(mapWorkerService) });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch worker profile' }); }
});

// PATCH /workers/me/availability — go online/offline + update current location.
router.patch('/me/availability', authenticateToken, async (req, res) => {
  try {
    const { is_available, lat, lng } = req.body || {};
    const p = await getOrCreateWorkerProfile(req.user.user_id);
    const updated = await prisma.worker_profile.update({
      where: { worker_profile_id: p.worker_profile_id },
      data: {
        is_available: is_available !== undefined ? !!is_available : p.is_available,
        current_lat: lat != null ? Number(lat) : p.current_lat,
        current_long: lng != null ? Number(lng) : p.current_long,
        last_ping: new Date(),
      },
    });
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to update availability' }); }
});

// POST /workers/me/services — add a leaf category (+ optional creator rates).
router.post('/me/services', authenticateToken, async (req, res) => {
  try {
    const cat = await prisma.work_category.findUnique({ where: { work_category_id: Number(req.body?.category_id) } });
    if (!cat || cat.parent_id == null) return res.status(400).json({ message: 'category_id must be a valid worker-type (leaf category)' });
    const rates = parseServiceRates(req.body);
    if (rates.error) return res.status(400).json({ message: rates.error });
    const p = await getOrCreateWorkerProfile(req.user.user_id);
    const existing = await prisma.worker_category.findFirst({ where: { worker_profile_id: p.worker_profile_id, work_category_id: cat.work_category_id } });
    if (!existing) {
      await prisma.worker_category.create({
        data: {
          worker_profile_id: p.worker_profile_id,
          work_category_id: cat.work_category_id,
          price_type: rates.price_type,
          hourly_rate: rates.hourly_rate,
          flat_rate: rates.flat_rate,
        },
      });
    } else if (req.body?.price_type != null || req.body?.hourly_rate != null || req.body?.flat_rate != null) {
      await prisma.worker_category.update({
        where: { worker_category_id: existing.worker_category_id },
        data: {
          price_type: rates.price_type,
          hourly_rate: rates.hourly_rate,
          flat_rate: rates.flat_rate,
        },
      });
    }
    res.status(201).json({ categories: await listWorkerServices(p.worker_profile_id) });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to add service' }); }
});

// PATCH /workers/me/services/:categoryId — update creator rates for a service.
router.patch('/me/services/:categoryId', authenticateToken, async (req, res) => {
  try {
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.status(404).json({ message: 'Not a worker' });
    const rates = parseServiceRates(req.body);
    if (rates.error) return res.status(400).json({ message: rates.error });
    const wc = await prisma.worker_category.findFirst({
      where: { worker_profile_id: p.worker_profile_id, work_category_id: Number(req.params.categoryId) },
    });
    if (!wc) return res.status(404).json({ message: 'Service not found' });
    await prisma.worker_category.update({
      where: { worker_category_id: wc.worker_category_id },
      data: {
        price_type: rates.price_type,
        hourly_rate: rates.hourly_rate,
        flat_rate: rates.flat_rate,
      },
    });
    res.json({ categories: await listWorkerServices(p.worker_profile_id) });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to update service rates' }); }
});

// POST /workers/me/services/:categoryId/packages — add a named package.
router.post('/me/services/:categoryId/packages', authenticateToken, async (req, res) => {
  try {
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.status(404).json({ message: 'Not a worker' });
    const wc = await prisma.worker_category.findFirst({
      where: { worker_profile_id: p.worker_profile_id, work_category_id: Number(req.params.categoryId) },
    });
    if (!wc) return res.status(404).json({ message: 'Service not found' });
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const price = Number(req.body?.price);
    const duration_hours = Number(req.body?.duration_hours);
    if (!name) return res.status(400).json({ message: 'name is required' });
    if (!(price > 0)) return res.status(400).json({ message: 'price must be > 0' });
    if (!(duration_hours > 0)) return res.status(400).json({ message: 'duration_hours must be > 0' });
    await prisma.worker_package.create({
      data: { worker_category_id: wc.worker_category_id, name, price, duration_hours, is_active: true },
    });
    res.status(201).json({ categories: await listWorkerServices(p.worker_profile_id) });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to add package' }); }
});

// DELETE /workers/me/packages/:packageId — soft-deactivate a package.
router.delete('/me/packages/:packageId', authenticateToken, async (req, res) => {
  try {
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.status(404).json({ message: 'Not a worker' });
    const pkg = await prisma.worker_package.findUnique({
      where: { worker_package_id: Number(req.params.packageId) },
      include: { worker_category: { select: { worker_profile_id: true } } },
    });
    if (!pkg || pkg.worker_category.worker_profile_id !== p.worker_profile_id) {
      return res.status(404).json({ message: 'Package not found' });
    }
    await prisma.worker_package.update({
      where: { worker_package_id: pkg.worker_package_id },
      data: { is_active: false },
    });
    res.json({ categories: await listWorkerServices(p.worker_profile_id) });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to remove package' }); }
});

// DELETE /workers/me/services/:categoryId — remove a category.
router.delete('/me/services/:categoryId', authenticateToken, async (req, res) => {
  try {
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.status(404).json({ message: 'Not a worker' });
    await prisma.worker_category.deleteMany({ where: { worker_profile_id: p.worker_profile_id, work_category_id: Number(req.params.categoryId) } });
    res.json({ removed: true });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to remove service' }); }
});

// GET /workers/me/offers — pending job offers currently extended to this worker.
router.get('/me/offers', authenticateToken, async (req, res) => {
  try {
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.json([]);
    res.json(await getIncomingWorkOffers(p.worker_profile_id));
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch offers' }); }
});

// PATCH /workers/offers/:jobId/accept — accept the offer (first-to-accept wins).
router.patch('/offers/:jobId/accept', authenticateToken, async (req, res) => {
  try {
    const io = req.app.get('io');
    const jobId = parseInt(req.params.jobId);
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.status(400).json({ message: 'Not a worker' });
    const job = await prisma.work_job.findUnique({ where: { work_job_id: jobId } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    const now = new Date();
    // Claim the live offer atomically so a timeout/decline/second-accept cannot
    // flip the row after this read. Cron refunds only when it wins this race.
    const claimed = await prisma.work_job.updateMany({
      where: {
        work_job_id: jobId,
        assigned_worker_id: p.worker_profile_id,
        status: { in: ['offered', 'searching'] },
        offer_expires_at: { gt: now },
      },
      data: { status: 'accepted', offer_expires_at: null, updated_at: now },
    });
    if (claimed.count !== 1) {
      if (job.offer_expires_at && job.offer_expires_at < now) {
        return res.status(409).json({ message: 'This offer has expired' });
      }
      return res.status(409).json({ message: 'This offer is no longer available to you' });
    }

    const updated = { ...job, status: 'accepted', offer_expires_at: null, updated_at: now };
    await prisma.work_job_offer.updateMany({ where: { work_job_id: jobId, worker_profile_id: p.worker_profile_id, response: 'pending' }, data: { response: 'accepted', responded_at: new Date() } });
    if (job.hirer_id) {
      io?.to(`user-${job.hirer_id}`).emit(`work-accepted-${jobId}`, { work_job_id: jobId, worker_profile_id: p.worker_profile_id });
      notifyWork(io, job.hirer_id, 'accepted', { work_job_id: jobId, params: { jobTitle: job.title || '' } });
    }
    const { syncWorkJobChatMembers } = await import('../services/chat-context-service.js');
    await syncWorkJobChatMembers(jobId).catch(() => {});
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to accept offer' }); }
});

// PATCH /workers/offers/:jobId/decline — decline → re-offer to the next nearest worker.
router.patch('/offers/:jobId/decline', authenticateToken, async (req, res) => {
  try {
    const io = req.app.get('io');
    const jobId = parseInt(req.params.jobId);
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.status(400).json({ message: 'Not a worker' });
    const result = await reofferWorkAfterDecline(io, jobId, p.worker_profile_id);
    res.json({ declined: true, ...result });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to decline offer' }); }
});

// GET /workers/me/earnings — completed-job payout summary.
router.get('/me/earnings', authenticateToken, async (req, res) => {
  try {
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.json({ total_earned: 0, completed_jobs: 0, cancelled_jobs: 0 });
    const done = await prisma.work_job.findMany({ where: { assigned_worker_id: p.worker_profile_id, status: 'completed' }, select: { worker_payout: true, tip_amount: true } });
    const total_earned = done.reduce((s, j) => s + (j.worker_payout || 0) + (j.tip_amount || 0), 0);
    const cancelledCount = await prisma.work_job.count({
      where: {
        assigned_worker_id: p.worker_profile_id,
        status: 'cancelled',
        NOT: { cancellation_reason: { contains: 'Cancelled by employer' } },
      },
    });
    res.json({ total_earned: parseFloat(total_earned.toFixed(2)), completed_jobs: done.length, cancelled_jobs: cancelledCount });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch earnings' }); }
});

// GET /workers/me/reliability — worker reliability score + audit trail.
router.get('/me/reliability', authenticateToken, async (req, res) => {
  try {
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.json({ reliability_score: 100, audit_trail: [] });
    const { getAuditTrail } = await import('../utils/work-reliability.js');
    const audit_trail = await getAuditTrail(p.worker_profile_id);
    res.json({ reliability_score: p.reliability_score ?? 100, audit_trail });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch reliability' }); }
});

// GET /workers/me/reviews — every review a hirer left on this worker's jobs, with the
// lifetime average + count. `worker_profile.rating` already tracks the running average
// (updated on each new review in work-job-routes.js), but this is the only place the
// worker can see the reviews themselves, not just the number.
router.get('/me/reviews', authenticateToken, async (req, res) => {
  try {
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.json({ average_rating: null, review_count: 0, reviews: [] });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const [reviews, agg] = await Promise.all([
      prisma.work_review.findMany({
        where: { worker_profile_id: p.worker_profile_id },
        orderBy: { created_at: 'desc' },
        take: limit,
        include: {
          user: { select: { name: true } },
          work_job: { select: { title: true, work_category: { select: { name: true } } } },
        },
      }),
      prisma.work_review.aggregate({ where: { worker_profile_id: p.worker_profile_id }, _avg: { rating: true }, _count: { _all: true } }),
    ]);
    res.json({
      average_rating: agg._avg.rating != null ? Math.round(agg._avg.rating * 10) / 10 : null,
      review_count: agg._count._all,
      reviews: reviews.map((r) => ({
        work_review_id: r.work_review_id,
        rating: r.rating,
        comment: r.comment,
        created_at: r.created_at,
        reviewer_name: r.user?.name || null,
        job_title: r.work_job?.title || null,
        category_name: r.work_job?.work_category?.name || null,
      })),
    });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch reviews' }); }
});

// GET /workers/me/jobs/cancelled — worker's cancelled jobs (excludes employer-cancelled jobs).
router.get('/me/jobs/cancelled', authenticateToken, async (req, res) => {
  try {
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.json([]);
    const jobs = await prisma.work_job.findMany({
      where: {
        assigned_worker_id: p.worker_profile_id,
        status: 'cancelled',
        // Exclude jobs cancelled by the employer (no penalty to worker)
        NOT: {
          cancellation_reason: {
            contains: 'Cancelled by employer',
          },
        },
      },
      orderBy: { updated_at: 'desc' },
      include: { work_category: { select: { name: true, slug: true } } },
    });
    res.json(jobs);
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch cancelled jobs' }); }
});


/**
 * GET /workers/me/analytics/overview?range=7d|28d|90d|365d|lifetime
 *
 * On-demand worker analytics in the unified panel shape (summary gross/net/count +
 * deltas, per-day timeseries, breakdown=jobs by category, top=best-paying categories),
 * plus a `metrics` array of reliability/rating stats (completion rate, cancellation
 * count, lifetime vs recent rating, tips). Completed jobs are bucketed by updated_at
 * (the completion timestamp). Gross = full hirer charge; net = worker_payout + tip.
 */
router.get('/me/analytics/overview', authenticateToken, async (req, res, next) => {
  try {
    const rangeParam = resolveRangeParam(req.query.range);
    const days = RANGE_DAYS[rangeParam];
    const { start, prevStart, prevEnd } = resolveRange(days);

    const emptySeries = buildEarningsSeries({ rows: [], dateField: 'updated_at', gross: workJobGross, net: workJobNet, start, days });
    const empty = { successful: true, data: { range: rangeParam, currency: 'CAD', summary: emptySeries.summary, timeseries: emptySeries.timeseries, breakdown: [], top: [], metrics: [] } };

    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id }, select: { worker_profile_id: true, rating: true } });
    if (!p) return res.json(empty);
    const worker_id = p.worker_profile_id;

    const baseSelect = {
      work_job_id: true, price_type: true, hirer_set_price: true, hourly_rate: true,
      duration_hours: true, worker_payout: true, tip_amount: true, status: true,
      category_id: true, updated_at: true,
    };
    const [rows, prevRows, allAssigned, employerCancelledCount] = await Promise.all([
      prisma.work_job.findMany({ where: { assigned_worker_id: worker_id, status: 'completed', updated_at: { gte: start } }, select: baseSelect }),
      prisma.work_job.findMany({ where: { assigned_worker_id: worker_id, status: 'completed', updated_at: { gte: prevStart, lte: prevEnd } }, select: { price_type: true, hirer_set_price: true, hourly_rate: true, duration_hours: true, worker_payout: true, tip_amount: true } }),
      // every job ever assigned to this worker, for lifetime completion/cancellation reliability
      prisma.work_job.groupBy({ by: ['status'], where: { assigned_worker_id: worker_id }, _count: { _all: true } }),
      // count of jobs cancelled by employer (to exclude from worker cancellation metrics)
      prisma.work_job.count({
        where: {
          assigned_worker_id: worker_id,
          status: 'cancelled',
          cancellation_reason: { contains: 'Cancelled by employer' },
        },
      }),
    ]);

    const { timeseries, summary } = buildEarningsSeries({ rows, prevRows, dateField: 'updated_at', gross: workJobGross, net: workJobNet, start, days });
    const tipsTotal = round2(rows.reduce((s, j) => s + (j.tip_amount || 0), 0));

    // breakdown + top: jobs grouped by work category
    const catIds = [...new Set(rows.map(j => j.category_id).filter(Boolean))];
    const catNames = new Map();
    if (catIds.length) {
      try {
        const cats = await prisma.work_category.findMany({ where: { work_category_id: { in: catIds } }, select: { work_category_id: true, name: true } });
        cats.forEach(c => catNames.set(c.work_category_id, c.name));
      } catch { /* taxonomy drift — fall back to a generic label */ }
    }
    const byCat = new Map();
    for (const j of rows) {
      const id = j.category_id ?? 0;
      const e = byCat.get(id) || { id, title: catNames.get(id) || 'Other', gross: 0, net: 0, count: 0 };
      e.gross += workJobGross(j); e.net += workJobNet(j); e.count += 1;
      byCat.set(id, e);
    }
    const catList = [...byCat.values()].sort((a, b) => b.net - a.net);
    const breakdown = catList.map(c => ({ label: c.title, value: c.count }));
    const top = catList.slice(0, 8).map(c => ({ id: c.id, title: c.title, subtitle: `${c.count} job${c.count === 1 ? '' : 's'}`, gross: round2(c.gross), net: round2(c.net), count: c.count }));

    // reliability: lifetime completion vs cancellation across all assigned jobs (excluding employer-cancelled)
    const countByStatus = Object.fromEntries(allAssigned.map(g => [g.status, g._count._all]));
    const completedAll = countByStatus['completed'] || 0;
    const cancelledAll = (countByStatus['cancelled'] || 0) - employerCancelledCount; // Exclude employer-cancelled jobs
    const finishedAll = completedAll + cancelledAll;
    const completionRate = finishedAll ? round2((completedAll / finishedAll) * 100) : null;

    const lifetimeRating = p.rating != null ? round2(p.rating) : null;
    // recent rating: reviews on this worker's jobs completed in range
    const reviewRows = await prisma.work_review.findMany({ where: { worker_profile_id: worker_id, created_at: { gte: start } }, select: { rating: true } });
    const reviewCount = reviewRows.length;
    const recentAvg = reviewCount ? round2(reviewRows.reduce((s, r) => s + (r.rating || 0), 0) / reviewCount) : null;

    const metrics = [
      { key: 'completion_rate', label: 'Completion rate', value: completionRate, format: 'pct', hint: `${completedAll} completed of ${finishedAll} finished jobs (lifetime)`, tone: completionRate == null ? 'neutral' : (completionRate >= 90 ? 'good' : completionRate >= 75 ? 'neutral' : 'warn') },
      { key: 'cancellations', label: 'Cancellations', value: cancelledAll, format: 'count', hint: 'Assigned jobs that were cancelled (lifetime)', tone: cancelledAll === 0 ? 'good' : 'warn' },
      { key: 'lifetime_rating', label: 'Lifetime rating', value: lifetimeRating, format: 'rating', hint: 'Your all-time average star rating', tone: lifetimeRating == null ? 'neutral' : (lifetimeRating >= 4.7 ? 'good' : lifetimeRating >= 4 ? 'neutral' : 'warn') },
      { key: 'recent_rating', label: 'Recent rating', value: recentAvg, format: 'rating', hint: `Average across ${reviewCount} review${reviewCount === 1 ? '' : 's'} this period`, tone: recentAvg == null ? 'neutral' : (lifetimeRating != null && recentAvg >= lifetimeRating ? 'good' : 'warn') },
      { key: 'tips', label: 'Tips this period', value: tipsTotal, format: 'money', hint: 'Tips included in your earnings this period', tone: tipsTotal > 0 ? 'good' : 'neutral' },
    ];

    res.json({ successful: true, data: { range: rangeParam, currency: 'CAD', summary, timeseries, breakdown, top, metrics } });
  } catch (err) { next(err); }
});

// ── Post-accept lifecycle (M4) — worker drives en route → start → end. Each transition
// emits work-status-<jobId> to the hirer's room so their tracking UI updates live. ──
async function workerTransition(req, res, allowedFrom, toStatus) {
  try {
    const io = req.app.get('io');
    const jobId = parseInt(req.params.id);
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.status(400).json({ message: 'Not a worker' });
    const job = await prisma.work_job.findUnique({ where: { work_job_id: jobId } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (job.assigned_worker_id !== p.worker_profile_id) return res.status(403).json({ message: 'Not your job' });
    if (!allowedFrom.includes(job.status)) return res.status(409).json({ message: `Cannot move from ${job.status} to ${toStatus}` });
    const updated = await prisma.work_job.update({ where: { work_job_id: jobId }, data: { status: toStatus, updated_at: new Date() } });
// On completion, pay the worker their net payout into their wallet (earnings reflected).
    if (toStatus === 'completed' && Number(job.worker_payout) > 0) {
      await creditWorkWallet(req.user.user_id, Number(job.worker_payout), 'ondemand_work_earning', `Earnings — booking #${jobId} (${job.title || 'job'})`).catch(() => {});
      notifyWork(io, req.user.user_id, 'earning', { work_job_id: jobId, params: { jobTitle: job.title || '', amount: Number(job.worker_payout).toFixed(2) } });
    }
    // On completion, reward the worker with +1 reliability point (capped at +1/day).
    if (toStatus === 'completed' && job.assigned_worker_id) {
      rewardCompletion(job.assigned_worker_id, jobId).catch(() => {});
    }
    // Recruit = worker receives the job, not the hirer.
    if (toStatus === 'completed') {
      const gmv = Number(job.hirer_set_price) || 0;
      await creditRecruiterShares({
        participantUserIds: [req.user.user_id],
        subtotal: gmv,
        platformTake: gmv * ((Number(job.platform_fee_pct) || 8) / 100),
        orderType: 'work', orderRef: jobId,
      });
    }
    if (job.hirer_id) {
      io?.to(`user-${job.hirer_id}`).emit(`work-status-${jobId}`, { work_job_id: jobId, status: toStatus });
      notifyWork(io, job.hirer_id, toStatus, { work_job_id: jobId, params: { jobTitle: job.title || '' } });
    }
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to update job status' }); }
}

router.patch('/jobs/:id/en-route', authenticateToken, (req, res) => workerTransition(req, res, ['accepted'], 'worker_en_route'));
router.patch('/jobs/:id/start', authenticateToken, (req, res) => workerTransition(req, res, ['accepted', 'worker_en_route'], 'in_progress'));
router.patch('/jobs/:id/end', authenticateToken, (req, res) => workerTransition(req, res, ['in_progress'], 'completed'));

const ONDEMAND_NEARBY_TAKE = 80;
const ONDEMAND_NEARBY_LIMIT = 50;
const CATALOG_NEARBY_TAKE = 24;
const CATALOG_NEARBY_LIMIT = 20;

function workerCategoryNested(catIds) {
  return {
    where: catIds?.length ? { work_category_id: { in: catIds } } : undefined,
    select: {
      work_category_id: true,
      work_category: { select: { work_category_id: true, name: true, slug: true } },
      price_type: true,
      hourly_rate: true,
      flat_rate: true,
      worker_package: {
        where: { is_active: true },
        select: { worker_package_id: true, name: true, price: true, duration_hours: true },
        orderBy: { price: 'asc' },
      },
    },
    orderBy: { work_category_id: 'asc' },
    take: 1,
  };
}

function fuzzWorkerLng(lng, lat, seed) {
  const cosLat = Math.cos(lat * Math.PI / 180);
  const scale = 111000 * Math.max(Math.abs(cosLat), 0.01);
  return lng + (((seed * 7) % 300) - 150) / scale;
}

async function findNearbyWorkerRows(where, catIdsForRates, take) {
  return prisma.worker_profile.findMany({
    where,
    select: {
      worker_profile_id: true, current_lat: true, current_long: true, rating: true, bio: true, is_available: true,
      user: { select: { name: true, channel: { select: { profile_pic_url: true } } } },
      worker_category: workerCategoryNested(catIdsForRates),
    },
    take,
  });
}

function requireAuthIfCatalog(req, res, next) {
  const catalog = req.query.catalog === '1' || req.query.catalog === 'true';
  if (!catalog) return next();
  return authenticateToken(req, res, next);
}

// GET /workers/nearby?category_slug=&lat=&lng=&radius=5&catalog=1
// On-demand (default): public, available workers near lat/lng (initial + rating, fuzzed coords).
// catalog=1 (Book Artist): auth required; offline providers with rates/packages; lat/lng optional.
router.get('/nearby', requireAuthIfCatalog, async (req, res) => {
  try {
    const { category_slug, lat, lng, radius = 5, catalog } = req.query;
    const catalogMode = catalog === '1' || catalog === 'true';
    const centerLat = parseFloat(lat);
    const centerLng = parseFloat(lng);
    const hasCenter = !isNaN(centerLat) && !isNaN(centerLng);
    if (!catalogMode && !hasCenter) return res.status(400).json({ message: 'lat and lng are required' });
    if (catalogMode) {
      const slugs = String(category_slug || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (slugs.length === 0) return res.status(400).json({ message: 'category_slug is required' });
    }
    const r = Number.isFinite(parseFloat(radius)) ? parseFloat(radius) : 5;
    const where = {};
    if (!catalogMode) {
      const latDelta = r / 111;
      const lngDelta = r / (111 * Math.cos(centerLat * Math.PI / 180));
      where.is_available = true;
      where.current_lat = { gte: centerLat - latDelta, lte: centerLat + latDelta };
      where.current_long = { gte: centerLng - lngDelta, lte: centerLng + lngDelta };
    }
    let catIdsForRates = null;
    if (category_slug) {
      const slugs = String(category_slug)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (slugs.length > 0) {
        const cats = await prisma.work_category.findMany({
          where: { slug: { in: slugs }, is_active: true },
          select: { work_category_id: true },
        });
        if (cats.length === 0) return res.json([]);
        catIdsForRates = cats.map(c => c.work_category_id);
        where.worker_category = { some: { work_category_id: { in: catIdsForRates } } };
      }
    }
    const take = catalogMode ? CATALOG_NEARBY_TAKE : ONDEMAND_NEARBY_TAKE;
    const limit = catalogMode ? CATALOG_NEARBY_LIMIT : ONDEMAND_NEARBY_LIMIT;
    const workers = await findNearbyWorkerRows(where, catIdsForRates, take);
    const results = workers
      .map(w => {
        const hasCoords = w.current_lat != null && w.current_long != null;
        let distKm = null;
        if (hasCenter && hasCoords) {
          const dLat = w.current_lat - centerLat;
          const dLng = w.current_long - centerLng;
          const a = Math.sin(dLat * Math.PI / 180 / 2) ** 2 + Math.cos(centerLat * Math.PI / 180) * Math.cos(w.current_lat * Math.PI / 180) * Math.sin(dLng * Math.PI / 180 / 2) ** 2;
          distKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          if (distKm > r) return null;
        } else if (!catalogMode) {
          return null;
        }
        const seed = w.worker_profile_id * 17 + Date.now() % 1000;
        const fLat = hasCoords ? w.current_lat + ((seed % 300) - 150) / 111000 : null;
        const fLng = hasCoords ? fuzzWorkerLng(w.current_long, w.current_lat, seed) : null;
        const wc = w.worker_category?.[0] || null;
        const name = (w.user?.name || '').trim() || null;
        const packages = wc?.worker_package || [];
        const hasRate = Number(wc?.hourly_rate) > 0 || Number(wc?.flat_rate) > 0 || packages.some((p) => Number(p?.price) > 0);
        const row = {
          id: w.worker_profile_id,
          lat: fLat,
          lng: fLng,
          rating: w.rating,
          dist_km: distKm != null ? Math.round(distKm * 10) / 10 : null,
          photo: w.user?.channel?.profile_pic_url ?? null,
          initial: (name || '?').trim()[0]?.toUpperCase() ?? '?',
          is_available: !!w.is_available,
          price_type: wc?.price_type || null,
          hourly_rate: wc?.hourly_rate ?? null,
          flat_rate: wc?.flat_rate ?? null,
          packages,
          category: wc?.work_category || null,
          has_rate: hasRate,
        };
        // Full name/bio only on the authenticated catalog browse — public nearby stays initial + rating.
        if (catalogMode) {
          row.name = name;
          row.bio = w.bio || null;
        }
        return row;
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (!!b.is_available !== !!a.is_available) return b.is_available ? 1 : -1;
        if (!!b.has_rate !== !!a.has_rate) return b.has_rate ? 1 : -1;
        const da = a.dist_km == null ? Infinity : a.dist_km;
        const db = b.dist_km == null ? Infinity : b.dist_km;
        return da - db;
      })
      .slice(0, limit);
    res.json(results);
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch nearby workers' }); }
});

// GET /workers/me/jobs — the worker's assigned jobs (active + completed, excludes employer-cancelled).
router.get('/me/jobs', authenticateToken, async (req, res) => {
  try {
    const p = await prisma.worker_profile.findFirst({ where: { user_id: req.user.user_id } });
    if (!p) return res.json({ data: [], total: 0, page: 1, limit: 10, totalPages: 0 });

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const status = req.query.status;
    const categoryId = req.query.category_id;
    const dateFrom = req.query.date_from;
    const dateTo = req.query.date_to;

    // Build where clause with filters
    const whereClause = {
      assigned_worker_id: p.worker_profile_id,
      // Exclude jobs cancelled by the employer (no penalty to worker)
      NOT: {
        AND: [
          { status: 'cancelled' },
          { cancellation_reason: { contains: 'Cancelled by employer' } },
        ],
      },
    };

    if (status) {
      whereClause.status = status;
    }

    if (categoryId) {
      whereClause.category_id = parseInt(categoryId);
    }

    if (dateFrom || dateTo) {
      whereClause.created_at = {};
      if (dateFrom) {
        whereClause.created_at.gte = new Date(dateFrom);
      }
      if (dateTo) {
        whereClause.created_at.lte = new Date(dateTo);
      }
    }

    const [jobs, total] = await Promise.all([
      prisma.work_job.findMany({
        where: whereClause,
        orderBy: { updated_at: 'desc' },
        include: { work_category: { select: { name: true, slug: true } } },
        skip,
        take: limit,
      }),
      prisma.work_job.count({
        where: whereClause,
      }),
    ]);

    const totalPages = Math.ceil(total / limit);
    res.json({ data: jobs, total, page, limit, totalPages });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch jobs' }); }
});

export default router;
