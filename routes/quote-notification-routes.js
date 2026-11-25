import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// GET /quote-notifications — newest first + unread count.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 30);
    const [items, unread] = await Promise.all([
      prisma.quote_notification.findMany({ where: { user_id: req.user.user_id }, orderBy: { created_at: 'desc' }, take: limit }),
      prisma.quote_notification.count({ where: { user_id: req.user.user_id, is_read: false } }),
    ]);
    res.json({ items, unread });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch notifications' }); }
});

// GET /quote-notifications/unread-count
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    const unread = await prisma.quote_notification.count({ where: { user_id: req.user.user_id, is_read: false } });
    res.json({ unread });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch count' }); }
});

// PATCH /quote-notifications/read-all
router.patch('/read-all', authenticateToken, async (req, res) => {
  try {
    await prisma.quote_notification.updateMany({ where: { user_id: req.user.user_id, is_read: false }, data: { is_read: true } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to mark read' }); }
});

// PATCH /quote-notifications/:id/read
router.patch('/:id/read', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.quote_notification.updateMany({ where: { quote_notification_id: id, user_id: req.user.user_id }, data: { is_read: true } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to mark read' }); }
});

export default router;
