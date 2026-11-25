import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { findRequestsForProvider, findPipelineForProvider, findProspectsForProvider, providerMatchesRequest } from '../utils/quote-dispatch.js';

const router = express.Router();

const PROVIDER_TYPES = ['bank', 'agent', 'broker'];
const PROVIDER_VERTICALS = ['insurance', 'mortgage'];

// Shape a provider row for the client: flatten serviced cities + categories.
function shapeProvider(p) {
  if (!p) return null;
  return {
    ...p,
    cities: (p.quote_provider_city || []).map((c) => ({
      quote_provider_city_id: c.quote_provider_city_id,
      city: c.city,
      country: c.country,
    })),
    categories: (p.quote_provider_category || []).map((pc) => pc.quote_category),
  };
}

const PROVIDER_INCLUDE = {
  quote_provider_city: true,
  quote_provider_category: {
    include: {
      quote_category: { select: { quote_category_id: true, name: true, slug: true, vertical: true } },
    },
  },
};

function parseVertical(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return PROVIDER_VERTICALS.includes(v) ? v : null;
}

/** Resolve vertical from query (GET/DELETE) or body (POST/PATCH). */
function requireVertical(req, res) {
  const vertical = parseVertical(req.query?.vertical ?? req.body?.vertical);
  if (!vertical) {
    res.status(400).json({ message: `vertical is required (${PROVIDER_VERTICALS.join(' | ')})` });
    return null;
  }
  return vertical;
}

async function findMyProvider(userId, vertical, include = PROVIDER_INCLUDE) {
  return prisma.quote_provider.findFirst({
    where: { user_id: Number(userId), vertical },
    include,
  });
}

// GET /quote-providers/me?vertical=insurance|mortgage — my provider profile for that vertical, or null.
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const p = await findMyProvider(req.user.user_id, vertical);
    res.json(shapeProvider(p));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch provider profile' });
  }
});

// POST /quote-providers/me — become a quote provider / update my profile for one vertical (idempotent upsert).
// Insurance and mortgage are standalone — each vertical gets its own quote_provider row.
router.post('/me', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;

    const {
      provider_type,
      business_name,
      contact_email,
      contact_phone,
      license_no,
      bio,
      country,
    } = req.body || {};

    if (provider_type != null && !PROVIDER_TYPES.includes(String(provider_type))) {
      return res.status(400).json({ message: `provider_type must be one of: ${PROVIDER_TYPES.join(', ')}` });
    }

    const data = {
      ...(provider_type != null && { provider_type: String(provider_type) }),
      ...(business_name !== undefined && { business_name: business_name || null }),
      ...(contact_email !== undefined && { contact_email: contact_email || null }),
      ...(contact_phone !== undefined && { contact_phone: contact_phone || null }),
      ...(license_no !== undefined && { license_no: license_no || null }),
      ...(bio !== undefined && { bio: bio || null }),
      ...(country !== undefined && { country: country || null }),
    };

    const existing = await findMyProvider(req.user.user_id, vertical);
    let saved;
    if (existing) {
      saved = await prisma.quote_provider.update({
        where: { quote_provider_id: existing.quote_provider_id },
        data: { ...data, updated_at: new Date() },
        include: PROVIDER_INCLUDE,
      });
    } else {
      saved = await prisma.quote_provider.create({
        data: { user_id: req.user.user_id, vertical, ...data },
        include: PROVIDER_INCLUDE,
      });
    }
    res.status(existing ? 200 : 201).json(shapeProvider(saved));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to save provider profile' });
  }
});

// PATCH /quote-providers/me/active — pause/resume receiving requests for this vertical.
router.patch('/me/active', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const p = await findMyProvider(req.user.user_id, vertical);
    if (!p) return res.status(404).json({ message: 'Not a provider' });
    const updated = await prisma.quote_provider.update({
      where: { quote_provider_id: p.quote_provider_id },
      data: { is_active: req.body?.is_active !== undefined ? !!req.body.is_active : p.is_active, updated_at: new Date() },
    });
    res.json({ is_active: updated.is_active });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to update status' });
  }
});

// GET /quote-providers/me/requests — inbox for this vertical.
router.get('/me/requests', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const p = await findMyProvider(req.user.user_id, vertical);
    if (!p) return res.json([]);
    const requests = await findRequestsForProvider(p.quote_provider_id);
    res.json(requests);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch inbox' });
  }
});

// GET /quote-providers/me/pipeline — Kanban feed for this vertical.
router.get('/me/pipeline', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const p = await findMyProvider(req.user.user_id, vertical);
    if (!p) return res.json([]);
    const requests = await findPipelineForProvider(p.quote_provider_id);
    res.json(requests);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch pipeline' });
  }
});

// GET /quote-providers/me/prospects — soft lead lists for Prospects tab.
router.get('/me/prospects', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const p = await findMyProvider(req.user.user_id, vertical);
    if (!p) return res.json({ switching: [], renewing: [] });
    const prospects = await findProspectsForProvider(p.quote_provider_id);
    res.json(prospects);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch prospects' });
  }
});

// GET /quote-providers/me/reviews — my post-deal ratings for this vertical (read-only list).
router.get('/me/reviews', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    // Providers are per-vertical (isolation), so scope reviews to this vertical's provider row
    // rather than an arbitrary findFirst across the user's insurance/mortgage profiles.
    const p = await findMyProvider(req.user.user_id, vertical);
    if (!p) return res.json({ rating: null, count: 0, reviews: [] });

    const [agg, rows] = await Promise.all([
      prisma.quote_review.aggregate({
        where: { provider_id: p.quote_provider_id },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      prisma.quote_review.findMany({
        where: { provider_id: p.quote_provider_id },
        orderBy: { created_at: 'desc' },
        take: 50,
        include: {
          quote_request: {
            select: {
              quote_request_id: true,
              title: true,
              city: true,
              country: true,
              vertical: true,
              quote_category: { select: { name: true, slug: true } },
            },
          },
        },
      }),
    ]);

    const count = agg._count._all || 0;
    const rating =
      agg._avg.rating != null
        ? Math.round(agg._avg.rating * 10) / 10
        : p.rating != null
          ? Number(p.rating)
          : null;

    res.json({
      rating,
      count,
      reviews: rows.map((r) => ({
        quote_review_id: r.quote_review_id,
        rating: r.rating,
        comment: r.comment,
        created_at: r.created_at,
        quote_request_id: r.quote_request_id,
        title: r.quote_request?.quote_category?.name || r.quote_request?.title || 'Deal',
        city: r.quote_request?.city || null,
        country: r.quote_request?.country || null,
        category: r.quote_request?.quote_category?.name || null,
        vertical: r.quote_request?.vertical || null,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch reviews' });
  }
});

// GET /quote-providers/me/requests/:id — provider's view of one request (must be eligible
// by match rule, OR they already have a quote on it so later-stage deals stay reachable).
router.get('/me/requests/:id', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const p = await findMyProvider(req.user.user_id, vertical, {
      quote_provider_city: true,
      quote_provider_category: { select: { quote_category_id: true } },
    });
    if (!p) return res.status(404).json({ message: 'Not a provider' });
    const request = await prisma.quote_request.findUnique({
      where: { quote_request_id: Number(req.params.id) },
      include: { quote_category: { select: { name: true, slug: true, vertical: true } } },
    });
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.vertical && request.vertical !== vertical) {
      return res.status(403).json({ message: 'This request belongs to a different vertical' });
    }
    const my_quote = await prisma.quote.findFirst({
      where: { quote_request_id: request.quote_request_id, provider_id: p.quote_provider_id },
      orderBy: { created_at: 'desc' },
    });
    if (!providerMatchesRequest(p, request) && !my_quote) {
      return res.status(403).json({ message: 'This request is not in your area/categories' });
    }
    res.json({ ...request, my_quote });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch request' });
  }
});

// POST /quote-providers/me/cities — add a serviced city { city, country }.
router.post('/me/cities', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const city = (req.body?.city || '').trim();
    const country = (req.body?.country || '').trim() || null;
    if (!city) return res.status(400).json({ message: 'city is required' });

    const p = await findMyProvider(req.user.user_id, vertical);
    if (!p) return res.status(404).json({ message: 'Become a provider first' });

    const exists = await prisma.quote_provider_city.findFirst({
      where: { quote_provider_id: p.quote_provider_id, city, country },
    });
    if (!exists) {
      await prisma.quote_provider_city.create({ data: { quote_provider_id: p.quote_provider_id, city, country } });
    }
    const cities = await prisma.quote_provider_city.findMany({ where: { quote_provider_id: p.quote_provider_id } });
    res.status(201).json({ cities });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to add city' });
  }
});

// DELETE /quote-providers/me/cities/:cityId — remove a serviced city.
router.delete('/me/cities/:cityId', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const p = await findMyProvider(req.user.user_id, vertical);
    if (!p) return res.status(404).json({ message: 'Not a provider' });
    await prisma.quote_provider_city.deleteMany({
      where: { quote_provider_id: p.quote_provider_id, quote_provider_city_id: Number(req.params.cityId) },
    });
    res.json({ removed: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to remove city' });
  }
});

// POST /quote-providers/me/categories — add a category I quote for { category_id } (leaf only).
router.post('/me/categories', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const cat = await prisma.quote_category.findUnique({
      where: { quote_category_id: Number(req.body?.category_id) },
    });
    if (!cat || cat.parent_id == null) {
      return res.status(400).json({ message: 'category_id must be a valid sub-type (leaf category)' });
    }
    if (cat.vertical !== vertical) {
      return res.status(400).json({ message: `category belongs to ${cat.vertical}, not ${vertical}` });
    }
    const p = await findMyProvider(req.user.user_id, vertical);
    if (!p) return res.status(404).json({ message: 'Become a provider first' });

    const existing = await prisma.quote_provider_category.findFirst({
      where: { quote_provider_id: p.quote_provider_id, quote_category_id: cat.quote_category_id },
    });
    if (!existing) {
      await prisma.quote_provider_category.create({
        data: { quote_provider_id: p.quote_provider_id, quote_category_id: cat.quote_category_id },
      });
    }
    const cats = await prisma.quote_provider_category.findMany({
      where: { quote_provider_id: p.quote_provider_id },
      include: { quote_category: { select: { quote_category_id: true, name: true, slug: true, vertical: true } } },
    });
    res.status(201).json({ categories: cats.map((pc) => pc.quote_category) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to add category' });
  }
});

// DELETE /quote-providers/me/categories/:categoryId — stop quoting for a category.
router.delete('/me/categories/:categoryId', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const p = await findMyProvider(req.user.user_id, vertical);
    if (!p) return res.status(404).json({ message: 'Not a provider' });
    await prisma.quote_provider_category.deleteMany({
      where: { quote_provider_id: p.quote_provider_id, quote_category_id: Number(req.params.categoryId) },
    });
    res.json({ removed: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to remove category' });
  }
});

// ── Availability calendar ───────────────────────────────────────────────────

// POST /quote-providers/me/availability — publish a slot { slot_start, slot_end? }.
router.post('/me/availability', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const p = await findMyProvider(req.user.user_id, vertical);
    if (!p) return res.status(404).json({ message: 'Become a provider first' });
    const slot_start = req.body?.slot_start ? new Date(req.body.slot_start) : null;
    if (!slot_start || Number.isNaN(slot_start.getTime())) return res.status(400).json({ message: 'slot_start is required (ISO datetime)' });
    const slot_end = req.body?.slot_end ? new Date(req.body.slot_end) : null;
    const slot = await prisma.quote_provider_availability.create({
      data: { quote_provider_id: p.quote_provider_id, slot_start, slot_end: slot_end && !Number.isNaN(slot_end.getTime()) ? slot_end : null },
    });
    res.status(201).json(slot);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to add availability' });
  }
});

// GET /quote-providers/me/availability — my upcoming slots.
router.get('/me/availability', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const p = await findMyProvider(req.user.user_id, vertical);
    if (!p) return res.json([]);
    const slots = await prisma.quote_provider_availability.findMany({
      where: { quote_provider_id: p.quote_provider_id, slot_start: { gte: new Date() } },
      orderBy: { slot_start: 'asc' },
    });
    res.json(slots);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch availability' });
  }
});

// DELETE /quote-providers/me/availability/:slotId — remove an unbooked slot.
router.delete('/me/availability/:slotId', authenticateToken, async (req, res) => {
  try {
    const vertical = requireVertical(req, res);
    if (!vertical) return;
    const p = await findMyProvider(req.user.user_id, vertical);
    if (!p) return res.status(404).json({ message: 'Not a provider' });
    const slot = await prisma.quote_provider_availability.findUnique({ where: { quote_provider_availability_id: Number(req.params.slotId) } });
    if (!slot || slot.quote_provider_id !== p.quote_provider_id) return res.status(404).json({ message: 'Slot not found' });
    if (slot.is_booked) return res.status(409).json({ message: 'Slot is already booked' });
    await prisma.quote_provider_availability.delete({ where: { quote_provider_availability_id: slot.quote_provider_availability_id } });
    res.json({ removed: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to remove slot' });
  }
});

export default router;
