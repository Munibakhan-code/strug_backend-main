import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from './../utils/prisma-client.js';
import {
  chatRoomName,
  createChatMessage,
  deleteChatMessage,
  ensureChannelParticipant,
  getChatMessage,
  getChannelMessages,
  markChannelMessagesRead,
  searchChannelMessages,
  sendChatError,
  updateChatMessage,
} from '../services/chat-service.js';
import { notifyChatRecipients } from '../services/chat-notification-service.js';
import { notifyTechSupportOnCustomerMessage } from '../services/support-email-service.js';
import { notifyJobApplicationChatMessage } from '../services/job-chat-email-service.js';

const router = express.Router();

/* Returns a cursor page in chronological display order. */
router.get('/channel/:channel_id', authenticateToken, async (req, res) => {
  try {
    const result = await getChannelMessages({
      channelId: req.params.channel_id,
      userId: req.user.user_id,
      limit: req.query.limit,
      beforeMessageId: req.query.before_message_id,
    });

    res.json(result);
  } catch (err) {
    sendChatError(res, err, 'Failed to fetch channel messages');
  }
});

router.patch('/channel/:channel_id/read', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const result = await markChannelMessagesRead({
      channelId: req.params.channel_id,
      userId: req.user.user_id,
    });

    io?.to(chatRoomName(result.channel_id)).emit('messages-read', result);
    res.json(result);
  } catch (err) {
    sendChatError(res, err, 'Failed to mark messages read');
  }
});

router.get('/channel/:channel_id/search', authenticateToken, async (req, res) => {
  try {
    const result = await searchChannelMessages({
      channelId: req.params.channel_id,
      userId: req.user.user_id,
      query: req.query.q,
      limit: req.query.limit,
      beforeMessageId: req.query.before_message_id,
    });

    res.json(result);
  } catch (err) {
    sendChatError(res, err, 'Failed to search messages');
  }
});

/* Clients must request messages within a channel they participate in. */
router.get('/', authenticateToken, (_req, res) => {
  res.status(400).json({ error: 'Use /chat-messages/channel/:channel_id to load messages' });
});

router.get('/:message_id', authenticateToken, async (req, res) => {
  try {
    const message = await getChatMessage({
      messageId: req.params.message_id,
      userId: req.user.user_id,
    });

    res.json(message);
  } catch (err) {
    sendChatError(res, err, 'Failed to fetch message');
  }
});

router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const newMessage = await createChatMessage({
      channelId: req.body.channel_id,
      senderId: req.user.user_id,
      content: req.body.content,
      contentType: req.body.content_type,
      platformTypeId: req.body.platform_type_id,
      clientMsgId: req.body.client_msg_id,
      metadata: req.body.metadata ?? null,
    });

    io?.to(chatRoomName(newMessage.channel_id)).emit('message-created', newMessage);
    await notifyChatRecipients(io, {
      channelId: newMessage.channel_id,
      senderId: req.user.user_id,
      messageId: newMessage.message_id,
      content: newMessage.content,
    });
    // #468: if this is a customer message in a support conversation, email the tech-support inbox
    // (staff alert only — never the customer). Fire-and-forget so it can't delay/break the response.
    notifyTechSupportOnCustomerMessage({
      channelId: newMessage.channel_id,
      senderId: req.user.user_id,
      messageId: newMessage.message_id,
      content: newMessage.content,
    }).catch(() => {});
    notifyJobApplicationChatMessage({
      channelId: newMessage.channel_id,
      senderId: req.user.user_id,
      messageId: newMessage.message_id,
      content: newMessage.content,
    }).catch(() => {});
    res.status(201).json(newMessage);
  } catch (err) {
    sendChatError(res, err, 'Failed to create message');
  }
});

router.put('/:message_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const updatedMessage = await updateChatMessage({
      messageId: req.params.message_id,
      userId: req.user.user_id,
      content: req.body.content,
    });

    io?.to(chatRoomName(updatedMessage.channel_id)).emit('message-updated', updatedMessage);
    res.json(updatedMessage);
  } catch (err) {
    sendChatError(res, err, 'Failed to update message');
  }
});

router.delete('/:message_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await deleteChatMessage({
      messageId: req.params.message_id,
      userId: req.user.user_id,
    });

    io?.to(chatRoomName(deleted.channel_id)).emit('message-deleted', deleted);

    res.json(deleted);
  } catch (err) {
    sendChatError(res, err, 'Failed to delete message');
  }
});

router.patch('/:message_id/react', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const { emoji } = req.body;
    if (!emoji || typeof emoji !== 'string' || emoji.length > 10) return res.status(400).json({ error: 'emoji required (max 10 chars)' });
    const messageId = Number(req.params.message_id);
    const userId = req.user.user_id;
    const existing = await prisma.chat_messages.findUnique({ where: { message_id: messageId } });
    if (!existing || existing.deleted_at) return res.status(404).json({ error: 'not found' });
    await ensureChannelParticipant(existing.channel_id, userId);
    const meta = (existing.metadata && typeof existing.metadata === 'object') ? { ...existing.metadata } : {};
    const reactions = meta.reactions && typeof meta.reactions === 'object' ? { ...meta.reactions } : {};
    const users = Array.isArray(reactions[emoji]) ? [...reactions[emoji]] : [];
    const idx = users.indexOf(userId);
    if (idx === -1) users.push(userId); else users.splice(idx, 1);
    if (users.length === 0) delete reactions[emoji]; else reactions[emoji] = users;
    meta.reactions = reactions;
    const updated = await prisma.chat_messages.update({ where: { message_id: messageId }, data: { metadata: meta } });
    io?.to(chatRoomName(existing.channel_id)).emit('message-updated', updated);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to react' });
  }
});

router.patch('/:message_id/pin', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const messageId = Number(req.params.message_id);
    const userId = req.user.user_id;
    const existing = await prisma.chat_messages.findUnique({ where: { message_id: messageId } });
    if (!existing || existing.deleted_at) return res.status(404).json({ error: 'not found' });
    await ensureChannelParticipant(existing.channel_id, userId);
    const meta = (existing.metadata && typeof existing.metadata === 'object') ? { ...existing.metadata } : {};
    meta.pinned = !meta.pinned;
    const updated = await prisma.chat_messages.update({ where: { message_id: messageId }, data: { metadata: meta } });
    io?.to(chatRoomName(existing.channel_id)).emit('message-updated', updated);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to pin' });
  }
});

router.patch('/:message_id/poll-vote', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const { option_id } = req.body;
    if (option_id == null) return res.status(400).json({ error: 'option_id required' });
    const messageId = Number(req.params.message_id);
    const userId = req.user.user_id;
    const existing = await prisma.chat_messages.findUnique({ where: { message_id: messageId } });
    if (!existing || existing.deleted_at) return res.status(404).json({ error: 'not found' });
    if (existing.content_type !== 'poll') return res.status(400).json({ error: 'not a poll' });
    await ensureChannelParticipant(existing.channel_id, userId);
    const meta = (existing.metadata && typeof existing.metadata === 'object') ? { ...existing.metadata } : {};
    const options = Array.isArray(meta.options) ? meta.options.map((opt) => ({ ...opt, voters: [...(opt.voters ?? [])] })) : [];
    const target = options.find((o) => String(o.id) === String(option_id));
    if (!target) return res.status(400).json({ error: 'invalid option_id' });
    if (!meta.allowMultiple) {
      options.forEach((o) => { o.voters = o.voters.filter((uid) => uid !== userId); });
    }
    const idx = target.voters.indexOf(userId);
    if (idx === -1) target.voters.push(userId); else target.voters.splice(idx, 1);
    meta.options = options;
    const updated = await prisma.chat_messages.update({ where: { message_id: messageId }, data: { metadata: meta } });
    io?.to(chatRoomName(existing.channel_id)).emit('message-updated', updated);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to vote on poll' });
  }
});

export default router;
