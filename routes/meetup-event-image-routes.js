import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

const PUBLIC_USER = { select: { user_id: true, name: true, username: true } };

const IMAGE_INCLUDE = {
  meetup_event: {
    select: {
      meetup_event_id: true,
      meetup_event_name: true,
      meetup_event_organizer: true,
      user: PUBLIC_USER,
    },
  },
};

function parsePositiveInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

//======================================================================================================
//======================================= MEETUP EVENT IMAGE =========================================
//======================================================================================================

/* GET ALL MEETUP EVENT IMAGES */
router.get('/', async (_req, res) => {
  try {
    const images = await prisma.meetup_event_image.findMany({
      orderBy: { meetup_event_image_id: 'desc' },
      include: IMAGE_INCLUDE,
    });
    res.json(images);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch meetup event images' });
  }
});

/* GET MEETUP EVENT IMAGES BY EVENT ID — must be registered before /:id */
router.get('/event/:eventId', async (req, res) => {
  try {
    const eventId = parsePositiveInt(req.params.eventId);
    if (!eventId) {
      return res.status(400).json({ error: 'Invalid meetup event ID' });
    }

    const images = await prisma.meetup_event_image.findMany({
      where: { meetup_event_id: eventId },
      orderBy: { meetup_event_image_id: 'desc' },
      include: IMAGE_INCLUDE,
    });

    res.json(images);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch meetup event images' });
  }
});

/* GET MEETUP EVENT IMAGE BY ID */
router.get('/:id', async (req, res) => {
  try {
    const imageId = parsePositiveInt(req.params.id);
    if (!imageId) {
      return res.status(400).json({ error: 'Invalid meetup event image ID' });
    }

    const image = await prisma.meetup_event_image.findUnique({
      where: { meetup_event_image_id: imageId },
      include: IMAGE_INCLUDE,
    });

    if (!image) {
      return res.status(404).json({ error: 'Meetup event image not found' });
    }

    res.json(image);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch meetup event image' });
  }
});

/* CREATE MEETUP EVENT IMAGE */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const meetup_event_id = parsePositiveInt(req.body.meetup_event_id);
    const image_url = req.body.image_url;

    if (!meetup_event_id || !image_url) {
      return res.status(400).json({ error: 'Meetup event ID and image URL are required' });
    }

    const event = await prisma.meetup_event.findUnique({
      where: { meetup_event_id },
      select: { meetup_event_organizer: true },
    });
    if (!event) return res.status(404).json({ error: 'Meetup event not found' });
    if (event.meetup_event_organizer !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const image = await prisma.meetup_event_image.create({
      data: {
        meetup_event_id,
        image_url: String(image_url),
      },
      include: IMAGE_INCLUDE,
    });

    res.status(201).json(image);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create meetup event image' });
  }
});

/* UPDATE MEETUP EVENT IMAGE */
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const imageId = parsePositiveInt(req.params.id);
    if (!imageId) {
      return res.status(400).json({ error: 'Invalid meetup event image ID' });
    }

    const existing = await prisma.meetup_event_image.findUnique({
      where: { meetup_event_image_id: imageId },
      include: { meetup_event: { select: { meetup_event_organizer: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Meetup event image not found' });
    if (existing.meetup_event?.meetup_event_organizer !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const meetup_event_id = req.body.meetup_event_id
      ? parsePositiveInt(req.body.meetup_event_id)
      : undefined;
    const image = await prisma.meetup_event_image.update({
      where: { meetup_event_image_id: imageId },
      data: {
        meetup_event_id,
        image_url: req.body.image_url != null ? String(req.body.image_url) : undefined,
      },
      include: IMAGE_INCLUDE,
    });

    res.json(image);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update meetup event image' });
  }
});

/* DELETE MEETUP EVENT IMAGE */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const imageId = parsePositiveInt(req.params.id);
    if (!imageId) {
      return res.status(400).json({ error: 'Invalid meetup event image ID' });
    }

    const existing = await prisma.meetup_event_image.findUnique({
      where: { meetup_event_image_id: imageId },
      include: { meetup_event: { select: { meetup_event_organizer: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Meetup event image not found' });
    if (existing.meetup_event?.meetup_event_organizer !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.meetup_event_image.delete({
      where: { meetup_event_image_id: imageId },
    });

    res.json({ message: 'Meetup event image deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete meetup event image' });
  }
});

export default router;
