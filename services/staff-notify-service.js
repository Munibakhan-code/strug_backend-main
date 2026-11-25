// services/staff-notify-service.js
//
// @mention fan-out for internal staff messaging. A message's metadata.mentions is an array of
// board_member ids; each mentioned member (except the sender) gets a board_notification row
// (type 'mention', carrying channel_id + message_id) and a realtime `board-notification` emit
// to their board-member-<id> room. Mirrors chat-notification-service.js, but on board identity.
//
// Transport-agnostic callers pass `io` (the socket path has it; the REST path reads it from
// req.app.get('io')). Best-effort: a notification failure must never fail the send.

import prisma from '../utils/prisma-client.js';

export async function notifyStaffMentions(io, { message, senderId, senderName }) {
  const raw = Array.isArray(message?.metadata?.mentions) ? message.metadata.mentions : [];
  const sender = Number(senderId);
  const targets = [
    ...new Set(raw.map(Number).filter((id) => Number.isInteger(id) && id > 0 && id !== sender)),
  ];
  if (!targets.length) return;

  const channel = await prisma.staff_channel.findUnique({
    where: { channel_id: message.channel_id },
    select: { name: true, kind: true },
  });
  const where = channel?.kind === 'dm' ? 'a direct message' : channel?.name ? `#${channel.name}` : 'a channel';
  const body = `${senderName || 'Someone'} mentioned you in ${where}`.slice(0, 500);

  await Promise.all(
    targets.map(async (memberId) => {
      const notif = await prisma.board_notification.create({
        data: { member_id: memberId, channel_id: message.channel_id, message_id: message.message_id, type: 'mention', body },
      });
      io?.to(`board-member-${memberId}`).emit('board-notification', notif);
    })
  );
}
