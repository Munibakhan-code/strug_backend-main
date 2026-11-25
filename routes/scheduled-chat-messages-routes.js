import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import { paginate } from '../utils/pagination.js';
import {
  cancelScheduledChatMessage,
  createScheduledChatMessage,
  listPendingScheduledChatMessages,
  sendChatError,
  updateScheduledChatMessage,
} from '../services/scheduled-chat-service.js';

const router = express.Router();

router.post('/', authenticateToken, async (req, res) => {
  try {
    const row = await createScheduledChatMessage({
      channelId: req.body.channel_id,
      senderId: req.user.user_id,
      content: req.body.content,
      contentType: req.body.content_type,
      metadata: req.body.metadata ?? null,
      clientMsgId: req.body.client_msg_id,
      scheduledFor: req.body.scheduled_for,
    });
    res.status(201).json(row);
  } catch (err) {
    sendChatError(res, err, 'Failed to schedule message');
  }
});

router.get('/', authenticateToken, async (req, res) => {
  try {
    const rows = await paginate(req, res, ({ take, skip }) =>
      listPendingScheduledChatMessages({
        senderId: req.user.user_id,
        channelId: req.query.channel_id,
        take,
        skip,
      }),
    );
    res.json(rows);
  } catch (err) {
    sendChatError(res, err, 'Failed to list scheduled messages');
  }
});

router.patch('/:scheduled_message_id', authenticateToken, async (req, res) => {
  try {
    const row = await updateScheduledChatMessage({
      scheduledMessageId: req.params.scheduled_message_id,
      senderId: req.user.user_id,
      content: req.body.content,
      scheduledFor: req.body.scheduled_for,
    });
    res.json(row);
  } catch (err) {
    sendChatError(res, err, 'Failed to update scheduled message');
  }
});

router.delete('/:scheduled_message_id', authenticateToken, async (req, res) => {
  try {
    const row = await cancelScheduledChatMessage({
      scheduledMessageId: req.params.scheduled_message_id,
      senderId: req.user.user_id,
    });
    res.json(row);
  } catch (err) {
    sendChatError(res, err, 'Failed to cancel scheduled message');
  }
});

export default router;
