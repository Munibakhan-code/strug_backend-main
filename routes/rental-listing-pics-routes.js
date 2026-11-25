import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin, requireAdmin } from '../middleware/require-admin.js';

const router = express.Router();

function parseId(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

async function assertListingOwner(rental_listing_id, req) {
  const listing = await prisma.rental_listing.findUnique({
    where: { rental_listing_id },
    select: { rental_listing_id: true, owner_id: true },
  });
  if (!listing) return { error: 404, message: 'Rental listing not found' };
  if (!isAdmin(req) && listing.owner_id !== req.user.user_id) {
    return { error: 403, message: 'Forbidden' };
  }
  return { listing };
}

/* GET ALL — admin only (was unauthenticated dump) */
router.get('/', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const pics = await prisma.rental_listing_pics.findMany({
      orderBy: { rental_pics_id: 'desc' },
      include: {
        rental_listing: true,
        rental_type: true,
      },
      take: 200,
    });
    res.json(pics);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rental listing pics' });
  }
});

/* GET PICS BY LISTING ID — public catalog read for a known listing */
router.get('/listing/:rental_listing_id', async (req, res) => {
  try {
    const rental_listing_id = parseId(req.params.rental_listing_id);
    if (Number.isNaN(rental_listing_id)) {
      return res.status(400).json({ error: 'rental_listing_id must be a number' });
    }

    const pics = await prisma.rental_listing_pics.findMany({
      where: { rental_listing_id },
      include: { rental_type: true },
      take: 100,
    });
    res.json(pics);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch pics for rental listing' });
  }
});

/* ADD — listing owner or admin */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const rental_listing_id = parseId(req.body.rental_listing_id);
    if (Number.isNaN(rental_listing_id)) {
      return res.status(400).json({ error: 'rental_listing_id is required' });
    }
    const gate = await assertListingOwner(rental_listing_id, req);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const { url, rental_type_id } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const pic = await prisma.rental_listing_pics.create({
      data: {
        rental_listing_id,
        url,
        rental_type_id: rental_type_id != null ? Number(rental_type_id) : null,
      },
      include: {
        rental_listing: true,
        rental_type: true,
      },
    });

    res.status(201).json(pic);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add rental listing pic' });
  }
});

/* UPDATE — listing owner or admin */
router.put('/:rental_pics_id', authenticateToken, async (req, res) => {
  try {
    const rental_pics_id = parseId(req.params.rental_pics_id);
    if (Number.isNaN(rental_pics_id)) {
      return res.status(400).json({ error: 'rental_pics_id must be a number' });
    }

    const existing = await prisma.rental_listing_pics.findUnique({ where: { rental_pics_id } });
    if (!existing) return res.status(404).json({ error: 'Rental listing pic not found' });

    const listingId = existing.rental_listing_id;
    if (listingId == null) return res.status(400).json({ error: 'Pic has no listing' });
    const gate = await assertListingOwner(listingId, req);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    // Do not allow reassignment to another listing unless admin + body provides id they own.
    let nextListingId = existing.rental_listing_id;
    if (req.body.rental_listing_id != null && isAdmin(req)) {
      nextListingId = Number(req.body.rental_listing_id);
    }

    const updated = await prisma.rental_listing_pics.update({
      where: { rental_pics_id },
      data: {
        rental_listing_id: nextListingId,
        url: req.body.url ?? existing.url,
        rental_type_id: req.body.rental_type_id ?? existing.rental_type_id,
      },
      include: {
        rental_listing: true,
        rental_type: true,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update rental listing pic' });
  }
});

/* DELETE — listing owner or admin */
router.delete('/:rental_pics_id', authenticateToken, async (req, res) => {
  try {
    const rental_pics_id = parseId(req.params.rental_pics_id);
    if (Number.isNaN(rental_pics_id)) {
      return res.status(400).json({ error: 'rental_pics_id must be a number' });
    }

    const existing = await prisma.rental_listing_pics.findUnique({ where: { rental_pics_id } });
    if (!existing) return res.status(404).json({ error: 'Rental listing pic not found' });
    if (existing.rental_listing_id == null) return res.status(400).json({ error: 'Pic has no listing' });

    const gate = await assertListingOwner(existing.rental_listing_id, req);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    await prisma.rental_listing_pics.delete({ where: { rental_pics_id } });
    res.json({ message: 'Rental listing pic deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete rental listing pic' });
  }
});

export default router;
