import prisma from './prisma-client.js';

/**
 * Attach channel_id (and preview content) to CHAT_MESSAGE notifications in one query.
 */
export async function enrichChatNotifications(notifications) {
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return notifications;
  }

  const messageIds = [
    ...new Set(
      notifications
        .filter((n) => n.type === 'CHAT_MESSAGE' && n.target_id != null)
        .map((n) => Number(n.target_id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];

  if (messageIds.length === 0) {
    return notifications;
  }

  const messages = await prisma.chat_messages.findMany({
    where: { message_id: { in: messageIds } },
    select: {
      message_id: true,
      channel_id: true,
      content: true,
      deleted_at: true,
    },
  });

  const byMessageId = new Map(messages.map((m) => [m.message_id, m]));

  return notifications.map((n) => {
    if (n.type !== 'CHAT_MESSAGE' || n.target_id == null) return n;
    const msg = byMessageId.get(Number(n.target_id));
    if (!msg) return n;
    return {
      ...n,
      channel_id: msg.channel_id ?? n.channel_id ?? null,
      message:
        n.message ??
        (msg.deleted_at ? 'Message deleted' : (msg.content ?? '')),
    };
  });
}
