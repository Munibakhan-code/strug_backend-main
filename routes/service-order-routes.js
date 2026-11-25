import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin } from '../middleware/require-admin.js';
import { queueServiceOrderEmail } from '../utils/service-order-email.js';
import { resolveRangeParam, resolveRange, RANGE_DAYS, buildEarningsSeries, round2 } from '../utils/analytics-buckets.js';
import { computeCustomerSegments } from '../utils/customer-analytics.js';
import { notify } from '../services/notify.js';
import { settleRecruiterShare } from '../utils/recruiter-settlement.js';

const router = express.Router();


async function notifyAllNearbyProviders(io, order, service_category_id, excludeProviderIds = []) {
  const { deliver_lat, deliver_long, service_type_id, order_id } = order;
  if (!deliver_lat || !deliver_long) return [];

  const radius = 10;
  const latDelta = radius / 111;
  const longDelta = radius / (111 * Math.cos((deliver_lat * Math.PI) / 180));

  const candidates = await prisma.user_service_provider.findMany({
    where: {
      is_online: true,
      is_active: true,
      ...(service_type_id ? { service_type_id } : {}),
      ...(service_category_id ? { service_category_id: Number(service_category_id) } : {}),
      current_lat: { gte: deliver_lat - latDelta, lte: deliver_lat + latDelta },
      current_long: { gte: deliver_long - longDelta, lte: deliver_long + longDelta },
      ...(excludeProviderIds.length > 0 ? { provider_id: { notIn: excludeProviderIds } } : {}),
    },
  });

  candidates.forEach(p => {
    // Existing real-time path — the on-demand provider dashboard listens for this exact event.
    io.to(`user-${p.user_id}`).emit(`work-request-${p.provider_id}`, { order_id });
    // Epic 10: also fire the durable, unified notification. On-demand job requests were the one
    // order type with NO persistence — a provider who wasn't sitting on their dashboard (e.g.
    // watching a video) silently missed the job. notify() lands it in the global bell, fires web
    // push, and — being `actionable` — raises the global popup on whatever page they're on.
    // Fire-and-forget: notify() is fail-open and must not block dispatch.
    notify(io, {
      userId: p.user_id, vertical: 'work', type: 'work.request', urgency: 'actionable',
      title: 'New job request', body: 'A customer needs a service near you.',
      entityType: 'service_order', entityId: order_id, actionUrl: 'sd-work',
      data: { order_id },
    });
  });
  return candidates.map(p => p.provider_id);
}

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET SERVICE ORDERS — admin-only all-orders view or filtered by authenticated provider */
router.get('/', authenticateToken, async (req, res) => {
  try {
    let where = {};
    if (req.user.role !== 'ADMIN') {
      where = { provider_id: req.user.user_id };
    }
    const serviceOrders = await prisma.service_order.findMany({
      where,
      orderBy: { order_id: 'desc' },
      include: {
        user: true,
        checkouts: true,
        user_service_provider: true,
        service_type: true,
        service_ratings: true,
      },
    });
    res.json(serviceOrders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service orders' });
  }
});

/* GET SERVICE ORDER BY ID — auth + ownership. A single order carries the buyer's
   full user record + checkout/payment rows, so it was previously an unauthenticated
   IDOR: any anonymous caller could read any order (and its buyer PII) by id. Visible
   only to the buyer, the assigned provider, or an admin — matching how the list route
   scopes by buyer_id/provider_id === req.user.user_id. */
router.get('/:order_id', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    if (Number.isNaN(order_id)) return res.status(400).json({ error: 'order_id must be a number' });

    const serviceOrder = await prisma.service_order.findUnique({
      where: { order_id },
      include: {
        user: true,
        checkouts: true,
        user_service_provider: true,
        service_type: true,
        service_ratings: true,
      },
    });
    if (!serviceOrder) return res.status(404).json({ error: 'Service order not found' });

    const isOwner =
      serviceOrder.buyer_id === req.user.user_id ||
      serviceOrder.provider_id === req.user.user_id;
    if (!isAdmin(req) && !isOwner) return res.status(403).json({ error: 'Forbidden' });

    res.json(serviceOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service order' });
  }
});

/* GET SERVICE ORDERS BY BUYER ID — auth + self-or-admin. Was unauthenticated, so any
   caller could enumerate any buyer's order history by id. */
router.get('/buyer/:buyer_id', authenticateToken, async (req, res) => {
  try {
    const buyer_id = Number(req.params.buyer_id);
    if (Number.isNaN(buyer_id)) return res.status(400).json({ error: 'buyer_id must be a number' });

    if (!isAdmin(req) && buyer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const serviceOrders = await prisma.service_order.findMany({
      where: { buyer_id },
      orderBy: { date: 'desc' },
      include: { user_service_provider: true, service_type: true },
    });
    res.json(serviceOrders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service orders for buyer' });
  }
});

/**
 * POST /service-order
 * Creates order and auto-notifies nearest available provider.
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const {
      provider_id, total, qty, date,
      payment_method, expire_date, service_type_id, note,
      checkout_id, deliver_lat, deliver_long, service_category_id,
    } = req.body;

    const serviceOrder = await prisma.service_order.create({
      data: {
        provider_id,
        buyer_id: req.user.user_id, // C1+C2: always from JWT, never body
        total,
        qty,
        date: date ? new Date(date) : new Date(),
        ispaid: false, // C1: always false on creation; only settable via /pay endpoint
        payment_method,
        expire_date: expire_date ? new Date(expire_date) : undefined,
        service_type_id,
        note,
        checkout_id,
        deliver_lat,
        deliver_long,
        status: 'pending',
      },
      include: {
        user: { select: { name: true, email: true, language: true } },
        user_service_provider: true,
        service_type: true,
      },
    });

    const activeAd = await prisma.ads_campaign.findFirst({
      where: { advertiser_id: serviceOrder.user_service_provider?.user_id, status: "ACTIVE" }
    });
    if (activeAd) {
      const { trackAdEvent } = await import('../utils/ads-delivery-engine.js');
      await trackAdEvent(
        activeAd.campaign_id,
        "impression",
        req.user.profile_id,
        req.ip || "127.0.0.1",
        io
      ).catch(() => null);
    }

    await notifyAllNearbyProviders(io, serviceOrder, service_category_id);

    queueServiceOrderEmail(serviceOrder, 'placed');

    res.status(201).json({ successful: true, data: serviceOrder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create service order' });
  }
});

/**
 * PUT /service-order/:order_id/accept
 * Provider accepts the order.
 */
router.put('/:order_id/accept', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);

    // S4: verify the caller is actually a registered provider
    const providerRecord = await prisma.user_service_provider.findFirst({
      where: { user_id: req.user.user_id, is_active: true },
    });
    if (!providerRecord) {
      return res.status(403).json({ successful: false, message: 'Not a registered provider' });
    }

    const updated = await prisma.service_order.updateMany({
      where: { order_id, status: 'pending' },
      data: { status: 'accepted', provider_id: providerRecord.provider_id },
    });
    if (updated.count === 0)
      return res.status(409).json({ successful: false, message: 'Order no longer pending' });

    const order = await prisma.service_order.findUnique({
      where: { order_id },
      include: {
        user: { select: { name: true, email: true, language: true } },
        service_type: true,
        user_service_provider: { include: { user: { select: { name: true } } } },
      },
    });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });

    io.to(`work-customer-${order.buyer_id}`).emit(`work-accepted-${order_id}`, { message: 'Provider is on the way!' });

    queueServiceOrderEmail(order, 'accepted', {
      other_party_name: order.user_service_provider?.user?.name || 'Provider',
    });

    return res.json({ successful: true, message: 'Order accepted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * PUT /service-order/:order_id/decline
 * Provider declines — recorded for bookkeeping. Order stays open for other providers
 * who already received the broadcast when the order was created.
 */
router.put('/:order_id/decline', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    const { provider_id } = req.body;
    if (!provider_id) return res.status(400).json({ successful: false, message: 'provider_id required' });

    const order = await prisma.service_order.findUnique({ where: { order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.status !== 'pending') return res.status(400).json({ successful: false, message: 'Order no longer pending' });

    const updatedDeclined = [...(order.declined_provider_ids || []), Number(provider_id)];
    await prisma.service_order.update({
      where: { order_id },
      data: { declined_provider_ids: updatedDeclined },
    });

    // Re-notify any other nearby providers not yet notified (e.g. came online after initial broadcast)
    notifyAllNearbyProviders(io, order, null, updatedDeclined).catch(() => {});

    return res.json({ successful: true, message: 'Declined' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * POST /service-order/:order_id/bid
 * Provider expresses interest — emits work-bid to customer's socket room.
 * Does NOT change order status; customer then calls /accept to finalize.
 */
router.post('/:order_id/bid', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    const order = await prisma.service_order.findUnique({ where: { order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ successful: false, message: 'Order no longer open' });

    const providerRecord = await prisma.user_service_provider.findFirst({
      where: { user_id: req.user.user_id, is_active: true },
      include: { user: { select: { name: true } } },
    });
    if (!providerRecord) return res.status(403).json({ successful: false, message: 'Not a registered provider' });

    const avgRating = await prisma.service_ratings.aggregate({
      where: { provider_id: providerRecord.provider_id },
      _avg: { rating: true },
      _count: { rating: true },
    });

    let eta_minutes = null;
    if (order.deliver_lat && order.deliver_long && providerRecord.current_lat && providerRecord.current_long) {
      const R = 6371;
      const dLat = ((providerRecord.current_lat - order.deliver_lat) * Math.PI) / 180;
      const dLon = ((providerRecord.current_long - order.deliver_long) * Math.PI) / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos((order.deliver_lat*Math.PI)/180) * Math.cos((providerRecord.current_lat*Math.PI)/180) * Math.sin(dLon/2)**2;
      const dist_km = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      eta_minutes = Math.round((dist_km / 30) * 60);
    }

    const bidPayload = {
      order_id,
      provider_id: providerRecord.provider_id,
      display_name: providerRecord.user?.name ?? 'Provider',
      rating: avgRating._avg.rating ? Math.round(avgRating._avg.rating * 100) / 100 : null,
      job_count: avgRating._count.rating,
      eta_minutes,
    };

    io.to(`work-customer-${order.buyer_id}`).emit('work-bid', bidPayload);
    return res.json({ successful: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * PATCH /service-order/:order_id/start
 * Provider marks work as started.
 */
router.patch('/:order_id/start', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    const order = await prisma.service_order.findUnique({ where: { order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.status !== 'accepted')
      return res.status(400).json({ successful: false, message: 'Order must be accepted before starting' });

    await prisma.service_order.update({ where: { order_id }, data: { status: 'in_progress' } });
    io.to(`work-customer-${order.buyer_id}`).emit(`work-started-${order_id}`, { message: 'Work has started!' });
    return res.json({ successful: true, message: 'Work started' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * PATCH /service-order/:order_id/complete
 * Provider completes the work. Pricing + wallet credit handled here.
 */
router.patch('/:order_id/complete', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const order_id = Number(req.params.order_id);
    const order = await prisma.service_order.findUnique({
      where: { order_id },
      include: { user_service_provider: true },
    });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.status !== 'in_progress')
      return res.status(400).json({ successful: false, message: 'Order must be in_progress to complete' });
    if (!order.ispaid)
      return res.status(402).json({ successful: false, message: 'Order has not been paid' });

    const total = order.total || 0;
    const strugCut = parseFloat(process.env.WORK_GOV_TAX || '0.21'); // 21% total platform deduction
    const workerNet = total * (1 - strugCut);
    const platformTake = round2(total * strugCut);

    await prisma.$transaction(async (tx) => {
      await tx.service_order.update({ where: { order_id }, data: { status: 'completed' } });

      if (order.provider_id) {
        const provider = await tx.user_service_provider.findUnique({
          where: { provider_id: order.provider_id },
        });
        if (provider?.user_id) {
          let wallet = await tx.strug_wallet.findFirst({ where: { user_id: provider.user_id } });
          if (!wallet) wallet = await tx.strug_wallet.create({ data: { user_id: provider.user_id, balance: 0, currency: 'CAD' } });

          await tx.strug_wallet.update({
            where: { wallet_id: wallet.wallet_id },
            data: { balance: { increment: workerNet } },
          });
          await tx.wallet_transaction.create({
            data: {
              user_id: provider.user_id,
              amount: workerNet,
              type: 'credit',
              source: 'work_order',
            },
          });
        }
      }
    });

    const providerUserId = order.user_service_provider?.user_id
      ?? (order.provider_id
        ? (await prisma.user_service_provider.findUnique({
          where: { provider_id: order.provider_id },
          select: { user_id: true },
        }))?.user_id
        : null);
    // Recruit = provider receives the work, not the buyer.
    await settleRecruiterShare({
      orderType: 'service',
      orderRef: order_id,
      participantUserIds: [providerUserId],
      subtotal: total,
      platformTake,
    });

    io.to(`work-customer-${order.buyer_id}`).emit(`work-completed-${order_id}`, { message: 'Work completed!' });
    return res.json({ successful: true, message: 'Order completed', worker_net: workerNet.toFixed(2) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* UPDATE SERVICE ORDER */
router.put('/:order_id', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    if (Number.isNaN(order_id)) return res.status(400).json({ error: 'order_id must be a number' });

    const existing = await prisma.service_order.findUnique({ where: { order_id } });
    if (!existing) return res.status(404).json({ error: 'Service order not found' });
    const isOwner = existing.buyer_id === req.user.user_id || existing.provider_id === req.user.user_id;
    if (!isAdmin(req) && !isOwner) return res.status(403).json({ error: 'Forbidden' });

    const {
      qty, date,
      expire_date, note,
      status, deliver_lat, deliver_long,
    } = req.body;

    const updated = await prisma.service_order.update({
      where: { order_id },
      data: {
        provider_id: existing.provider_id,
        buyer_id: existing.buyer_id,
        total: existing.total,
        qty: qty ?? existing.qty,
        date: date ? new Date(date) : existing.date,
        ispaid: existing.ispaid,
        payment_method: existing.payment_method,
        expire_date: expire_date ? new Date(expire_date) : existing.expire_date,
        service_type_id: existing.service_type_id,
        note: note ?? existing.note,
        checkout_id: existing.checkout_id,
        status: status ?? existing.status,
        deliver_lat: deliver_lat ?? existing.deliver_lat,
        deliver_long: deliver_long ?? existing.deliver_long,
      },
      include: {
        user: true, checkouts: true,
        user_service_provider: true, service_type: true, service_ratings: true,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update service order' });
  }
});

/**
 * GET /service-order/provider/analytics/overview?range=7d|28d|90d|365d|lifetime
 *
 * Analytics for service-provider portals that run on the service_order table
 * (decor, automotive, and other non-booking-engine service verticals). Returns the
 * shared SellerAnalyticsPanel shape: summary (gross/net/count + deltas), per-day
 * timeseries, breakdown (orders by status), top (top service types by revenue).
 *
 * Scoping mirrors the orders/earnings tabs on those same dashboards — `GET /service-order`
 * filters `provider_id === req.user.user_id`, so we scope identically here for a consistent
 * picture. service_order has no stored platform-fee/tax columns, so net == gross (flat-priced).
 * Only paid orders count; buckets use created_at (timestamp; `date` is @db.Date, coarser).
 */
router.get('/provider/analytics/overview', authenticateToken, async (req, res) => {
  try {
    const provider_id = req.user.user_id;
    const rangeParam = resolveRangeParam(req.query.range);
    const days = RANGE_DAYS[rangeParam];
    const { start, prevStart, prevEnd } = resolveRange(days);

    const baseSelect = { order_id: true, total: true, qty: true, status: true, service_type_id: true, created_at: true };
    const [rows, prevRows] = await Promise.all([
      prisma.service_order.findMany({
        where: { provider_id, ispaid: true, created_at: { gte: start } },
        select: baseSelect,
      }),
      prisma.service_order.findMany({
        where: { provider_id, ispaid: true, created_at: { gte: prevStart, lte: prevEnd } },
        select: { total: true },
      }),
    ]);

    const grossOf = o => o.total || 0;
    const { timeseries, summary } = buildEarningsSeries({ rows, prevRows, dateField: 'created_at', gross: grossOf, net: grossOf, start, days });

    // breakdown: orders by status
    const statusMap = new Map();
    rows.forEach(o => { const k = o.status || 'unknown'; statusMap.set(k, (statusMap.get(k) || 0) + 1); });
    const breakdown = [...statusMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

    // top service types by gross — aggregate by service_type_id, resolve names in a
    // guarded query so a drifted service_type table can't break the endpoint.
    const byType = new Map();
    for (const o of rows) {
      const key = o.service_type_id ?? `order-${o.order_id}`;
      const e = byType.get(key) || { id: key, service_type_id: o.service_type_id, gross: 0, count: 0 };
      e.gross += o.total || 0;
      e.count += o.qty || 1;
      byType.set(key, e);
    }
    const typeIds = [...byType.values()].map(e => e.service_type_id).filter(v => v != null);
    const nameByType = new Map();
    if (typeIds.length) {
      try {
        const types = await prisma.service_type.findMany({
          where: { service_type_id: { in: typeIds } },
          select: { service_type_id: true, service_type_name: true },
        });
        types.forEach(t => nameByType.set(t.service_type_id, t.service_type_name));
      } catch (e) { /* service_type drift — fall back to "Service" */ }
    }
    const top = [...byType.values()]
      .map(e => ({ id: e.id, title: nameByType.get(e.service_type_id) || 'Service', subtitle: `${e.count} order${e.count === 1 ? '' : 's'}`, gross: round2(e.gross), net: round2(e.gross), count: e.count }))
      .sort((a, b) => b.gross - a.gross)
      .slice(0, 8);

    // #327 customer analytics — segmentation over the provider's LIFETIME buyers. Best-effort.
    let customers = null;
    try {
      const lifetime = await prisma.service_order.findMany({
        where: { provider_id, ispaid: true },
        select: { buyer_id: true, total: true, created_at: true },
      });
      customers = computeCustomerSegments(
        lifetime.map(o => ({ customer_id: o.buyer_id, at: o.created_at, amount: o.total })),
      );
    } catch (e) { /* omit customers block on failure */ }

    res.json({ successful: true, data: { range: rangeParam, currency: 'CAD', summary, timeseries, breakdown, top, customers } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to load analytics.' });
  }
});

/* DELETE SERVICE ORDER */
router.delete('/:order_id', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    if (Number.isNaN(order_id)) return res.status(400).json({ error: 'order_id must be a number' });
    const existing = await prisma.service_order.findUnique({ where: { order_id } });
    if (!existing) return res.status(404).json({ error: 'Service order not found' });
    if (!isAdmin(req) && existing.buyer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await prisma.service_order.delete({ where: { order_id } });
    res.json({ message: 'Service order deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete service order' });
  }
});

export default router;
