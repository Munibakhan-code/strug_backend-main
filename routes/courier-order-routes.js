import express from 'express';
import crypto from 'crypto';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { RANGE_DAYS, resolveRangeParam, resolveRange, buildEarningsSeries, round2 } from '../utils/analytics-buckets.js';
import { buildCourierFareEstimates, courierQuoteInputs } from '../utils/courier-fare.js';
import { verifyQuote } from '../utils/price-quote.js';
import { clearCourierLocation } from '../utils/courier-socket.js';
import { notify } from '../services/notify.js';
import { resolveCourierDriverForUser } from '../utils/driver-identity.js';
import { getBusyDriverProfileIds } from '../utils/driver-busy.js';
import { haversineKm } from '../utils/ride-fare.js';
import {
  findOrCreateDriverDeliveryBatch,
  refreshFoodDeliveryBatchRoutePlan,
} from '../utils/delivery-dispatch.js';

const router = express.Router();

// The order stores a courier_customer FK (customer_id), not a user_id. To reach the
// customer's socket room (`user-${userId}`) we resolve their user_id from that row.
async function customerUserId(order) {
  if (!order?.customer_id) return null;
  const cc = await prisma.courier_customer.findUnique({
    where: { customer_id: order.customer_id },
    select: { user_id: true },
  });
  return cc?.user_id ?? null;
}

// URL-safe, not derived from the order id — leaking it reveals nothing about other
// orders, and it can be revoked by nulling the column without touching a signing key.
function generateTrackingToken() {
  return crypto.randomBytes(16).toString('base64url');
}

/** #1296: tracking links expire after 30 days unless cancelled earlier. */
const TRACKING_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function trackingTokenExpiresAt(from = new Date()) {
  return new Date(from.getTime() + TRACKING_TOKEN_TTL_MS);
}

function isTrackingTokenExpired(order) {
  if (!order?.tracking_token_expires_at) return false; // legacy rows until rotated
  return Date.now() > new Date(order.tracking_token_expires_at).getTime();
}

function formatDistanceKm(km) {
  if (!Number.isFinite(km) || km < 0) return '—';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

/** ETA from distance at ~30 km/h — mirrors ride-dispatch.js/delivery-dispatch.js's estimate. */
function formatEtaFromDistanceKm(distanceKm) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return '—';
  const etaMin = (distanceKm / 30) * 60;
  return `~${Math.max(1, Math.round(etaMin))} min`;
}

function activeDeliveryStatusWhere(fieldName) {
  return { OR: [{ [fieldName]: null }, { [fieldName]: { notIn: ['delivered', 'cancelled'] } }] };
}

// Mirrors /deliver's payout: 79% of the order price (21% platform fee).
function courierDriverPayout(price) {
  const p = parseFloat(price);
  return Number.isFinite(p) && p > 0 ? +(p * 0.79).toFixed(2) : null;
}

/**
 * Driver-facing offer payload for a courier order — shared by the socket dispatch on
 * creation and the ?available=true poll fallback, so a driver sees the same fare/
 * distance/ETA regardless of which path delivered the offer. Board: the unified
 * driver takeover (IncomingOfferTakeover) reads `driver_payout`, `distance`, `eta`,
 * `pickup_distance`/`pickup_eta` the same way for every job type — courier orders
 * used to omit all of them, so the takeover showed an empty card for courier jobs.
 */
function buildCourierOfferPayload(order, driverPos = null) {
  const startLat = order.start_location_lat != null ? Number(order.start_location_lat) : null;
  const startLng = order.start_location_long != null ? Number(order.start_location_long) : null;
  const endLat = order.end_location_lat != null ? Number(order.end_location_lat) : null;
  const endLng = order.end_location_long != null ? Number(order.end_location_long) : null;
  const tripKm = [startLat, startLng, endLat, endLng].every(Number.isFinite)
    ? haversineKm(startLat, startLng, endLat, endLng)
    : null;

  const payload = {
    order_type: 'courier_order',
    order_id: order.courier_order_id,
    id: order.courier_order_id,
    pickup_location: order.start_location_address ?? 'Pickup',
    dropoff_location: order.end_location_address ?? 'Dropoff',
    driver_payout: courierDriverPayout(order.price),
    price: order.price,
    status: order.status,
    distance: tripKm != null ? formatDistanceKm(tripKm) : '—',
    eta: tripKm != null ? formatEtaFromDistanceKm(tripKm) : '—',
  };

  if (driverPos && Number.isFinite(driverPos.lat) && Number.isFinite(driverPos.long) && startLat != null && startLng != null) {
    const pickupKm = haversineKm(driverPos.lat, driverPos.long, startLat, startLng);
    payload.pickup_distance = formatDistanceKm(pickupKm);
    payload.pickup_eta = formatEtaFromDistanceKm(pickupKm);
  }

  return payload;
}

// Deep-link + copy for the unified bell, keyed by the lifecycle step. Kept next to the socket emit
// so a new courier step can't add a live-only ping and forget the durable notification.
const COURIER_UNIFIED = {
  accepted:  { title: 'A courier accepted your delivery', body: 'Your courier is on the way to collect it.' },
  picked_up: { title: 'Your package has been picked up',  body: 'It is on its way to the drop-off.' },
  delivered: { title: 'Your package was delivered',       body: null },
  cancelled: { title: 'Your delivery was cancelled',      body: null },
};

// `step` is the lifecycle key (accepted/picked_up/...), `event` the legacy per-order socket name.
// Emits live AND persists a durable notification — a customer who had the tab closed still finds
// out their package moved.
async function notifyCustomer(io, order, event, payload, step = null) {
  const uid = await customerUserId(order);
  if (!uid) return;
  if (io) io.to(`user-${uid}`).emit(event, payload);

  const u = step && COURIER_UNIFIED[step];
  if (u) {
    notify(io, {
      userId: uid,
      vertical: 'courier',
      type: `courier.${step}`,
      title: u.title,
      body: u.body,
      urgency: 'ambient',
      entityType: 'courier_order',
      entityId: order.courier_order_id ?? null,
      actionUrl: 'orders',
    });
  }
}

// The courier-capable driver_profile row for the authenticated user, or null. Used to
// authorize the driver-only actions (claim/pickup/deliver) and the job feed.
// Returns .courier_service_provider_id as an alias for driver_profile_id.
async function callerProvider(req) {
  return resolveCourierDriverForUser(req.user.user_id);
}

/**
 * Get courier orders.
 *   ?available=true  -> pending, unassigned orders for online couriers to claim
 *   ?public=true     -> all orders (admin/debug)
 *   otherwise        -> the caller's own orders (by their courier_customer rows)
 */
router.get('/', async (req, res) => {
  try {
    // Drivers' job feed: pending orders no provider has accepted yet. Couriers only,
    // and only the fields needed to decide on a job (no customer PII / checkouts).
    if (req.query.available === 'true') {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1];
      if (!token) return res.status(401).json({ error: 'Authentication required' });
      let decoded;
      try {
        const jwt = (await import('jsonwebtoken')).default;
        decoded = jwt.verify(token, process.env.ACCESS_TOKEN_KEY);
      } catch { return res.status(401).json({ error: 'Invalid token' }); }
      const provider = await resolveCourierDriverForUser(decoded.user_id);
      if (!provider) return res.status(403).json({ error: 'Courier registration required' });
      if (!provider.accepts_courier) return res.json([]);
      const orders = await prisma.courier_order.findMany({
        where: { status: 'pending', courier_service_provider_id: null },
        orderBy: { courier_order_id: 'desc' },
        take: Math.min(Math.max(Number(req.query.limit) || 50, 1), 100),
        select: {
          courier_order_id: true,
          start_location_address: true,
          end_location_address: true,
          start_location_lat: true,
          start_location_long: true,
          end_location_lat: true,
          end_location_long: true,
          price: true,
          status: true,
        },
      });
      // Same offer shape the socket dispatch uses, so a driver sees identical fare/
      // distance/ETA whether the offer arrived live or was picked up by this poll.
      const driverPos = Number.isFinite(provider.current_lat) && Number.isFinite(provider.current_long)
        ? { lat: provider.current_lat, long: provider.current_long }
        : null;
      return res.json(orders.map((o) => buildCourierOfferPayload(o, driverPos)));
    }

    // Customer "my courier orders" view. This include carries checkouts (payment),
    // customer PII and tracking tokens, so it must never be public. Previously `where`
    // stayed empty for anonymous callers AND for `?public=true`, dumping EVERY courier
    // order to anyone. Require a valid token and scope strictly to the caller's own
    // courier_customer rows.
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    let decoded;
    try {
      // Use the same key the rest of the app verifies access tokens with.
      const jwt = (await import('jsonwebtoken')).default;
      decoded = jwt.verify(token, process.env.ACCESS_TOKEN_KEY);
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
    // customer_id is a courier_customer FK, not a user_id — scope by the
    // caller's courier_customer rows.
    const where = { courier_customer: { is: { user_id: decoded.user_id } } };
    const orders = await prisma.courier_order.findMany({
      where,
      orderBy: { courier_order_id: 'desc' },
      take: Math.min(Math.max(Number(req.query.limit) || 50, 1), 100),
      include: {
        checkouts: true,
        driver_profile: true,
        courier_customer: true,
      },
    });

    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch courier orders' });
  }
});

/* GET /courier-order/earnings — the authenticated courier's completed deliveries
   and total earnings (79% of delivered order prices). Registered before
   "/:courier_order_id" so "earnings" isn't parsed as an id. */
router.get('/earnings', authenticateToken, async (req, res) => {
  try {
    const provider = await callerProvider(req);
    if (!provider) return res.json({ total: 0, count: 0, deliveries: [] });
    const delivered = await prisma.courier_order.findMany({
      where: { courier_service_provider_id: provider.courier_service_provider_id, status: 'delivered' },
      orderBy: { courier_order_id: 'desc' },
      select: {
        courier_order_id: true,
        start_location_address: true,
        end_location_address: true,
        price: true,
        last_update: true,
      },
    });
    const deliveries = delivered.map((o) => ({
      ...o,
      earning: +(((parseFloat(o.price) || 0) * 0.79)).toFixed(2),
    }));
    const total = +deliveries.reduce((s, d) => s + d.earning, 0).toFixed(2);
    res.json({ total, count: deliveries.length, deliveries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch courier earnings' });
  }
});

/**
 * GET /courier-order/analytics/overview?range=7d|28d|90d|365d|lifetime
 *
 * Courier delivery analytics in the unified panel shape (summary gross/net/count +
 * deltas, per-day timeseries, breakdown=deliveries by payment method), plus a `metrics`
 * array of reliability stats (completion rate, in-transit count, avg delivery time).
 * Money model mirrors /earnings: gross = order price; net = 79% (21% platform fee).
 * Delivered orders are bucketed by deliver_date (set on delivery); legacy rows with no
 * deliver_date fall back to last_update so they still appear. Registered before
 * "/:courier_order_id" so "analytics" isn't parsed as an id.
 */
router.get('/analytics/overview', authenticateToken, async (req, res, next) => {
  try {
    const rangeParam = resolveRangeParam(req.query.range);
    const days = RANGE_DAYS[rangeParam];
    const { start, prevStart, prevEnd } = resolveRange(days);

    const grossOf = o => parseFloat(o.price) || 0;
    const netOf = o => round2((parseFloat(o.price) || 0) * 0.79);

    const emptySeries = buildEarningsSeries({ rows: [], dateField: 'bucket_date', gross: grossOf, net: netOf, start, days });
    const empty = { successful: true, data: { range: rangeParam, currency: 'CAD', summary: emptySeries.summary, timeseries: emptySeries.timeseries, breakdown: [], top: [], metrics: [] } };

    const provider = await callerProvider(req);
    if (!provider) return res.json(empty);
    const pid = provider.courier_service_provider_id;

    const baseSelect = { courier_order_id: true, price: true, payment_method: true, status: true, pickup_date: true, deliver_date: true, last_update: true };
    // delivered rows in range — coalesce a bucket_date (deliver_date ?? last_update) so
    // buildEarningsSeries can place each on a day even for legacy rows without deliver_date.
    const coalesce = o => ({ ...o, bucket_date: o.deliver_date || o.last_update });
    const [rawRows, rawPrev, statusGroups] = await Promise.all([
      prisma.courier_order.findMany({ where: { courier_service_provider_id: pid, status: 'delivered', OR: [{ deliver_date: { gte: start } }, { deliver_date: null, last_update: { gte: start } }] }, select: baseSelect }),
      prisma.courier_order.findMany({ where: { courier_service_provider_id: pid, status: 'delivered', OR: [{ deliver_date: { gte: prevStart, lte: prevEnd } }, { deliver_date: null, last_update: { gte: prevStart, lte: prevEnd } }] }, select: { price: true } }),
      prisma.courier_order.groupBy({ by: ['status'], where: { courier_service_provider_id: pid }, _count: { _all: true } }),
    ]);
    const rows = rawRows.map(coalesce);
    const prevRows = rawPrev;

    const { timeseries, summary } = buildEarningsSeries({ rows, prevRows, dateField: 'bucket_date', gross: grossOf, net: netOf, start, days });

    // breakdown: deliveries by payment method
    const payMap = new Map();
    rows.forEach(o => { const k = (o.payment_method || 'unknown').toUpperCase(); payMap.set(k, (payMap.get(k) || 0) + 1); });
    const breakdown = [...payMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

    // reliability metrics over the provider's lifetime order book
    const countByStatus = Object.fromEntries(statusGroups.map(g => [g.status, g._count._all]));
    const deliveredAll = countByStatus['delivered'] || 0;
    const cancelledAll = countByStatus['cancelled'] || 0;
    const inTransit = (countByStatus['picked_up'] || 0) + (countByStatus['in_transit'] || 0) + (countByStatus['accepted'] || 0);
    const finishedAll = deliveredAll + cancelledAll;
    const completionRate = finishedAll ? round2((deliveredAll / finishedAll) * 100) : null;

    // avg delivery time (mins) from rows that have both pickup + deliver timestamps
    const durations = rows.filter(o => o.pickup_date && o.deliver_date).map(o => (new Date(o.deliver_date) - new Date(o.pickup_date)) / 60000).filter(m => m >= 0);
    const avgDeliveryMins = durations.length ? round2(durations.reduce((s, m) => s + m, 0) / durations.length) : null;

    const metrics = [
      { key: 'completion_rate', label: 'Completion rate', value: completionRate, format: 'pct', hint: `${deliveredAll} delivered of ${finishedAll} finished orders (lifetime)`, tone: completionRate == null ? 'neutral' : (completionRate >= 90 ? 'good' : completionRate >= 75 ? 'neutral' : 'warn') },
      { key: 'in_transit', label: 'Active deliveries', value: inTransit, format: 'count', hint: 'Orders accepted or in transit right now', tone: 'neutral' },
      { key: 'cancellations', label: 'Cancellations', value: cancelledAll, format: 'count', hint: 'Orders cancelled (lifetime)', tone: cancelledAll === 0 ? 'good' : 'warn' },
      { key: 'avg_delivery_time', label: 'Avg delivery time', value: avgDeliveryMins, format: 'duration', hint: 'Average minutes from pickup to delivery', tone: 'neutral' },
    ];

    res.json({ successful: true, data: { range: rangeParam, currency: 'CAD', summary, timeseries, breakdown, top: [], metrics } });
  } catch (err) { next(err); }
});

/**
 * GET /courier-order/nearby?lat=&long=&radius=
 * Live nearby-courier preview for the booking screen — mirrors GET /ride-request/nearby.
 * Must stay registered before /:courier_order_id or "nearby" gets swallowed as an id param.
 */
router.get('/nearby', authenticateToken, async (req, res) => {
  try {
    const { lat, long, radius = 6 } = req.query;
    if (!lat || !long) return res.status(400).json({ successful: false, message: 'lat and long are required' });

    const latVal = Number(lat);
    const longVal = Number(long);
    const radiusVal = Number(radius) || 6;
    const latDelta = radiusVal / 111;
    const longDelta = radiusVal / (111 * Math.cos(latVal * (Math.PI / 180)));

    const nearbyCouriers = await prisma.driver_profile.findMany({
      where: {
        is_online: true,
        accepts_courier: true,
        driver_courier_profile: { isNot: null },
        current_lat: { gte: latVal - latDelta, lte: latVal + latDelta },
        current_long: { gte: longVal - longDelta, lte: longVal + longDelta },
      },
      select: { driver_profile_id: true, current_lat: true, current_long: true },
    });

    const withDistance = nearbyCouriers
      .map((d) => ({
        id: d.driver_profile_id,
        lat: d.current_lat,
        lng: d.current_long,
        distance_km: haversineKm(latVal, longVal, d.current_lat, d.current_long),
      }))
      .sort((a, b) => a.distance_km - b.distance_km);

    return res.json({ successful: true, data: withDistance });
  } catch (err) {
    console.error('Nearby Couriers Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /courier-order/track/:token — no-login tracking link for whoever the sender shares
 * it with. Registered before "/:courier_order_id" so "track" isn't parsed as an id.
 * Deliberately hand-picks fields rather than reusing the owner-scoped include: no price,
 * payment method, or customer/driver records — just enough to render a tracking screen.
 */
router.get('/track/:token', async (req, res) => {
  try {
    const order = await prisma.courier_order.findUnique({
      where: { tracking_token: req.params.token },
      select: {
        courier_order_id: true,
        status: true,
        tracking_token_expires_at: true,
        start_location_address: true,
        end_location_address: true,
        start_location_lat: true,
        start_location_long: true,
        end_location_lat: true,
        end_location_long: true,
        driver_profile: {
          select: {
            current_lat: true,
            current_long: true,
            user: { select: { name: true } },
          },
        },
      },
    });
    if (!order || isTrackingTokenExpired(order)) {
      return res.status(404).json({ error: 'Tracking link not found or no longer active' });
    }

    const driverName = order.driver_profile?.user?.name?.split(' ')[0] || null;
    const lat = order.driver_profile?.current_lat;
    const long = order.driver_profile?.current_long;
    const showLiveLocation = ['accepted', 'picked_up'].includes(order.status) && Number.isFinite(lat) && Number.isFinite(long);

    // ETA to whichever leg is next: pickup while still accepted, dropoff once picked up.
    let etaMin = null;
    if (showLiveLocation) {
      const targetLat = order.status === 'picked_up' ? Number(order.end_location_lat) : Number(order.start_location_lat);
      const targetLng = order.status === 'picked_up' ? Number(order.end_location_long) : Number(order.start_location_long);
      if (Number.isFinite(targetLat) && Number.isFinite(targetLng)) {
        const km = haversineKm(lat, long, targetLat, targetLng);
        etaMin = Math.max(1, Math.round((km / 30) * 60));
      }
    }

    return res.json({
      status: order.status,
      pickup_location: order.start_location_address ?? 'Pickup',
      dropoff_location: order.end_location_address ?? 'Dropoff',
      pickup_lat: order.start_location_lat != null ? Number(order.start_location_lat) : null,
      pickup_lng: order.start_location_long != null ? Number(order.start_location_long) : null,
      dropoff_lat: order.end_location_lat != null ? Number(order.end_location_lat) : null,
      dropoff_lng: order.end_location_long != null ? Number(order.end_location_long) : null,
      driver_first_name: driverName,
      lat: showLiveLocation ? lat : null,
      lng: showLiveLocation ? long : null,
      eta_min: etaMin,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tracking info' });
  }
});

/**
 * Get single courier order
 */
router.get('/:courier_order_id', authenticateToken, async (req, res) => {
  try {
    const order = await prisma.courier_order.findUnique({
      where: { courier_order_id: Number(req.params.courier_order_id) },
      include: {
        checkouts: true,
        driver_profile: true,
        courier_customer: true,
      },
    });

    if (!order)
      return res.status(404).json({ error: 'Courier order not found' });

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch courier order' });
  }
});

/**
 * Create courier order
 */
/**
 * POST /courier-order/fare-estimates
 * Board #460: courier used to quote a hardcoded per-vehicle + per-package price with no route
 * involved at all, so it showed a confident total before the user had entered a pickup or drop-off.
 * Price every vehicle for the real route instead, in a single route resolve — same shape as
 * POST /ride-request/fare-estimates.
 */
router.post('/fare-estimates', authenticateToken, async (req, res) => {
  try {
    const { pickup, dropoff, packageType, urgent } = req.body || {};
    if (!pickup || !dropoff) {
      return res.status(400).json({ successful: false, message: 'pickup and dropoff are required' });
    }

    const result = await buildCourierFareEstimates({ pickup, dropoff, packageType, urgent: !!urgent });
    if (!result.ok) {
      return res.status(result.status).json({ successful: false, message: result.message });
    }
    return res.json({ successful: true, ...result.data });
  } catch (err) {
    console.error('Courier Fare Estimates Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      customer_id,
      courier_service_provider_id,
      start_location_lat,
      start_location_long,
      end_location_lat,
      end_location_long,
      start_location_address,
      end_location_address,
      status,
      pickup_date,
      deliver_date,
      payment_method,
      is_paid,
      price,
      checkout_id,
      package_size,
      vehicle_type,
      urgent,
      quote_id,
    } = req.body;

    if (price !== undefined && parseFloat(price) < 0)
      return res.status(400).json({ error: 'price cannot be negative' });

    // Locked-quote enforcement: wallet is the only payment method that actually moves money
    // for courier today (card/PayPal aren't wired up yet — tracked separately), so it's the
    // one place a raw client-supplied `price` could tamper with what gets debited. Resolve
    // the authoritative amount from the signed quote the fare-estimates endpoint issued
    // instead of trusting req.body.price directly — this also becomes the order's stored
    // `price`, since /deliver later pays the courier 79% of that same field.
    let finalPrice = price;
    if (payment_method === 'wallet') {
      const quoteCheck = verifyQuote(quote_id, courierQuoteInputs({
        pickup: start_location_address, dropoff: end_location_address,
        vehicle: vehicle_type, packageType: package_size, urgent,
      }));
      if (!quoteCheck.ok) {
        return res.status(quoteCheck.status).json({ error: quoteCheck.error, code: 'quote_invalid' });
      }
      finalPrice = quoteCheck.amount;
    }

    // Wallet payment: check balance then deduct
    if (payment_method === 'wallet' && finalPrice) {
      const earnings = await prisma.wallet_transaction.aggregate({
        where: { user_id: req.user.user_id },
        _sum: { amount: true },
      });
      const balance = parseFloat(earnings._sum.amount ?? 0);
      if (balance < parseFloat(finalPrice)) {
        return res.status(402).json({ error: `Insufficient wallet balance. You have $${balance.toFixed(2)} but $${parseFloat(finalPrice).toFixed(2)} is required.` });
      }
      await prisma.wallet_transaction.create({
        data: { user_id: req.user.user_id, amount: -parseFloat(finalPrice), type: 'debit', source: 'courier_payment', description: 'Courier order payment' },
      });
    }

    const newOrder = await prisma.courier_order.create({
      data: {
        customer_id,
        courier_service_provider_id,
        start_location_lat: start_location_lat != null ? String(start_location_lat) : null,
        start_location_long: start_location_long != null ? String(start_location_long) : null,
        end_location_lat: end_location_lat != null ? String(end_location_lat) : null,
        end_location_long: end_location_long != null ? String(end_location_long) : null,
        start_location_address,
        end_location_address,
        status: status || 'pending',
        pickup_date: pickup_date ? new Date(pickup_date) : null,
        deliver_date: deliver_date ? new Date(deliver_date) : null,
        last_update: new Date(),
        payment_method,
        is_paid: payment_method === 'wallet' ? true : (is_paid ?? false),
        price: finalPrice,
        checkout_id,
        tracking_token: generateTrackingToken(),
        tracking_token_expires_at: trackingTokenExpiresAt(),
      },
    });

    if (io) {
      if (courier_service_provider_id) {
        // Targeted dispatch to a specific provider's own room.
        const provider = await prisma.driver_profile.findUnique({
          where: { driver_profile_id: Number(courier_service_provider_id) },
          select: { user_id: true, current_lat: true, current_long: true },
        });
        const offer = buildCourierOfferPayload(newOrder, (Number.isFinite(provider?.current_lat) && Number.isFinite(provider?.current_long))
          ? { lat: provider.current_lat, long: provider.current_long }
          : null);
        if (provider?.user_id) {
          io.to(`user-${provider.user_id}`).emit(
            `courier-order-${provider.user_id}`, offer);
        }
      } else if ((newOrder.status ?? 'pending') === 'pending') {
        // Unassigned: push to the `couriers` room only (online registered couriers
        // join it on connect). Not a global broadcast — and the secured
        // GET ?available=true feed remains the poll fallback. No single driver's
        // position to compare against here, so pickup_distance/eta stay unset.
        io.to('couriers').emit('courier-order-available', buildCourierOfferPayload(newOrder));
      }
    }

    res.status(201).json(newOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create courier order' });
  }
});

/**
 * Update courier order
 */
router.put('/:courier_order_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { courier_order_id } = req.params;

    const existing = await prisma.courier_order.findUnique({
      where: { courier_order_id: Number(courier_order_id) },
      include: { courier_customer: { select: { user_id: true } } },
    });

    if (!existing)
      return res.status(404).json({ error: 'Courier order not found' });

    const customerUid = existing.courier_customer?.user_id ?? await customerUserId(existing);
    const provider = await callerProvider(req);
    const isCustomer = customerUid === req.user.user_id;
    const isAssignedDriver = Boolean(provider && existing.courier_service_provider_id === provider.courier_service_provider_id);
    const admin = req.user.role === 'ADMIN' || req.user.permission === 'admin';
    if (!admin && !isCustomer && !isAssignedDriver) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const {
      start_location_lat,
      start_location_long,
      end_location_lat,
      end_location_long,
      start_location_address,
      end_location_address,
      status,
      pickup_date,
      deliver_date,
    } = req.body;

    const data = {
      last_update: new Date(),
      ...(status === 'cancelled' ? { tracking_token: null, tracking_token_expires_at: null } : {}),
    };
    if (isCustomer || admin) {
      if (start_location_lat !== undefined) data.start_location_lat = start_location_lat;
      if (start_location_long !== undefined) data.start_location_long = start_location_long;
      if (end_location_lat !== undefined) data.end_location_lat = end_location_lat;
      if (end_location_long !== undefined) data.end_location_long = end_location_long;
      if (start_location_address !== undefined) data.start_location_address = start_location_address;
      if (end_location_address !== undefined) data.end_location_address = end_location_address;
      if (pickup_date !== undefined) data.pickup_date = pickup_date ? new Date(pickup_date) : existing.pickup_date;
      if (deliver_date !== undefined) data.deliver_date = deliver_date ? new Date(deliver_date) : existing.deliver_date;
      if (status === 'cancelled') data.status = 'cancelled';
    }
    if ((isAssignedDriver || admin) && status && status !== 'cancelled') {
      data.status = status;
    }

    const updatedOrder = await prisma.courier_order.update({
      where: { courier_order_id: Number(courier_order_id) },
      data,
    });

    io?.emit('courier-order-updated', updatedOrder);

    res.json(updatedOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update courier order' });
  }
});

/**
 * Delete courier order
 */
router.delete('/:courier_order_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const existing = await prisma.courier_order.findUnique({
      where: { courier_order_id: Number(req.params.courier_order_id) },
      include: { courier_customer: { select: { user_id: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Courier order not found' });
    const customerUid = existing.courier_customer?.user_id;
    const admin = req.user.role === 'ADMIN' || req.user.permission === 'admin';
    if (!admin && customerUid !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const deleted = await prisma.courier_order.delete({
      where: { courier_order_id: Number(req.params.courier_order_id) },
    });

    io?.emit('courier-order-deleted', { courier_order_id: deleted.courier_order_id });

    res.json({ message: 'Courier order deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete courier order' });
  }
});

/* PUT /:courier_order_id/accept — a registered courier claims a pending order.
   Atomic claim: only succeeds if the order is still pending + unassigned. */
router.put('/:courier_order_id/accept', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const courier_order_id = Number(req.params.courier_order_id);
    const provider = await callerProvider(req);
    if (!provider) return res.status(403).json({ successful: false, message: 'Courier registration required' });

    // Drivers may add courier jobs to an active delivery run, but not while mid-ride.
    const busy = await getBusyDriverProfileIds({ excludeVerticals: ['courier', 'food', 'product'] });
    if (busy.has(provider.courier_service_provider_id)) {
      return res.status(409).json({ successful: false, message: 'You already have an active ride — finish it before accepting courier work.' });
    }

    const order = await prisma.courier_order.findUnique({ where: { courier_order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });

    const claimedOrder = await prisma.$transaction(async (tx) => {
      const batch = await findOrCreateDriverDeliveryBatch(tx, provider.courier_service_provider_id, 'courier');
      const claimed = await tx.courier_order.updateMany({
        where: { courier_order_id, status: 'pending', courier_service_provider_id: null },
        data: {
          status: 'accepted',
          courier_service_provider_id: provider.courier_service_provider_id,
          batch_id: batch.batch_id,
          last_update: new Date(),
        },
      });
      if (claimed.count === 0) return null;
      await refreshFoodDeliveryBatchRoutePlan(tx, batch.batch_id, provider.courier_service_provider_id);
      return tx.courier_order.findUnique({ where: { courier_order_id } });
    });
    if (!claimedOrder)
      return res.status(409).json({ successful: false, message: 'Order is no longer available' });

    await notifyCustomer(io, claimedOrder, `courier-accepted-${courier_order_id}`, { message: 'Courier is on the way!' }, 'accepted');
    return res.json({ successful: true, message: 'Order accepted', data: claimedOrder });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

router.put('/:courier_order_id/claim-additional', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const courier_order_id = Number(req.params.courier_order_id);
    const provider = await callerProvider(req);
    if (!provider) return res.status(403).json({ successful: false, message: 'Courier registration required' });

    const result = await prisma.$transaction(async (tx) => {
      let activeBatch = await tx.delivery_batch.findFirst({
        where: {
          driver_profile_id: provider.courier_service_provider_id,
          status: 'active',
          OR: [
            { food_order: { some: activeDeliveryStatusWhere('order_status') } },
            { courier_order: { some: activeDeliveryStatusWhere('status') } },
          ],
        },
        orderBy: { created_at: 'desc' },
      });
      if (!activeBatch) {
        const activeFoodOrder = await tx.food_order.findFirst({
          where: { driver_id: provider.courier_service_provider_id, ...activeDeliveryStatusWhere('order_status') },
          orderBy: { food_order_id: 'asc' },
        });
        const activeCourierOrder = activeFoodOrder ? null : await tx.courier_order.findFirst({
          where: {
            courier_service_provider_id: provider.courier_service_provider_id,
            courier_order_id: { not: courier_order_id },
            ...activeDeliveryStatusWhere('status'),
          },
          orderBy: { courier_order_id: 'asc' },
        });
        if (!activeFoodOrder && !activeCourierOrder) return null;
        activeBatch = await findOrCreateDriverDeliveryBatch(tx, provider.courier_service_provider_id, activeFoodOrder ? 'food' : 'courier');
        if (activeFoodOrder && !activeFoodOrder.batch_id) {
          await tx.food_order.update({ where: { food_order_id: activeFoodOrder.food_order_id }, data: { batch_id: activeBatch.batch_id } });
        }
        if (activeCourierOrder && !activeCourierOrder.batch_id) {
          await tx.courier_order.update({ where: { courier_order_id: activeCourierOrder.courier_order_id }, data: { batch_id: activeBatch.batch_id } });
        }
      }
      const claimed = await tx.courier_order.updateMany({
        where: { courier_order_id, status: 'pending', courier_service_provider_id: null },
        data: {
          status: 'accepted',
          courier_service_provider_id: provider.courier_service_provider_id,
          batch_id: activeBatch.batch_id,
          last_update: new Date(),
        },
      });
      if (claimed.count === 0) return null;
      await refreshFoodDeliveryBatchRoutePlan(tx, activeBatch.batch_id, provider.courier_service_provider_id);
      return tx.courier_order.findUnique({ where: { courier_order_id } });
    });
    if (!result) {
      return res.status(409).json({ successful: false, message: 'This courier order is no longer available.' });
    }

    await notifyCustomer(io, result, `courier-accepted-${courier_order_id}`, { message: 'Courier is on the way!' }, 'accepted');
    io?.to(`driver-${provider.courier_service_provider_id}`).emit('delivery-batch-updated', {
      order_type: 'courier_order',
      order_id: courier_order_id,
    });
    return res.json({ successful: true, message: 'Courier order added to your current run', data: result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* PUT /:courier_order_id/pickup — only the assigned courier may mark pickup. */
router.put('/:courier_order_id/pickup', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const courier_order_id = Number(req.params.courier_order_id);
    const provider = await callerProvider(req);
    if (!provider) return res.status(403).json({ successful: false, message: 'Courier registration required' });

    const order = await prisma.courier_order.findUnique({ where: { courier_order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.courier_service_provider_id !== provider.courier_service_provider_id)
      return res.status(403).json({ successful: false, message: 'Not your delivery' });
    if (order.status !== 'accepted')
      return res.status(400).json({ successful: false, message: 'Order must be accepted before pickup' });

    await prisma.$transaction(async (tx) => {
      await tx.courier_order.update({ where: { courier_order_id }, data: { status: 'picked_up', last_update: new Date() } });
      if (order.batch_id) {
        await refreshFoodDeliveryBatchRoutePlan(tx, order.batch_id, provider.courier_service_provider_id);
      }
    });
    await notifyCustomer(io, order, `courier-picked-up-${courier_order_id}`, { message: 'Package picked up!' }, 'picked_up');
    return res.json({ successful: true, message: 'Package picked up' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* PUT /:courier_order_id/deliver — only the assigned courier may mark delivery. */
router.put('/:courier_order_id/deliver', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const courier_order_id = Number(req.params.courier_order_id);
    const provider = await callerProvider(req);
    if (!provider) return res.status(403).json({ successful: false, message: 'Courier registration required' });

    const order = await prisma.courier_order.findUnique({ where: { courier_order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.courier_service_provider_id !== provider.courier_service_provider_id)
      return res.status(403).json({ successful: false, message: 'Not your delivery' });
    if (order.status !== 'picked_up')
      return res.status(400).json({ successful: false, message: 'Order must be picked up before delivery' });

    await prisma.$transaction(async (tx) => {
      await tx.courier_order.update({ where: { courier_order_id }, data: { status: 'delivered', deliver_date: new Date(), last_update: new Date() } });
      if (order.batch_id) {
        await refreshFoodDeliveryBatchRoutePlan(tx, order.batch_id, provider.courier_service_provider_id);
      }
    });

    // Pay the courier on delivery: credit their wallet 79% of the order price
    // (21% platform fee, mirroring rideshare). Idempotent on the order via the
    // delivered-status guard above (only the picked_up -> delivered transition
    // reaches here once). Wallet balance is the sum of wallet_transaction rows.
    const price = parseFloat(order.price);
    if (Number.isFinite(price) && price > 0) {
      await prisma.wallet_transaction.create({
        data: {
          user_id: req.user.user_id,
          amount: +(price * 0.79).toFixed(2),
          type: 'credit',
          source: 'courier_earning',
          description: `Courier delivery #${courier_order_id}`,
        },
      }).catch((e) => console.error('Failed to credit courier earning', e));
    }

    clearCourierLocation(courier_order_id);
    await notifyCustomer(io, order, `courier-delivered-${courier_order_id}`, { message: 'Package delivered!' }, 'delivered');
    return res.json({ successful: true, message: 'Package delivered' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});


/* PUT /:courier_order_id/decline — a courier passes on a broadcast order.
   Unassigned broadcast orders carry no per-driver state, so this just acks the
   dismissal (kept so the client has a stable endpoint and future per-driver
   decline tracking can hang off it). */
router.put('/:courier_order_id/decline', authenticateToken, async (_req, res) => {
  return res.json({ successful: true, message: 'Order declined' });
});

export default router;
