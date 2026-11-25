// routes/calmLessonOrderBuy.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

const ORDER_INCLUDE = {
  calm_lesson: {
    select: {
      calm_lesson_id: true,
      lesson_name: true,
      lesson_price: true,
      calm_provider_id: true,
      calm_providers: { select: { provider_user_id: true } },
    },
  },
  user: { select: { user_id: true, name: true } },
};

function isAdmin(req) {
  return req.user?.permission === 'admin';
}

function instructorUserId(order) {
  return order?.calm_lesson?.calm_providers?.provider_user_id ?? null;
}

function canSeeOrder(req, order) {
  if (!order) return false;
  if (isAdmin(req)) return true;
  if (order.user_id === req.user.user_id) return true;
  return instructorUserId(order) === req.user.user_id;
}

function canInstructOrder(req, order) {
  if (!order) return false;
  if (isAdmin(req)) return true;
  return instructorUserId(order) === req.user.user_id;
}

function serializeOrder(order) {
  if (!order) return order;
  const { calm_lesson, ...rest } = order;
  let lesson = null;
  if (calm_lesson) {
    const { calm_providers, ...lessonRest } = calm_lesson;
    lesson = lessonRest;
  }
  return {
    ...rest,
    calm_lesson: lesson,
    id: order.calm_lesson_order_buy_id,
    student_name: order.user?.name ?? null,
    lesson_title: lesson?.lesson_name ?? null,
    amount: lesson?.lesson_price ?? null,
  };
}

async function loadOrder(id) {
  return prisma.calm_lesson_order_buy.findUnique({
    where: { calm_lesson_order_buy_id: id },
    include: ORDER_INCLUDE,
  });
}

/**
 * Get calm lesson orders for the caller (as student or instructor). Admins see all.
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const where = isAdmin(req)
      ? {}
      : {
          OR: [
            { user_id: req.user.user_id },
            { calm_lesson: { calm_providers: { provider_user_id: req.user.user_id } } },
          ],
        };
    const orders = await prisma.calm_lesson_order_buy.findMany({
      where,
      orderBy: { calm_lesson_order_buy_id: 'desc' },
      include: ORDER_INCLUDE,
    });

    res.json(orders.map(serializeOrder));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calm lesson orders' });
  }
});

/**
 * Get single calm lesson order by calm_lesson_order_buy_id
 */
router.get('/:calm_lesson_order_buy_id', authenticateToken, async (req, res) => {
  try {
    const order = await loadOrder(Number(req.params.calm_lesson_order_buy_id));
    if (!order) return res.status(404).json({ error: 'Calm lesson order not found' });
    if (!canSeeOrder(req, order)) return res.status(403).json({ error: 'Forbidden' });

    res.json(serializeOrder(order));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calm lesson order' });
  }
});

/**
 * Create new calm lesson order — always enrolled as the authenticated user.
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { calm_lesson_id, order_time } = req.body;

    if (!calm_lesson_id) {
      return res.status(400).json({ error: 'calm_lesson_id is required' });
    }

    const lesson = await prisma.calm_lesson.findUnique({
      where: { calm_lesson_id: Number(calm_lesson_id) },
      select: { calm_lesson_id: true },
    });
    if (!lesson) return res.status(404).json({ error: 'Calm lesson not found' });

    const newOrder = await prisma.calm_lesson_order_buy.create({
      data: {
        calm_lesson_id: Number(calm_lesson_id),
        user_id: req.user.user_id,
        order_time: order_time ? new Date(order_time) : new Date(),
      },
      include: ORDER_INCLUDE,
    });

    io?.emit('calm-lesson-order-buy-created', serializeOrder(newOrder));

    res.status(201).json(serializeOrder(newOrder));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create calm lesson order' });
  }
});

/**
 * Update calm lesson order (instructor / admin only). Student reassignment is not allowed.
 */
router.put('/:calm_lesson_order_buy_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const existing = await loadOrder(Number(req.params.calm_lesson_order_buy_id));
    if (!existing) return res.status(404).json({ error: 'Calm lesson order not found' });
    if (!canInstructOrder(req, existing)) return res.status(403).json({ error: 'Forbidden' });

    const { calm_lesson_id, order_time } = req.body;

    const updatedOrder = await prisma.calm_lesson_order_buy.update({
      where: { calm_lesson_order_buy_id: existing.calm_lesson_order_buy_id },
      data: {
        calm_lesson_id: calm_lesson_id ? Number(calm_lesson_id) : existing.calm_lesson_id,
        order_time: order_time ? new Date(order_time) : existing.order_time,
      },
      include: ORDER_INCLUDE,
    });

    io?.emit('calm-lesson-order-buy-updated', serializeOrder(updatedOrder));

    res.json(serializeOrder(updatedOrder));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update calm lesson order' });
  }
});

/**
 * PUT /:id/accept — instructor accepts enrollment
 */
router.put('/:calm_lesson_order_buy_id/accept', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const id = Number(req.params.calm_lesson_order_buy_id);
    const order = await loadOrder(id);
    if (!order) return res.status(404).json({ successful: false, message: 'Enrollment not found' });
    if (!canInstructOrder(req, order)) return res.status(403).json({ successful: false, message: 'Forbidden' });
    if (order.status !== 'pending') return res.status(400).json({ successful: false, message: 'Enrollment no longer pending' });

    await prisma.calm_lesson_order_buy.update({ where: { calm_lesson_order_buy_id: id }, data: { status: 'accepted' } });
    io?.to(`user-${order.user_id}`).emit(`lesson-accepted-${id}`, { message: 'Enrollment accepted!' });
    return res.json({ successful: true, message: 'Enrollment accepted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * PUT /:id/decline — instructor declines enrollment
 */
router.put('/:calm_lesson_order_buy_id/decline', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const id = Number(req.params.calm_lesson_order_buy_id);
    const order = await loadOrder(id);
    if (!order) return res.status(404).json({ successful: false, message: 'Enrollment not found' });
    if (!canInstructOrder(req, order)) return res.status(403).json({ successful: false, message: 'Forbidden' });
    if (order.status !== 'pending') return res.status(400).json({ successful: false, message: 'Enrollment no longer pending' });

    await prisma.calm_lesson_order_buy.update({ where: { calm_lesson_order_buy_id: id }, data: { status: 'declined' } });
    io?.to(`user-${order.user_id}`).emit(`lesson-declined-${id}`, { message: 'Enrollment declined.' });
    return res.json({ successful: true, message: 'Enrollment declined' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * PATCH /:id/start — lesson is now in progress
 */
router.patch('/:calm_lesson_order_buy_id/start', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const id = Number(req.params.calm_lesson_order_buy_id);
    const order = await loadOrder(id);
    if (!order) return res.status(404).json({ successful: false, message: 'Enrollment not found' });
    if (!canInstructOrder(req, order)) return res.status(403).json({ successful: false, message: 'Forbidden' });
    if (order.status !== 'accepted') return res.status(400).json({ successful: false, message: 'Enrollment must be accepted before starting' });

    await prisma.calm_lesson_order_buy.update({ where: { calm_lesson_order_buy_id: id }, data: { status: 'in_progress' } });
    io?.to(`user-${order.user_id}`).emit(`lesson-started-${id}`, { message: 'Lesson in progress!' });
    return res.json({ successful: true, message: 'Lesson started' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * PATCH /:id/complete — lesson completed
 */
router.patch('/:calm_lesson_order_buy_id/complete', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const id = Number(req.params.calm_lesson_order_buy_id);
    const order = await loadOrder(id);
    if (!order) return res.status(404).json({ successful: false, message: 'Enrollment not found' });
    if (!canInstructOrder(req, order)) return res.status(403).json({ successful: false, message: 'Forbidden' });
    if (order.status !== 'in_progress') return res.status(400).json({ successful: false, message: 'Lesson must be in_progress to complete' });

    await prisma.calm_lesson_order_buy.update({ where: { calm_lesson_order_buy_id: id }, data: { status: 'completed' } });
    io?.to(`user-${order.user_id}`).emit(`lesson-completed-${id}`, { message: 'Lesson completed!' });
    return res.json({ successful: true, message: 'Lesson completed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * Delete calm lesson order — student (own enrollment) or instructor / admin.
 */
router.delete('/:calm_lesson_order_buy_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const existing = await loadOrder(Number(req.params.calm_lesson_order_buy_id));
    if (!existing) return res.status(404).json({ error: 'Calm lesson order not found' });
    if (!canSeeOrder(req, existing)) return res.status(403).json({ error: 'Forbidden' });

    const deleted = await prisma.calm_lesson_order_buy.delete({
      where: { calm_lesson_order_buy_id: existing.calm_lesson_order_buy_id },
    });

    io?.emit('calm-lesson-order-buy-deleted', { calm_lesson_order_buy_id: deleted.calm_lesson_order_buy_id });

    res.json({ message: 'Calm lesson order deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete calm lesson order' });
  }
});

export default router;
