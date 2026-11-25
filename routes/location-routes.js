import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { checkRateLimit } from '../utils/rate-limiter.js';

const router = express.Router();
const USER_AGENT = 'Strug/1.0 (location proxy)';
const LOCATION_PROXY_LIMIT = 30;
const LOCATION_PROXY_WINDOW_SECONDS = 60;
const LOCATION_PROXY_TIMEOUT_MS = Number(process.env.LOCATION_PROXY_TIMEOUT_MS || 5000);

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCATION_PROXY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        ...(options.headers || {}),
      },
    });
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function geocodeWithOpenStreetMap(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(address)}`;
  const data = await fetchJson(url);
  const first = Array.isArray(data) ? data[0] : null;
  if (!first) return null;
  return {
    lat: Number(first.lat),
    lng: Number(first.lon),
    formatted_address: first.display_name || address,
    provider: 'openstreetmap',
  };
}

async function limitLocationProxy(req, res, next) {
  const userId = req.user?.user_id || req.user?.id || 'unknown';
  const routeKey = req.path.replace(/^\/+/, '').replace(/\W+/g, '-') || 'root';
  const limited = await checkRateLimit(`location-proxy:${routeKey}:${userId}`, LOCATION_PROXY_LIMIT, LOCATION_PROXY_WINDOW_SECONDS);
  if (limited) {
    return res.status(429).json({
      successful: false,
      error: 'Too many location requests. Please wait a moment and try again.',
    });
  }
  next();
}

/* POST GEOCODE — address to lat/lng */
router.post('/geocode', authenticateToken, limitLocationProxy, async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required' });

    if (process.env.GOOGLE_MAPS_API_KEY) {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
      const data = await fetchJson(url);
      if (data.status === 'OK' && data.results.length > 0) {
        const { lat, lng } = data.results[0].geometry.location;
        return res.json({ lat, lng, formatted_address: data.results[0].formatted_address });
      }
      if (data.status && data.status !== 'ZERO_RESULTS') {
        console.warn('[location/geocode] Google geocode failed:', data.status, data.error_message || '');
      }
    }

    const fallback = await geocodeWithOpenStreetMap(address);
    if (fallback) return res.json(fallback);

    res.status(404).json({ error: 'No geocode result found for this address' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to geocode address' });
  }
});

/* GET AUTOCOMPLETE — address suggestions for shared delivery/search inputs */
router.get('/autocomplete', authenticateToken, limitLocationProxy, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ successful: true, data: [] });
    }

    if (process.env.GOOGLE_MAPS_API_KEY) {
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(q)}&types=address&key=${process.env.GOOGLE_MAPS_API_KEY}`;
      const data = await fetchJson(url);
      if (data.status === 'OK') {
        return res.json({
          successful: true,
          provider: 'google',
          data: (data.predictions || []).map((prediction) => ({
            place_id: prediction.place_id,
            description: prediction.description,
          })),
        });
      }
      if (data.status && data.status !== 'ZERO_RESULTS') {
        console.warn('[location/autocomplete] Google Places failed:', data.status, data.error_message || '');
      }
    }

    const fallbackUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;
    const fallback = await fetchJson(fallbackUrl);
    return res.json({
      successful: true,
      provider: 'openstreetmap',
      data: (Array.isArray(fallback) ? fallback : []).map((item) => ({
        place_id: `osm:${item.osm_type}:${item.osm_id}`,
        description: item.display_name,
        lat: Number(item.lat),
        lng: Number(item.lon),
      })),
    });
  } catch (err) {
    console.error('[location/autocomplete] Failed:', err);
    res.status(500).json({ successful: false, error: 'Failed to fetch address suggestions' });
  }
});

/* GET PLACE DETAILS — resolve a suggestion into formatted address + coordinates */
router.get('/place-details', authenticateToken, limitLocationProxy, async (req, res) => {
  try {
    const placeId = String(req.query.place_id || '').trim();
    const description = String(req.query.description || '').trim();
    if (!placeId && !description) {
      return res.status(400).json({ successful: false, error: 'place_id or description is required' });
    }

    if (placeId.startsWith('osm:')) {
      const geocoded = description ? await geocodeWithOpenStreetMap(description) : null;
      return res.json({ successful: true, data: geocoded || null });
    }

    if (process.env.GOOGLE_MAPS_API_KEY && placeId) {
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=formatted_address,geometry&key=${process.env.GOOGLE_MAPS_API_KEY}`;
      const data = await fetchJson(url);
      if (data.status === 'OK' && data.result) {
        const loc = data.result.geometry?.location;
        return res.json({
          successful: true,
          provider: 'google',
          data: {
            formatted_address: data.result.formatted_address,
            lat: loc?.lat ?? null,
            lng: loc?.lng ?? null,
          },
        });
      }
      if (data.status && data.status !== 'ZERO_RESULTS') {
        console.warn('[location/place-details] Google Places failed:', data.status, data.error_message || '');
      }
    }

    const fallback = description ? await geocodeWithOpenStreetMap(description) : null;
    return res.json({ successful: true, provider: 'openstreetmap', data: fallback });
  } catch (err) {
    console.error('[location/place-details] Failed:', err);
    res.status(500).json({ successful: false, error: 'Failed to resolve address suggestion' });
  }
});

/* GET NEARBY PROVIDERS — returns providers near given coordinates */
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng } = req.query;

    const providers = await prisma.user_service_provider.findMany({
      where: {
        current_lat: { not: null },
        current_long: { not: null },
      },
      take: 20,
      include: { user: { select: { user_id: true, name: true } } },
    });

    const withDistance = providers.map(p => {
      const dLat = (Number(p.current_lat) - Number(lat)) * 111;
      const dLng = (Number(p.current_long) - Number(lng)) * 111;
      return { ...p, distance_km: Math.sqrt(dLat * dLat + dLng * dLng).toFixed(2) };
    }).sort((a, b) => a.distance_km - b.distance_km);

    res.json(withDistance);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch nearby providers' });
  }
});

export default router;
