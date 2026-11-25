import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import {
  chatRoomName,
  createOwnedChannel,
  ensureChannelManager,
  ensureChannelParticipant,
  getUserChannels,
  leaveChannel,
  openDirectChannel,
  sendChatError,
} from '../services/chat-service.js';

const router = express.Router();

router.post('/dm', authenticateToken, async (req, res) => {
  try {
    const result = await openDirectChannel({
      userId: req.user.user_id,
      targetUserId: req.body.target_user_id,
      sourceVertical: req.body.source_vertical,
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    sendChatError(res, err, 'Failed to open DM channel');
  }
});

router.get('/', authenticateToken, async (req, res) => {
  try {
    res.json(await getUserChannels(req.user.user_id));
  } catch (err) {
    sendChatError(res, err, 'Failed to fetch chat channels');
  }
});

router.get('/:channel_id', authenticateToken, async (req, res) => {
  try {
    const channelId = Number(req.params.channel_id);
    await ensureChannelParticipant(channelId, req.user.user_id);

    const channel = await prisma.chat_channel.findUnique({
      where: { channel_id: channelId },
      include: { platform_type: true },
    });

    if (!channel) return res.status(404).json({ error: 'Chat channel not found' });
    res.json(channel);
  } catch (err) {
    sendChatError(res, err, 'Failed to fetch chat channel');
  }
});

router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const newChannel = await createOwnedChannel({
      userId: req.user.user_id,
      type: req.body.type,
      channelName: req.body.channel_name,
      platformTypeId: req.body.platform_type_id,
      contextType: req.body.context_type,
      contextId: req.body.context_id,
    });

    io?.to(chatRoomName(newChannel.channel_id)).emit('chat-channel-created', newChannel);
    res.status(201).json(newChannel);
  } catch (err) {
    sendChatError(res, err, 'Failed to create chat channel');
  }
});

router.put('/:channel_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const channelId = Number(req.params.channel_id);
    await ensureChannelManager(channelId, req.user.user_id);

    const existing = await prisma.chat_channel.findUnique({
      where: { channel_id: channelId },
    });
    if (!existing) return res.status(404).json({ error: 'Chat channel not found' });

    const updatedChannel = await prisma.chat_channel.update({
      where: { channel_id: channelId },
      data: {
        type: req.body.type ?? existing.type,
        channel_name: req.body.channel_name ?? existing.channel_name,
        platform_type_id: req.body.platform_type_id == null
          ? existing.platform_type_id
          : Number(req.body.platform_type_id),
        context_type: req.body.context_type ?? existing.context_type,
        context_id: req.body.context_id ?? existing.context_id,
      },
    });

    io?.to(chatRoomName(updatedChannel.channel_id)).emit('chat-channel-updated', updatedChannel);
    res.json(updatedChannel);
  } catch (err) {
    sendChatError(res, err, 'Failed to update chat channel');
  }
});

router.delete('/:channel_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const channelId = Number(req.params.channel_id);
    await ensureChannelManager(channelId, req.user.user_id);

    const deleted = await prisma.chat_channel.delete({
      where: { channel_id: channelId },
    });

    io?.to(chatRoomName(deleted.channel_id)).emit('chat-channel-deleted', {
      channel_id: deleted.channel_id,
    });
    res.json({ message: 'Chat channel deleted successfully' });
  } catch (err) {
    sendChatError(res, err, 'Failed to delete chat channel');
  }
});

// Add a participant to a group channel (owner/admin only).
router.post('/:channel_id/participants', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const channelId = Number(req.params.channel_id);
    const inviterId = req.user.user_id;
    const { user_id, username } = req.body;

    await ensureChannelManager(channelId, inviterId);

    const channel = await prisma.chat_channel.findUnique({ where: { channel_id: channelId } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.type !== 'group') return res.status(400).json({ error: 'Can only add members to group channels' });

    // Resolve target user by id, username (unique), or display name (unique-only fallback)
    let targetUser = null;
    if (user_id) {
      targetUser = await prisma.user.findUnique({ where: { user_id: Number(user_id) } });
    } else if (username) {
      // Username has a unique index — safe primary lookup
      targetUser = await prisma.user.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
      });
      // Fall back to display name only when exactly one user matches (non-unique identifier)
      if (!targetUser) {
        const byName = await prisma.user.findMany({
          where: { name: { equals: username, mode: 'insensitive' } },
          take: 2,
          select: { user_id: true, name: true, username: true },
        });
        if (byName.length === 1) {
          targetUser = byName[0];
        } else if (byName.length > 1) {
          return res.status(409).json({ error: 'Multiple users share that name — ask them for their @username instead' });
        }
      }
    }
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    // Idempotent — if already a participant just return
    const existing = await prisma.chat_participants.findFirst({
      where: { channel_id: channelId, user_id: targetUser.user_id },
    });
    if (existing) return res.json({ message: 'Already a member', participant: existing });

    const participant = await prisma.chat_participants.create({
      data: { channel_id: channelId, user_id: targetUser.user_id, role: 'member' },
    });

    io?.to(chatRoomName(channelId)).emit('chat-member-added', {
      channel_id: channelId,
      user: { user_id: targetUser.user_id, name: targetUser.name, username: targetUser.username },
    });

    res.status(201).json({ participant, user: { user_id: targetUser.user_id, name: targetUser.name } });
  } catch (err) {
    sendChatError(res, err, 'Failed to add participant');
  }
});

// Leave / delete a conversation for the current user only (soft, per-participant).
// Unlike DELETE /:channel_id (owner/admin hard-delete for everyone), any participant
// can remove the thread from their own inbox; the other side keeps it. (bug report #8)
router.delete('/:channel_id/leave', authenticateToken, async (req, res) => {
  try {
    const channelId = Number(req.params.channel_id);
    const result = await leaveChannel(channelId, req.user.user_id);
    res.json({ ...result, message: 'Conversation removed' });
  } catch (err) {
    sendChatError(res, err, 'Failed to leave conversation');
  }
});

export default router;
