// routes/notification-routes.js — read/mark API for the unified `notification` table (Epic 10).
// Mounted at /notifications. Writes happen through services/notify.js, never here.

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { blockedGraphForUser } from '../utils/platform-blocks.js';

const router = express.Router();

function notificationTouchesBlockedAccount(row, blockedGraph) {
  const data = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const blockedUsers = new Set((blockedGraph?.userIds || []).map(Number));
  const blockedProfiles = new Set((blockedGraph?.profileIds || []).map(Number));
  const userRefs = [
    data.actorUserId,
    data.actor_user_id,
    data.senderUserId,
    data.sender_user_id,
    data.fromUserId,
    data.from_user_id,
    row?.entity_type === 'profile' ? row?.entity_id : null,
  ].map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const profileRefs = [
    data.actorProfileId,
    data.actor_profile_id,
    data.senderProfileId,
    data.sender_profile_id,
    data.profile_id,
  ].map(Number).filter((id) => Number.isInteger(id) && id > 0);
  return userRefs.some((id) => blockedUsers.has(id)) || profileRefs.some((id) => blockedProfiles.has(id));
}

async function visibleNotificationsForUser(userId, where, { orderBy = undefined, take = undefined, select = undefined } = {}) {
  const blockedGraph = await blockedGraphForUser(userId);
  const rows = await prisma.notification.findMany({ where, orderBy, take, select });
  return rows.filter((row) => !notificationTouchesBlockedAccount(row, blockedGraph));
}

// GET /notifications — newest first, plus unread count. Optional ?vertical= filter and ?limit=.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit) || 40);
    const where = { user_id: req.user.user_id };
    if (req.query.vertical) where.vertical = String(req.query.vertical);
    const [items, unreadRows] = await Promise.all([
      visibleNotificationsForUser(req.user.user_id, where, { orderBy: { created_at: 'desc' }, take: limit }),
      visibleNotificationsForUser(req.user.user_id, { user_id: req.user.user_id, is_read: false }, { select: { data: true, entity_type: true, entity_id: true } }),
    ]);
    const unread = unreadRows.length;
    res.json({ items, unread });
  } catch (e) { console.error('[notifications] list', e); res.status(500).json({ message: 'Failed to fetch notifications' }); }
});

// GET /notifications/unread-count
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    const unreadRows = await visibleNotificationsForUser(
      req.user.user_id,
      { user_id: req.user.user_id, is_read: false },
      { select: { data: true, entity_type: true, entity_id: true } }
    );
    const unread = unreadRows.length;
    res.json({ unread });
  } catch (e) { console.error('[notifications] count', e); res.status(500).json({ message: 'Failed to fetch count' }); }
});

// PATCH /notifications/read-all
router.patch('/read-all', authenticateToken, async (req, res) => {
  try {
    await prisma.notification.updateMany({ where: { user_id: req.user.user_id, is_read: false }, data: { is_read: true } });
    res.json({ ok: true });
  } catch (e) { console.error('[notifications] read-all', e); res.status(500).json({ message: 'Failed to mark read' }); }
});

// PATCH /notifications/:id/read — scoped by user_id so a user can only mark their OWN rows read.
router.patch('/:id/read', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid id' });
    const { count } = await prisma.notification.updateMany({
      where: { notification_id: id, user_id: req.user.user_id },
      data: { is_read: true },
    });
    if (count === 0) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true });
  } catch (e) { console.error('[notifications] read-one', e); res.status(500).json({ message: 'Failed to mark read' }); }
});

// DELETE /notifications/:id — dismiss a single row for good (the panel's per-row ✕). Scoped by
// user_id like the read routes, so a user can only delete their OWN rows. Idempotent: deleting an
// already-gone row returns 404, which the client treats as "already dismissed", not an error.
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid id' });
    const { count } = await prisma.notification.deleteMany({
      where: { notification_id: id, user_id: req.user.user_id },
    });
    if (count === 0) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true });
  } catch (e) { console.error('[notifications] delete', e); res.status(500).json({ message: 'Failed to dismiss' }); }
});

export default router;
