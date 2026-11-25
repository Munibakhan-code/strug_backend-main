import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// Snap to ~4.4km grid (0.04°) — anonymized density circles, never exact addresses (#326).
const GRID = 25;
const snap = (n) => Math.round(Number(n) * GRID) / GRID;
// k≥5 so a cell never represents a handful of identifiable buyers.
const K_ANON = 5;
const AREA_RADIUS_KM = 100;

const ORDER_VERTICAL_VENDOR_TYPE = {
  food: 'Restaurant',
  restaurant: 'Restaurant',
  restaurants: 'Restaurant',
  grocery: 'Grocery',
  groceries: 'Grocery',
  catering: 'Restaurant',
  floral: 'Restaurant',
  flowers: 'Restaurant',
};

function addPoint(cells, lat, lng, userId) {
  if (lat == null || lng == null || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) return;
  const sLat = snap(lat);
  const sLng = snap(lng);
  const key = `${sLat},${sLng}`;
  const e = cells.get(key) || { lat: sLat, lng: sLng, users: new Set() };
  e.users.add(userId != null ? `u${userId}` : `p${key}:${e.users.size}`);
  cells.set(key, e);
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function withinRadius(center, lat, lng, radiusKm) {
  if (!center || center.lat == null || center.lng == null) return true;
  if (lat == null || lng == null) return false;
  return haversineKm(center.lat, center.lng, lat, lng) <= radiusKm;
}

async function resolveOrderVendorTypeId(vertical) {
  const typeName = ORDER_VERTICAL_VENDOR_TYPE[String(vertical || '').trim().toLowerCase()];
  if (!typeName) return null;
  const types = await prisma.vendor_type.findMany({ select: { vendor_type_id: true, vendor_type: true } });
  const want = typeName.toLowerCase();
  const exact = types.find((t) => String(t.vendor_type || '').trim().toLowerCase() === want);
  if (exact) return exact.vendor_type_id;
  // Fuzzy: "Restaurants", "Food / Restaurant", etc.
  const fuzzy = types.find((t) => String(t.vendor_type || '').trim().toLowerCase().includes(want));
  return fuzzy?.vendor_type_id ?? null;
}

async function resolveSellerCenter(userId, vendors) {
  const withGeo = (vendors || []).find((v) => v.lat != null && v.long != null);
  if (withGeo) {
    return { lat: Number(withGeo.lat), lng: Number(withGeo.long), source: 'vendor' };
  }
  // Never read user.saved_lat/saved_long here — those columns are globally omitted in
  // prisma-client to protect precise home pins, and $queryRaw would bypass that omit.
  // Fall back to the seller's own saved delivery addresses (user_address), which are
  // the supported place for mappable coords.
  const address = await prisma.user_address.findFirst({
    where: { user_id: userId, lat: { not: null }, lng: { not: null } },
    select: { lat: true, lng: true, is_default: true },
    orderBy: [{ is_default: 'desc' }, { address_id: 'asc' }],
  });
  if (address?.lat != null && address?.lng != null) {
    return { lat: Number(address.lat), lng: Number(address.lng), source: 'address' };
  }
  return null;
}

async function loadBuyerCoordsByUserId(userIds) {
  const map = new Map();
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return map;

  // Buyer pins come from user_address only — never user.saved_* (PII omit in prisma-client).
  const addresses = await prisma.user_address.findMany({
    where: { user_id: { in: ids }, lat: { not: null }, lng: { not: null } },
    select: { user_id: true, lat: true, lng: true, is_default: true },
    orderBy: [{ is_default: 'desc' }, { address_id: 'asc' }],
  });
  for (const a of addresses) {
    const uid = Number(a.user_id);
    if (map.has(uid)) continue;
    map.set(uid, { lat: Number(a.lat), lng: Number(a.lng) });
  }
  return map;
}

/**
 * GET /provider-opportunities/demand-map?vertical=&days=90
 *
 * Priority:
 * 1) Paid orders to THIS seller's restaurants (always) — plot buyer coords, or store pin if missing
 * 2) Other in-vertical paid food orders near the seller (market demand)
 */
router.get('/demand-map', authenticateToken, async (req, res) => {
  try {
    const caller = await prisma.user.findUnique({
      where: { user_id: req.user.user_id },
      select: { is_seller: true },
    });
    if (!caller?.is_seller) {
      return res.status(403).json({ successful: false, message: 'Provider access required.' });
    }

    const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const vertical = String(req.query.vertical || '').trim().toLowerCase() || 'food';
    const cells = new Map();
    const orderVendorTypeId = await resolveOrderVendorTypeId(vertical);

    const myVendors = await prisma.food_vendor.findMany({
      where: { owner_id: req.user.user_id },
      select: { vendor_id: true, vendor_type_id: true, lat: true, long: true, vendor_name: true },
      orderBy: { vendor_id: 'asc' },
    });
    const myVendorIds = myVendors.map((v) => Number(v.vendor_id)).filter((id) => id > 0);
    const center = await resolveSellerCenter(req.user.user_id, myVendors);

    let source = 'food_order_customers';
    let pointsSeen = 0;
    let pointsWithGeo = 0;
    let pointsInRadius = 0;
    let myOrdersCount = 0;
    let myDistinctBuyers = 0;

    // ── 1) Own restaurant paid orders (does NOT depend on vendor_type name match) ──
    if (myVendorIds.length) {
      const myOrders = await prisma.food_order.findMany({
        where: {
          vendor_id: { in: myVendorIds },
          user_id: { not: null },
          created_at: { gte: since },
          OR: [
            { ispaid: true },
            // Wallet paths should already be ispaid. Keep legacy cash methods visible
            // for historical demand while in-flight COD/CASH orders finish settling.
            { payment_method: { in: ['WALLET', 'wallet', 'COD', 'cod', 'CASH', 'cash'] } },
          ],
        },
        select: { user_id: true, vendor_id: true, ispaid: true },
      });
      myOrdersCount = myOrders.length;
      const myBuyerIds = [...new Set(myOrders.map((o) => Number(o.user_id)).filter((id) => id > 0))];
      myDistinctBuyers = myBuyerIds.length;
      const coordsByUser = await loadBuyerCoordsByUserId(myBuyerIds);

      for (const o of myOrders) {
        pointsSeen += 1;
        const uid = Number(o.user_id);
        // Own-restaurant demand is always attributed to the store pin so different
        // buyer profile addresses in the same city still form one hotspot.
        // (Market demand below still uses real buyer coords for area gaps.)
        let coords = center ? { lat: center.lat, lng: center.lng } : (coordsByUser.get(uid) || null);
        if (!coords) continue;
        pointsWithGeo += 1;
        pointsInRadius += 1;
        addPoint(cells, coords.lat, coords.lng, uid);
      }
    }

    // ── 2) Broader market demand near seller (optional, type-filtered) ──
    if (orderVendorTypeId != null) {
      const marketOrders = await prisma.food_order.findMany({
        where: {
          ispaid: true,
          created_at: { gte: since },
          user_id: { not: null },
          ...(myVendorIds.length ? { vendor_id: { notIn: myVendorIds } } : {}),
          OR: [
            { vendor_type_id: orderVendorTypeId },
            { food_vendor: { is: { vendor_type_id: orderVendorTypeId } } },
          ],
        },
        select: { user_id: true, vendor_id: true },
      });
      const marketBuyerIds = [...new Set(marketOrders.map((o) => Number(o.user_id)).filter((id) => id > 0))];
      const marketCoords = await loadBuyerCoordsByUserId(marketBuyerIds);
      for (const o of marketOrders) {
        pointsSeen += 1;
        const uid = Number(o.user_id);
        const coords = marketCoords.get(uid);
        if (!coords) continue;
        pointsWithGeo += 1;
        if (!withinRadius(center, coords.lat, coords.lng, AREA_RADIUS_KM)) continue;
        pointsInRadius += 1;
        addPoint(cells, coords.lat, coords.lng, uid);
      }
    } else if (!myVendorIds.length) {
      // No food vendors and unknown vertical → legacy rideshare fallback
      source = 'ride_requests';
      const rides = await prisma.ride_request.findMany({
        where: { created_at: { gte: since } },
        select: {
          pickup_lat: true,
          pickup_long: true,
          drop_lat: true,
          drop_long: true,
          passenger_id: true,
        },
      });
      for (const r of rides) {
        pointsSeen += 1;
        if (withinRadius(center, r.pickup_lat, r.pickup_long, AREA_RADIUS_KM)) {
          pointsWithGeo += 1;
          pointsInRadius += 1;
          addPoint(cells, r.pickup_lat, r.pickup_long, r.passenger_id);
        }
        if (withinRadius(center, r.drop_lat, r.drop_long, AREA_RADIUS_KM)) {
          pointsWithGeo += 1;
          pointsInRadius += 1;
          addPoint(cells, r.drop_lat, r.drop_long, r.passenger_id);
        }
      }
    }

    const list = [...cells.values()]
      .filter((c) => c.users.size >= K_ANON)
      .map((c) => ({ lat: c.lat, lng: c.lng, weight: c.users.size }))
      .sort((a, b) => b.weight - a.weight);
    const total = list.reduce((s, c) => s + c.weight, 0);
    const max_weight = list.length ? list[0].weight : 0;
    const hotspots = list.slice(0, 5);
    const largestCell = [...cells.values()].sort((a, b) => b.users.size - a.users.size)[0];

    return res.json({
      successful: true,
      data: {
        vertical: req.query.vertical || 'food',
        source,
        window_days: days,
        k_anonymity: K_ANON,
        radius_km: AREA_RADIUS_KM,
        center: center ? { lat: center.lat, lng: center.lng } : null,
        cells: list,
        total_demand: total,
        max_weight,
        hotspots,
        meta: {
          orders_considered: pointsSeen,
          points_with_geo: pointsWithGeo,
          points_in_radius: pointsInRadius,
          cells_before_k: cells.size,
          largest_cell_users: largestCell?.users?.size ?? 0,
          my_vendors: myVendorIds.length,
          my_orders: myOrdersCount,
          my_distinct_buyers: myDistinctBuyers,
          vendor_type_id: orderVendorTypeId,
        },
      },
    });
  } catch (err) {
    console.error('Demand map error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to load demand map.' });
  }
});

export default router;
