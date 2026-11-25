// routes/board-notifications-routes.js
//
// In-app notifications for the Task Board (M4). Notifications are written by other flows
// (assignment, ready_for_review, changes_requested, approved, on_staging, done, comment,
// account_approved); this router lets a member read and clear their own. Polled by the
// NotificationBell on the frontend — no realtime/sockets.
//
//   GET   /board/notifications            recent notifications for the caller + unread count
//   PATCH /board/notifications/:id/read   mark one read
//   POST  /board/notifications/read-all   mark all the caller's notifications read

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard } from '../middleware/authenticate-board.js';

const router = express.Router();
router.use(authenticateBoard);

// GET /board/notifications
router.get('/', async (req, res) => {
  try {
    const memberId = req.member.member_id;
    const [notifications, unread] = await Promise.all([
      prisma.board_notification.findMany({
        where: { member_id: memberId },
        orderBy: { created_at: 'desc' },
        take: 50,
      }),
      prisma.board_notification.count({ where: { member_id: memberId, is_read: false } }),
    ]);
    return res.status(200).json({ successful: true, notifications, unread });
  } catch (err) {
    console.error('[board-notifications] list error:', err);
    return res.status(500).json({ successful: false, message: 'Could not load notifications' });
  }
});

// PATCH /board/notifications/:id/read — only the caller's own notification.
router.patch('/:id/read', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ successful: false, message: 'Invalid notification id' });
  try {
    // Scope to the caller so one member can't flip another's notifications.
    const result = await prisma.board_notification.updateMany({
      where: { notification_id: id, member_id: req.member.member_id },
      data: { is_read: true },
    });
    if (result.count === 0) return res.status(404).json({ successful: false, message: 'Notification not found' });
    return res.status(200).json({ successful: true });
  } catch (err) {
    console.error('[board-notifications] mark-read error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update notification' });
  }
});

// POST /board/notifications/read-all
router.post('/read-all', async (req, res) => {
  try {
    await prisma.board_notification.updateMany({
      where: { member_id: req.member.member_id, is_read: false },
      data: { is_read: true },
    });
    return res.status(200).json({ successful: true });
  } catch (err) {
    console.error('[board-notifications] read-all error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update notifications' });
  }
});

export default router;
