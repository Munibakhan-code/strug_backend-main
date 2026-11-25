import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

const PUBLIC_USER = { select: { user_id: true, name: true, username: true } };

const EVENT_PUBLIC_INCLUDE = {
  meetup_category: { select: { meetup_category_id: true, meetup_category_name: true } },
  user: PUBLIC_USER,
  meetup_attendees: { select: { meetup_attendees_id: true, user_id: true, role: true } },
  meetup_event_image: { select: { meetup_event_image_id: true, meetup_event_id: true, image_url: true } },
};

function parsePositiveInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadEvent(id) {
  return prisma.meetup_event.findUnique({
    where: { meetup_event_id: id },
    include: EVENT_PUBLIC_INCLUDE,
  });
}

async function assertEventOrganizer(eventId, userId) {
  const event = await prisma.meetup_event.findUnique({
    where: { meetup_event_id: eventId },
    select: { meetup_event_id: true, meetup_event_organizer: true },
  });
  if (!event) return { error: 404, message: 'Meetup event not found' };
  if (event.meetup_event_organizer !== userId) return { error: 403, message: 'Forbidden' };
  return { event };
}

//======================================================================================================
//======================================== MEETUP ATTENDEES =========================================
//======================================================================================================

/* GET MEETUP ATTENDEES FOR AN EVENT */
router.get('/attendees', async (req, res) => {
  try {
    const eventId = parsePositiveInt(req.query.event_id ?? req.query.meetup_event_id);
    if (!eventId) {
      return res.status(400).json({ error: 'event_id is required' });
    }
    const attendees = await prisma.meetup_attendees.findMany({
      where: { meetup_event_id: eventId },
      orderBy: { meetup_attendees_id: 'desc' },
      include: { user: PUBLIC_USER },
    });
    res.json(attendees);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch meetup attendees' });
  }
});

/* GET MEETUP ATTENDEE BY ID */
router.get('/attendees/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid attendee id' });
    const attendee = await prisma.meetup_attendees.findUnique({
      where: { meetup_attendees_id: id },
      include: { user: PUBLIC_USER },
    });

    if (!attendee) {
      return res.status(404).json({ error: 'Meetup attendee not found' });
    }

    res.json(attendee);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch meetup attendee' });
  }
});

/* CREATE MEETUP ATTENDEE (RSVP as the authenticated user) */
router.post('/attendees', authenticateToken, async (req, res) => {
  try {
    const meetup_event_id = parsePositiveInt(req.body.meetup_event_id);
    const role = req.body.role != null ? String(req.body.role).slice(0, 40) : 'attendee';
    if (!meetup_event_id) {
      return res.status(400).json({ error: 'meetup_event_id is required' });
    }

    const event = await prisma.meetup_event.findUnique({
      where: { meetup_event_id },
      select: { meetup_event_id: true, meetup_event_max_attendees: true },
    });
    if (!event) return res.status(404).json({ error: 'Meetup event not found' });

    const existing = await prisma.meetup_attendees.findFirst({
      where: { meetup_event_id, user_id: req.user.user_id },
    });
    if (existing) {
      return res.status(200).json(existing);
    }

    if (event.meetup_event_max_attendees) {
      const count = await prisma.meetup_attendees.count({ where: { meetup_event_id } });
      if (count >= event.meetup_event_max_attendees) {
        return res.status(409).json({ error: 'This meetup is full', message: 'This meetup is full' });
      }
    }

    const attendee = await prisma.meetup_attendees.create({
      data: {
        meetup_event_id,
        user_id: req.user.user_id,
        role,
      },
    });

    res.status(201).json(attendee);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create meetup attendee' });
  }
});

/* UPDATE MEETUP ATTENDEE */
router.put('/attendees/:id', authenticateToken, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid attendee id' });
    const existing = await prisma.meetup_attendees.findUnique({
      where: { meetup_attendees_id: id },
      include: { meetup_event: { select: { meetup_event_organizer: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Meetup attendee not found' });
    const isSelf = existing.user_id === req.user.user_id;
    const isOrganizer = existing.meetup_event?.meetup_event_organizer === req.user.user_id;
    if (!isSelf && !isOrganizer) return res.status(403).json({ error: 'Forbidden' });

    const role = req.body.role != null ? String(req.body.role).slice(0, 40) : existing.role;
    const attendee = await prisma.meetup_attendees.update({
      where: { meetup_attendees_id: id },
      data: { role },
    });

    res.json(attendee);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update meetup attendee' });
  }
});

/* DELETE MEETUP ATTENDEE */
router.delete('/attendees/:id', authenticateToken, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid attendee id' });
    const existing = await prisma.meetup_attendees.findUnique({
      where: { meetup_attendees_id: id },
      include: { meetup_event: { select: { meetup_event_organizer: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Meetup attendee not found' });
    const isSelf = existing.user_id === req.user.user_id;
    const isOrganizer = existing.meetup_event?.meetup_event_organizer === req.user.user_id;
    if (!isSelf && !isOrganizer) return res.status(403).json({ error: 'Forbidden' });

    await prisma.meetup_attendees.delete({
      where: { meetup_attendees_id: id },
    });

    res.json({ message: 'Meetup attendee deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete meetup attendee' });
  }
});

//======================================================================================================
//======================================== MEETUP CATEGORY ==========================================
//======================================================================================================

/* GET ALL MEETUP CATEGORIES */
router.get('/categories', async (_req, res) => {
  try {
    const categories = await prisma.meetup_category.findMany({
      orderBy: { meetup_category_id: 'desc' },
      select: {
        meetup_category_id: true,
        meetup_category_name: true,
      },
    });
    res.json(categories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch meetup categories' });
  }
});

/* GET MEETUP CATEGORY BY ID */
router.get('/categories/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid category id' });
    const category = await prisma.meetup_category.findUnique({
      where: { meetup_category_id: id },
      select: {
        meetup_category_id: true,
        meetup_category_name: true,
        meetup_event: {
          select: { meetup_event_id: true, meetup_event_name: true, meetup_event_start_time: true },
        },
      },
    });

    if (!category) {
      return res.status(404).json({ error: 'Meetup category not found' });
    }

    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch meetup category' });
  }
});

/* CREATE MEETUP CATEGORY */
router.post('/categories', authenticateToken, async (req, res) => {
  try {
    const meetup_category_name = String(req.body.meetup_category_name || '').trim();
    if (!meetup_category_name) {
      return res.status(400).json({ error: 'meetup_category_name is required' });
    }

    const category = await prisma.meetup_category.create({
      data: { meetup_category_name },
    });

    res.status(201).json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create meetup category' });
  }
});

/* UPDATE MEETUP CATEGORY */
router.put('/categories/:id', authenticateToken, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid category id' });
    const meetup_category_name = String(req.body.meetup_category_name || '').trim();
    if (!meetup_category_name) {
      return res.status(400).json({ error: 'meetup_category_name is required' });
    }

    const category = await prisma.meetup_category.update({
      where: { meetup_category_id: id },
      data: { meetup_category_name },
    });

    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update meetup category' });
  }
});

/* DELETE MEETUP CATEGORY */
router.delete('/categories/:id', authenticateToken, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid category id' });
    await prisma.meetup_category.delete({
      where: { meetup_category_id: id },
    });

    res.json({ message: 'Meetup category deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete meetup category' });
  }
});

//======================================================================================================
//========================================== MEETUP EVENT ============================================
//======================================================================================================

/* GET ALL MEETUP EVENTS */
router.get('/events', async (_req, res) => {
  try {
    const events = await prisma.meetup_event.findMany({
      orderBy: { meetup_event_id: 'desc' },
      include: EVENT_PUBLIC_INCLUDE,
    });
    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch meetup events' });
  }
});

/* GET MEETUP EVENT BY ID */
router.get('/events/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const event = await loadEvent(id);

    if (!event) {
      return res.status(404).json({ error: 'Meetup event not found' });
    }

    res.json(event);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch meetup event' });
  }
});

/* CREATE MEETUP EVENT */
router.post('/events', authenticateToken, async (req, res) => {
  try {
    const {
      meetup_event_name,
      meetup_event_description,
      meetup_event_duration,
      meetup_event_price,
      meetup_event_category_id,
      meetup_event_start_time,
      meetup_event_location,
      meetup_event_max_attendees,
    } = req.body;

    const event = await prisma.meetup_event.create({
      data: {
        meetup_event_name,
        meetup_event_description,
        meetup_event_duration: meetup_event_duration ? parseInt(meetup_event_duration, 10) : null,
        meetup_event_price: meetup_event_price != null && meetup_event_price !== '' ? parseFloat(meetup_event_price) : null,
        meetup_event_category_id: meetup_event_category_id ? parseInt(meetup_event_category_id, 10) : null,
        meetup_event_start_time: meetup_event_start_time ? new Date(meetup_event_start_time) : null,
        meetup_event_location,
        meetup_event_organizer: req.user.user_id,
        meetup_event_max_attendees: meetup_event_max_attendees ? parseInt(meetup_event_max_attendees, 10) : null,
      },
    });

    res.status(201).json(event);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create meetup event' });
  }
});

/* UPDATE MEETUP EVENT */
router.put('/events/:id', authenticateToken, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertEventOrganizer(id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const {
      meetup_event_name,
      meetup_event_description,
      meetup_event_duration,
      meetup_event_price,
      meetup_event_category_id,
      meetup_event_start_time,
      meetup_event_location,
      meetup_event_max_attendees,
    } = req.body;

    const event = await prisma.meetup_event.update({
      where: { meetup_event_id: id },
      data: {
        meetup_event_name,
        meetup_event_description,
        meetup_event_duration: meetup_event_duration ? parseInt(meetup_event_duration, 10) : undefined,
        meetup_event_price: meetup_event_price != null && meetup_event_price !== '' ? parseFloat(meetup_event_price) : undefined,
        meetup_event_category_id: meetup_event_category_id ? parseInt(meetup_event_category_id, 10) : undefined,
        meetup_event_start_time: meetup_event_start_time ? new Date(meetup_event_start_time) : undefined,
        meetup_event_location,
        meetup_event_max_attendees: meetup_event_max_attendees ? parseInt(meetup_event_max_attendees, 10) : undefined,
      },
    });

    res.json(event);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update meetup event' });
  }
});

/* DELETE MEETUP EVENT */
router.delete('/events/:id', authenticateToken, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertEventOrganizer(id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    await prisma.meetup_event.delete({
      where: { meetup_event_id: id },
    });

    res.json({ message: 'Meetup event deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete meetup event' });
  }
});

export default router;
