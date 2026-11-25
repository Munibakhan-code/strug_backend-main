import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import {
  quoteShipping,
  sanitizeZoneInput,
  DEFAULT_LOCAL_RADIUS_KM,
} from '../utils/shop-shipping-zones.js';

const router = express.Router();

async function loadStoreForSeller(sellerId) {
  const uid = Number(sellerId);
  if (!Number.isFinite(uid)) return null;
  return prisma.store_profile.findUnique({
    where: { user_id: uid },
    include: {
      shipping_zones: {
        where: { is_active: true },
        orderBy: [{ priority: 'asc' }, { zone_id: 'asc' }],
      },
    },
  });
}

async function loadSellerStoreOr404(req, res) {
  const userId = req.user?.user_id;
  const store = await prisma.store_profile.findUnique({
    where: { user_id: userId },
    include: {
      shipping_zones: { orderBy: [{ priority: 'asc' }, { zone_id: 'asc' }] },
    },
  });
  if (!store) {
    res.status(404).json({ error: 'Store profile not found — save your store profile first' });
    return null;
  }
  return store;
}

/** Public: active zones for a seller (checkout UI). */
router.get('/zones/:sellerId', async (req, res) => {
  try {
    const store = await loadStoreForSeller(req.params.sellerId);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    res.json({
      seller_id: store.user_id,
      store_id: store.store_id,
      lat: store.lat,
      lng: store.lng,
      local_radius_km: DEFAULT_LOCAL_RADIUS_KM,
      zones: store.shipping_zones,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch shipping zones' });
  }
});

/** Seller: list own zones (incl. inactive). */
router.get('/zones', authenticateToken, async (req, res) => {
  try {
    const store = await loadSellerStoreOr404(req, res);
    if (!store) return;
    res.json({
      store_id: store.store_id,
      local_radius_km: DEFAULT_LOCAL_RADIUS_KM,
      zones: store.shipping_zones,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch shipping zones' });
  }
});

/** Seller: replace entire zone set. Body: { zones: [...] } */
router.put('/zones', authenticateToken, async (req, res) => {
  try {
    const store = await loadSellerStoreOr404(req, res);
    if (!store) return;

    const raw = Array.isArray(req.body?.zones) ? req.body.zones : [];
    const sanitized = raw
      .map((row, i) => sanitizeZoneInput(row, i))
      .filter(Boolean);

    if (raw.length && !sanitized.length) {
      return res.status(400).json({ error: 'Each zone needs a country and a non-negative fee' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.store_shipping_zone.deleteMany({ where: { store_id: store.store_id } });
      if (sanitized.length) {
        await tx.store_shipping_zone.createMany({
          data: sanitized.map((z) => ({ ...z, store_id: store.store_id })),
        });
      }
    });

    const refreshed = await prisma.store_shipping_zone.findMany({
      where: { store_id: store.store_id },
      orderBy: [{ priority: 'asc' }, { zone_id: 'asc' }],
    });
    res.json({ store_id: store.store_id, zones: refreshed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save shipping zones' });
  }
});

/**
 * Quote local delivery vs ship-by-seller fee.
 * Body: { seller_id, country, city?, lat?, lng?, preferred_mode? }
 */
router.post('/quote', async (req, res) => {
  try {
    const {
      seller_id,
      country,
      city,
      lat,
      lng,
      preferred_mode,
    } = req.body || {};

    if (seller_id == null) {
      return res.status(400).json({ error: 'seller_id is required' });
    }

    const store = await loadStoreForSeller(seller_id);
    if (!store) return res.status(404).json({ error: 'Store not found' });

    const quote = quoteShipping({
      store,
      zones: store.shipping_zones,
      buyer: {
        country: country ?? null,
        city: city ?? null,
        lat: lat != null ? Number(lat) : null,
        lng: lng != null ? Number(lng) : null,
      },
      preferredMode: preferred_mode || null,
      localRadiusKm: DEFAULT_LOCAL_RADIUS_KM,
    });

    if (!quote.ok) {
      return res.status(422).json(quote);
    }
    res.json({
      ...quote,
      seller_id: store.user_id,
      store_id: store.store_id,
      local_radius_km: DEFAULT_LOCAL_RADIUS_KM,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to quote shipping' });
  }
});

export default router;
