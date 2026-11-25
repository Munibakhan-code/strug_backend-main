import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import {
  chatRoomName,
  ensureChannelManager,
  ensureChannelParticipant,
  getUserInbox,
  sendChatError,
} from '../services/chat-service.js';

const router = express.Router();

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

async function ensureMutableChannel(channelId, userId) {
  await ensureChannelManager(channelId, userId);
  const channel = await prisma.chat_channel.findUnique({
    where: { channel_id: Number(channelId) },
    select: { type: true },
  });
  if (channel?.type === 'dm') {
    throw forbidden('DM membership cannot be modified');
  }
}

router.get('/channel/:channel_id', authenticateToken, async (req, res) => {
  try {
    const channelId = Number(req.params.channel_id);
    await ensureChannelParticipant(channelId, req.user.user_id);

    const participants = await prisma.chat_participants.findMany({
      where: { channel_id: channelId },
      orderBy: { chat_participant_id: 'asc' },
      include: {
        user: {
          select: {
            user_id: true,
            name: true,
            username: true,
            // to-ONE relation → no `take` (Prisma 6.19 rejects it); returns an object or null.
            social_profiles: {
              select: { handle: true, display_name: true, profile_pic_url: true },
            },
          },
        },
      },
    });

    res.json(participants.map((participant) => {
      const user = participant.user;
      // Prefer the platform display name over user.name (Google sign-ups store their
      // real Google name in user.name — bug #92).
      const name = user?.social_profiles?.display_name || user?.username || user?.name || 'User';
      return {
        user_id: participant.user_id,
        role: participant.role,
        name,
        handle: user?.social_profiles?.handle || user?.username || null,
        profile_pic_url: user?.social_profiles?.profile_pic_url || null,
      };
    }));
  } catch (err) {
    sendChatError(res, err, 'Failed to fetch channel participants');
  }
});

router.get('/my-channels', authenticateToken, async (req, res) => {
  try {
    res.json(await getUserInbox(req.user.user_id));
  } catch (err) {
    sendChatError(res, err, 'Failed to fetch my channels');
  }
});

router.patch('/channel/:channel_id/mute', authenticateToken, async (req, res) => {
  try {
    const channelId = Number(req.params.channel_id);
    await ensureChannelParticipant(channelId, req.user.user_id);
    const muted = req.body.muted === true;

    await prisma.chat_participants.updateMany({
      where: { channel_id: channelId, user_id: req.user.user_id },
      data: { muted },
    });

    res.json({ channel_id: channelId, muted });
  } catch (err) {
    sendChatError(res, err, 'Failed to update chat mute setting');
  }
});

router.get('/', authenticateToken, async (req, res) => {
  try {
    const mine = await prisma.chat_participants.findMany({
      where: { user_id: req.user.user_id },
      select: { channel_id: true },
    });
    const channelIds = mine.map((item) => item.channel_id).filter(Boolean);
    const participants = channelIds.length
      ? await prisma.chat_participants.findMany({
        where: { channel_id: { in: channelIds } },
        orderBy: { chat_participant_id: 'asc' },
        include: { user: true, chat_channel: true, platform_type: true },
      })
      : [];

    res.json(participants);
  } catch (err) {
    sendChatError(res, err, 'Failed to fetch participants');
  }
});

router.get('/:chat_participant_id', authenticateToken, async (req, res) => {
  try {
    const participant = await prisma.chat_participants.findUnique({
      where: { chat_participant_id: Number(req.params.chat_participant_id) },
      include: { user: true, chat_channel: true, platform_type: true },
    });
    if (!participant) return res.status(404).json({ error: 'Participant not found' });

    await ensureChannelParticipant(participant.channel_id, req.user.user_id);
    res.json(participant);
  } catch (err) {
    sendChatError(res, err, 'Failed to fetch participant');
  }
});

router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    await ensureMutableChannel(req.body.channel_id, req.user.user_id);
    const existingParticipant = await prisma.chat_participants.findFirst({
      where: {
        channel_id: Number(req.body.channel_id),
        user_id: Number(req.body.user_id),
      },
    });
    if (existingParticipant) {
      throw conflict('User is already a participant in this channel');
    }

    const participant = await prisma.chat_participants.create({
      data: {
        channel_id: Number(req.body.channel_id),
        user_id: Number(req.body.user_id),
        role: req.body.role || 'member',
        platform_type_id: req.body.platform_type_id == null
          ? null
          : Number(req.body.platform_type_id),
      },
    });

    io?.to(chatRoomName(participant.channel_id)).emit('participant-added', participant);
    res.status(201).json(participant);
  } catch (err) {
    sendChatError(res, err, 'Failed to add participant');
  }
});

router.put('/:chat_participant_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const existing = await prisma.chat_participants.findUnique({
      where: { chat_participant_id: Number(req.params.chat_participant_id) },
    });
    if (!existing) return res.status(404).json({ error: 'Participant not found' });
    await ensureMutableChannel(existing.channel_id, req.user.user_id);

    const updatedParticipant = await prisma.chat_participants.update({
      where: { chat_participant_id: existing.chat_participant_id },
      data: {
        role: req.body.role ?? existing.role,
        platform_type_id: req.body.platform_type_id == null
          ? existing.platform_type_id
          : Number(req.body.platform_type_id),
      },
    });

    io?.to(chatRoomName(updatedParticipant.channel_id)).emit('participant-updated', updatedParticipant);
    res.json(updatedParticipant);
  } catch (err) {
    sendChatError(res, err, 'Failed to update participant');
  }
});

router.delete('/:chat_participant_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const existing = await prisma.chat_participants.findUnique({
      where: { chat_participant_id: Number(req.params.chat_participant_id) },
    });
    if (!existing) return res.status(404).json({ error: 'Participant not found' });
    await ensureMutableChannel(existing.channel_id, req.user.user_id);
    if (existing.user_id === req.user.user_id) {
      throw forbidden('Channel owner cannot remove themselves');
    }

    const deleted = await prisma.chat_participants.delete({
      where: { chat_participant_id: existing.chat_participant_id },
    });

    io?.to(chatRoomName(deleted.channel_id)).emit('participant-removed', {
      chat_participant_id: deleted.chat_participant_id,
      channel_id: deleted.channel_id,
    });
    res.json({ message: 'Participant removed successfully' });
  } catch (err) {
    sendChatError(res, err, 'Failed to remove participant');
  }
});

export default router;
