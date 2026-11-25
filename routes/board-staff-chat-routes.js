// routes/board-staff-chat-routes.js
//
// Internal staff messaging REST — mounted at /board/messages behind authenticateBoard.
// Available to EVERY approved board member (messaging is a global surface, not a single
// dashboard), with per-channel access resolved in the service from req.access:
//   - company channels  → all members
//   - team channels      → members with read access to that dashboard_key
//   - dm / custom        → explicit participants
// Creating a custom channel requires the can_create_channels capability (or super-admin).
//
//   GET  /board/messages/channels                 grouped channel list (+ unread)
//   POST /board/messages/channels                 create a custom (topic|incident) channel
//   POST /board/messages/channels/dm              open/get a 1:1 DM
//   GET  /board/messages/channels/:id/messages    history (cursor: ?before=&limit=)
//   POST /board/messages/channels/:id/messages    send a message
//   POST /board/messages/channels/:id/read        mark the channel read
//   GET  /board/messages/channels/:id/members     channel roster
//   POST /board/messages/channels/:id/members     invite a member (allowed_roles enforced)
//   GET  /board/messages/directory                invitable staff directory

import express from 'express';
import { authenticateBoard } from '../middleware/authenticate-board.js';
import prisma from '../utils/prisma-client.js';
import * as chat from '../services/staff-chat-service.js';
import { notifyStaffMentions } from '../services/staff-notify-service.js';

const router = express.Router();
router.use(authenticateBoard);

// Translate a service error into a response: known 4xx pass their message through (safe,
// intentional), anything else is shielded as a generic 500 (no internal detail leaked).
function fail(res, err, tag) {
  if (err && err.statusCode && err.statusCode < 500) {
    return res.status(err.statusCode).json({ successful: false, message: err.message });
  }
  console.error(tag, err);
  return res.status(500).json({ successful: false, message: 'Internal server error' });
}

const canCreateChannels = (req) => !!(req.member?.is_super_admin || req.memberRole?.can_create_channels);

// GET /channels
router.get('/channels', async (req, res) => {
  try {
    const channels = await chat.listChannelsForMember({
      memberId: req.member.member_id,
      access: req.access,
      isSuperAdmin: !!req.member.is_super_admin,
    });
    return res.status(200).json({ successful: true, channels, can_create_channels: canCreateChannels(req) });
  } catch (err) {
    return fail(res, err, '[staff-chat] list channels error:');
  }
});

// POST /channels — create a custom team / group channel (role-gated)
router.post('/channels', async (req, res) => {
  if (!canCreateChannels(req)) {
    return res.status(403).json({ successful: false, message: 'Your role cannot create channels' });
  }
  try {
    const { kind, name, is_private, allowed_roles } = req.body || {};
    const channel = await chat.createChannel({
      creatorId: req.member.member_id,
      kind,
      name,
      isPrivate: is_private,
      allowedRoles: allowed_roles,
    });
    return res.status(201).json({ successful: true, channel });
  } catch (err) {
    return fail(res, err, '[staff-chat] create channel error:');
  }
});

// POST /channels/dm — open (or fetch) a 1:1 DM
router.post('/channels/dm', async (req, res) => {
  try {
    const result = await chat.openDirectChannel({
      memberId: req.member.member_id,
      targetMemberId: req.body?.target_member_id,
    });
    return res.status(200).json({ successful: true, ...result });
  } catch (err) {
    return fail(res, err, '[staff-chat] open dm error:');
  }
});

// GET /channels/:id/messages
router.get('/channels/:id/messages', async (req, res) => {
  try {
    const result = await chat.getChannelMessages({
      channelId: req.params.id,
      memberId: req.member.member_id,
      limit: req.query.limit,
      beforeMessageId: req.query.before,
      access: req.access,
      isSuperAdmin: !!req.member.is_super_admin,
    });
    return res.status(200).json({ successful: true, ...result });
  } catch (err) {
    return fail(res, err, '[staff-chat] messages error:');
  }
});

// POST /channels/:id/messages
router.post('/channels/:id/messages', async (req, res) => {
  try {
    const message = await chat.createMessage({
      channelId: req.params.id,
      senderId: req.member.member_id,
      content: req.body?.content,
      contentType: req.body?.content_type,
      parentId: req.body?.parent_id,
      metadata: req.body?.metadata,
      access: req.access,
      isSuperAdmin: !!req.member.is_super_admin,
    });
    // Broadcast HTTP-sent messages to the channel room too, so connected clients see them
    // in realtime (the socket send path emits identically), then fan out @mentions.
    const io = req.app.get('io');
    if (io) {
      io.to(`staff_chat_${message.channel_id}`).emit('staff-message-created', message);
      notifyStaffMentions(io, { message, senderId: req.member.member_id, senderName: message.sender?.name }).catch(() => {});
    }
    return res.status(201).json({ successful: true, message });
  } catch (err) {
    return fail(res, err, '[staff-chat] send error:');
  }
});

// GET /channels/:id/messages/:mid/thread — a message + its replies
router.get('/channels/:id/messages/:mid/thread', async (req, res) => {
  try {
    const result = await chat.getThreadMessages({
      channelId: req.params.id, parentId: req.params.mid, memberId: req.member.member_id,
      access: req.access, isSuperAdmin: !!req.member.is_super_admin,
    });
    return res.status(200).json({ successful: true, ...result });
  } catch (err) {
    return fail(res, err, '[staff-chat] thread error:');
  }
});

// POST /channels/:id/messages/:mid/pin — pin/unpin (leadership / channel admins)
router.post('/channels/:id/messages/:mid/pin', async (req, res) => {
  try {
    const result = await chat.setPinned({
      channelId: req.params.id, messageId: req.params.mid, pinned: req.body?.pinned !== false,
      actorId: req.member.member_id, access: req.access, isSuperAdmin: !!req.member.is_super_admin,
    });
    const io = req.app.get('io');
    if (io) io.to(`staff_chat_${result.channel_id}`).emit('staff-pins-changed', { channel_id: result.channel_id });
    return res.status(200).json({ successful: true, ...result });
  } catch (err) {
    return fail(res, err, '[staff-chat] pin error:');
  }
});

// GET /channels/:id/pins — pinned messages
router.get('/channels/:id/pins', async (req, res) => {
  try {
    const result = await chat.listPinned({
      channelId: req.params.id, memberId: req.member.member_id,
      access: req.access, isSuperAdmin: !!req.member.is_super_admin,
    });
    return res.status(200).json({ successful: true, ...result });
  } catch (err) {
    return fail(res, err, '[staff-chat] pins error:');
  }
});

// POST /channels/:id/read
router.post('/channels/:id/read', async (req, res) => {
  try {
    const result = await chat.markRead({
      channelId: req.params.id,
      memberId: req.member.member_id,
      access: req.access,
      isSuperAdmin: !!req.member.is_super_admin,
    });
    return res.status(200).json({ successful: true, ...result });
  } catch (err) {
    return fail(res, err, '[staff-chat] mark-read error:');
  }
});

// GET /channels/:id/members
router.get('/channels/:id/members', async (req, res) => {
  try {
    const members = await chat.listChannelMembers({
      channelId: req.params.id,
      memberId: req.member.member_id,
      access: req.access,
      isSuperAdmin: !!req.member.is_super_admin,
    });
    return res.status(200).json({ successful: true, members });
  } catch (err) {
    return fail(res, err, '[staff-chat] members error:');
  }
});

// POST /channels/:id/members — invite (allowed_roles enforced in the service)
router.post('/channels/:id/members', async (req, res) => {
  try {
    const result = await chat.inviteMember({
      channelId: req.params.id,
      actorId: req.member.member_id,
      targetMemberId: req.body?.member_id,
    });
    return res.status(201).json({ successful: true, ...result });
  } catch (err) {
    return fail(res, err, '[staff-chat] invite error:');
  }
});

// GET /directory — approved staff the caller can DM / invite
router.get('/directory', async (req, res) => {
  try {
    const members = await prisma.board_member.findMany({
      where: { status: 'approved' },
      select: { member_id: true, name: true, email: true, avatar_url: true, role_id: true },
      orderBy: { name: 'asc' },
    });
    const roleIds = [...new Set(members.map((m) => m.role_id).filter(Boolean))];
    const roles = await prisma.board_role.findMany({
      where: { role_id: { in: roleIds.length ? roleIds : [-1] } },
      select: { role_id: true, key: true, name: true },
    });
    const byId = new Map(roles.map((r) => [r.role_id, r]));
    const directory = members
      .filter((m) => m.member_id !== req.member.member_id)
      .map((m) => ({
        member_id: m.member_id,
        name: m.name,
        email: m.email,
        avatar_url: m.avatar_url ?? null,
        role: m.role_id ? byId.get(m.role_id) || null : null,
      }));
    return res.status(200).json({ successful: true, directory });
  } catch (err) {
    return fail(res, err, '[staff-chat] directory error:');
  }
});

export default router;
