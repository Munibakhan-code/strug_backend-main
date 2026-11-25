import {
  chatRoomName,
  createChatMessage,
  ensureChannelParticipant,
  markChannelMessagesRead,
} from '../services/chat-service.js';
import { notifyChatRecipients } from '../services/chat-notification-service.js';
import { notifyJobApplicationChatMessage } from '../services/job-chat-email-service.js';

function respond(socket, ack, event, payload) {
  if (typeof ack === 'function') ack(payload);
  else socket.emit(event, payload);
}

export function registerChatSocketHandlers(io, socket) {
  socket.on('join_chat', async (data, ack) => {
    try {
      const channelId = Number(data?.channel_id);
      await ensureChannelParticipant(channelId, socket.user.user_id);
      socket.join(chatRoomName(channelId));
      respond(socket, ack, 'chat-joined', {
        ok: true,
        channel_id: channelId,
        room: chatRoomName(channelId),
      });
    } catch (error) {
      respond(socket, ack, 'chat-error', {
        ok: false,
        message: error.message || 'Failed to join chat room',
      });
    }
  });

  socket.on('leave_chat', (data, ack) => {
    const channelId = Number(data?.channel_id);
    if (!Number.isInteger(channelId) || channelId <= 0) {
      respond(socket, ack, 'chat-error', {
        ok: false,
        message: 'channel_id must be a positive integer',
      });
      return;
    }
    socket.leave(chatRoomName(channelId));
    respond(socket, ack, 'chat-left', { ok: true, channel_id: channelId });
  });

  socket.on('send_chat_message', async (data, ack) => {
    try {
      const message = await createChatMessage({
        channelId: data?.channel_id,
        senderId: socket.user.user_id,
        content: data?.content,
        contentType: data?.content_type,
        platformTypeId: data?.platform_type_id,
        clientMsgId: data?.client_msg_id,
        metadata: data?.metadata ?? null,
      });
      io.to(chatRoomName(message.channel_id)).emit('message-created', message);
      await notifyChatRecipients(io, {
        channelId: message.channel_id,
        senderId: socket.user.user_id,
        messageId: message.message_id,
        content: message.content,
      });
      notifyJobApplicationChatMessage({
        channelId: message.channel_id,
        senderId: socket.user.user_id,
        messageId: message.message_id,
        content: message.content,
      }).catch(() => {});
      respond(socket, ack, 'message-created', { ok: true, message });
    } catch (error) {
      respond(socket, ack, 'chat-error', {
        ok: false,
        message: error.message || 'Failed to send chat message',
      });
    }
  });

  socket.on('typing_start', async (data) => {
    try {
      const channelId = Number(data?.channel_id);
      await ensureChannelParticipant(channelId, socket.user.user_id);
      socket.to(chatRoomName(channelId)).emit('typing-started', {
        channel_id: channelId,
        user_id: socket.user.user_id,
      });
    } catch {
      socket.emit('chat-error', { ok: false, message: 'Failed to start typing indicator' });
    }
  });

  socket.on('typing_stop', async (data) => {
    try {
      const channelId = Number(data?.channel_id);
      await ensureChannelParticipant(channelId, socket.user.user_id);
      socket.to(chatRoomName(channelId)).emit('typing-stopped', {
        channel_id: channelId,
        user_id: socket.user.user_id,
      });
    } catch {
      socket.emit('chat-error', { ok: false, message: 'Failed to stop typing indicator' });
    }
  });

  socket.on('mark_messages_read', async (data, ack) => {
    try {
      const result = await markChannelMessagesRead({
        channelId: data?.channel_id,
        userId: socket.user.user_id,
      });
      io.to(chatRoomName(result.channel_id)).emit('messages-read', result);
      respond(socket, ack, 'messages-read', { ok: true, ...result });
    } catch (error) {
      respond(socket, ack, 'chat-error', {
        ok: false,
        message: error.message || 'Failed to mark messages read',
      });
    }
  });
}
