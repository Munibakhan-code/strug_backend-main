// sockets/staff-chat-socket.js
//
// Realtime handlers for internal staff messaging — the board-side mirror of chat-socket.js.
// Registered ONLY for board (staff) sockets (socket.member set); app-user sockets never get
// these, and these never touch user identity. Rooms are `staff_chat_<channelId>`.
//
// Access is re-resolved from the DB per event (resolveMemberAccess) because a socket only
// carries JWT claims, not the RBAC map — and because a member's role/access can change while
// they're connected. Cheap for staff volumes; keeps enforcement honest.

import {
  createMessage,
  loadAccessibleChannel,
  markRead,
  resolveMemberAccess,
} from '../services/staff-chat-service.js';
import { notifyStaffMentions } from '../services/staff-notify-service.js';

const staffRoom = (channelId) => `staff_chat_${channelId}`;

function respond(socket, ack, event, payload) {
  if (typeof ack === 'function') ack(payload);
  else socket.emit(event, payload);
}

export function registerStaffChatHandlers(io, socket) {
  const memberId = socket.member?.member_id;
  if (!memberId) return; // defensive: only board sockets reach here

  socket.on('join_staff_chat', async (data, ack) => {
    try {
      const channelId = Number(data?.channel_id);
      const { access, isSuperAdmin } = await resolveMemberAccess(memberId);
      await loadAccessibleChannel(channelId, memberId, access, isSuperAdmin);
      socket.join(staffRoom(channelId));
      respond(socket, ack, 'staff-chat-joined', { ok: true, channel_id: channelId });
    } catch (error) {
      respond(socket, ack, 'staff-chat-error', {
        ok: false,
        message: error.statusCode ? error.message : 'Failed to join channel',
      });
    }
  });

  socket.on('leave_staff_chat', (data, ack) => {
    const channelId = Number(data?.channel_id);
    if (!Number.isInteger(channelId) || channelId <= 0) {
      return respond(socket, ack, 'staff-chat-error', { ok: false, message: 'channel_id must be a positive integer' });
    }
    socket.leave(staffRoom(channelId));
    respond(socket, ack, 'staff-chat-left', { ok: true, channel_id: channelId });
  });

  socket.on('send_staff_message', async (data, ack) => {
    try {
      const { access, isSuperAdmin } = await resolveMemberAccess(memberId);
      const message = await createMessage({
        channelId: data?.channel_id,
        senderId: memberId,
        content: data?.content,
        contentType: data?.content_type,
        parentId: data?.parent_id,
        metadata: data?.metadata,
        access,
        isSuperAdmin,
      });
      io.to(staffRoom(message.channel_id)).emit('staff-message-created', message);
      notifyStaffMentions(io, { message, senderId: memberId, senderName: message.sender?.name }).catch(() => {});
      respond(socket, ack, 'staff-message-created', { ok: true, message });
    } catch (error) {
      respond(socket, ack, 'staff-chat-error', {
        ok: false,
        message: error.statusCode ? error.message : 'Failed to send message',
      });
    }
  });

  socket.on('staff_typing_start', (data) => {
    const channelId = Number(data?.channel_id);
    if (Number.isInteger(channelId) && channelId > 0) {
      socket.to(staffRoom(channelId)).emit('staff-typing', { channel_id: channelId, member_id: memberId, typing: true });
    }
  });

  socket.on('staff_typing_stop', (data) => {
    const channelId = Number(data?.channel_id);
    if (Number.isInteger(channelId) && channelId > 0) {
      socket.to(staffRoom(channelId)).emit('staff-typing', { channel_id: channelId, member_id: memberId, typing: false });
    }
  });

  socket.on('mark_staff_read', async (data, ack) => {
    try {
      const { access, isSuperAdmin } = await resolveMemberAccess(memberId);
      const result = await markRead({ channelId: data?.channel_id, memberId, access, isSuperAdmin });
      io.to(staffRoom(result.channel_id)).emit('staff-messages-read', { ...result, member_id: memberId });
      respond(socket, ack, 'staff-messages-read', { ok: true, ...result });
    } catch (error) {
      respond(socket, ack, 'staff-chat-error', {
        ok: false,
        message: error.statusCode ? error.message : 'Failed to mark read',
      });
    }
  });
}
