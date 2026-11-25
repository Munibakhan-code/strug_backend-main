import prisma from '../utils/prisma-client.js';
import {
  chatRoomName,
  createChatMessage,
  ensureChannelParticipant,
  sendChatError,
} from './chat-service.js';
import { notifyChatRecipients } from './chat-notification-service.js';

export const SCHEDULED_CHAT_MIN_LEAD_MS = 30_000;
/** After this long in `sending`, a row is treated as abandoned and returned to `pending`. */
export const SCHEDULED_CHAT_SENDING_STALE_MS = 2 * 60_000;
export const SCHEDULED_CHAT_STATUSES = Object.freeze({
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

function chatHttpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function toPositiveInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw chatHttpError(`${field} must be a positive integer`);
  return n;
}

function requireText(value, field = 'content') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw chatHttpError(`${field} is required`);
  return text;
}

/**
 * @param {unknown} scheduledFor
 * @param {number} [nowMs]
 * @param {number} [minLeadMs]
 */
export function parseScheduledFor(scheduledFor, nowMs = Date.now(), minLeadMs = SCHEDULED_CHAT_MIN_LEAD_MS) {
  const at = scheduledFor instanceof Date ? scheduledFor.getTime() : new Date(scheduledFor).getTime();
  if (!Number.isFinite(at)) throw chatHttpError('scheduled_for must be a valid date');
  if (at < nowMs + minLeadMs) {
    throw chatHttpError(`scheduled_for must be at least ${Math.round(minLeadMs / 1000)} seconds from now`);
  }
  return new Date(at);
}

function mapRow(row) {
  if (!row) return null;
  return {
    scheduled_message_id: row.scheduled_message_id,
    channel_id: row.channel_id,
    sender_id: row.sender_id,
    content: row.content,
    content_type: row.content_type,
    metadata: row.metadata,
    client_msg_id: row.client_msg_id,
    scheduled_for: row.scheduled_for,
    status: row.status,
    created_message_id: row.created_message_id,
    error_message: row.error_message,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createScheduledChatMessage({
  channelId,
  senderId,
  content,
  contentType = 'text',
  metadata = null,
  clientMsgId = null,
  scheduledFor,
}) {
  const safeChannelId = toPositiveInt(channelId, 'channel_id');
  const safeSenderId = toPositiveInt(senderId, 'sender_id');
  const safeContent = requireText(content, 'content');
  const safeContentType = String(contentType || 'text').slice(0, 255);
  if (safeContentType !== 'text') {
    throw chatHttpError('Only text scheduled messages are supported');
  }
  const when = parseScheduledFor(scheduledFor);
  const safeClientMsgId =
    clientMsgId == null || clientMsgId === '' ? null : String(clientMsgId).slice(0, 100);
  const safeMetadata =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null;

  await ensureChannelParticipant(safeChannelId, safeSenderId);

  if (safeClientMsgId) {
    const existing = await prisma.scheduled_chat_message.findFirst({
      where: {
        sender_id: safeSenderId,
        client_msg_id: safeClientMsgId,
        status: SCHEDULED_CHAT_STATUSES.PENDING,
      },
    });
    if (existing) return mapRow(existing);
  }

  const row = await prisma.scheduled_chat_message.create({
    data: {
      channel_id: safeChannelId,
      sender_id: safeSenderId,
      content: safeContent,
      content_type: safeContentType,
      metadata: safeMetadata,
      client_msg_id: safeClientMsgId,
      scheduled_for: when,
      status: SCHEDULED_CHAT_STATUSES.PENDING,
    },
  });
  return mapRow(row);
}

export async function listPendingScheduledChatMessages({
  senderId,
  channelId = null,
  take = 100,
  skip = 0,
}) {
  const safeSenderId = toPositiveInt(senderId, 'sender_id');
  const where = {
    sender_id: safeSenderId,
    status: SCHEDULED_CHAT_STATUSES.PENDING,
  };
  if (channelId != null && channelId !== '') {
    where.channel_id = toPositiveInt(channelId, 'channel_id');
    await ensureChannelParticipant(where.channel_id, safeSenderId);
  }
  const limit = Number.isFinite(take) && take > 0 ? Math.min(Math.floor(take), 200) : 100;
  const offset = Number.isFinite(skip) && skip > 0 ? Math.floor(skip) : 0;
  const rows = await prisma.scheduled_chat_message.findMany({
    where,
    orderBy: { scheduled_for: 'asc' },
    take: limit,
    skip: offset,
  });
  return rows.map(mapRow);
}

export async function updateScheduledChatMessage({
  scheduledMessageId,
  senderId,
  content,
  scheduledFor,
}) {
  const safeId = toPositiveInt(scheduledMessageId, 'scheduled_message_id');
  const safeSenderId = toPositiveInt(senderId, 'sender_id');

  const existing = await prisma.scheduled_chat_message.findUnique({
    where: { scheduled_message_id: safeId },
  });
  if (!existing) throw chatHttpError('Scheduled message not found', 404);
  if (Number(existing.sender_id) !== safeSenderId) {
    throw chatHttpError('Not allowed to edit this scheduled message', 403);
  }
  if (existing.status !== SCHEDULED_CHAT_STATUSES.PENDING) {
    throw chatHttpError('Only pending scheduled messages can be edited', 400);
  }

  const data = {};
  if (content !== undefined) data.content = requireText(content, 'content');
  if (scheduledFor !== undefined) data.scheduled_for = parseScheduledFor(scheduledFor);

  if (!Object.keys(data).length) throw chatHttpError('Nothing to update');

  const row = await prisma.scheduled_chat_message.update({
    where: { scheduled_message_id: safeId },
    data,
  });
  return mapRow(row);
}

export async function cancelScheduledChatMessage({ scheduledMessageId, senderId }) {
  const safeId = toPositiveInt(scheduledMessageId, 'scheduled_message_id');
  const safeSenderId = toPositiveInt(senderId, 'sender_id');

  const existing = await prisma.scheduled_chat_message.findUnique({
    where: { scheduled_message_id: safeId },
  });
  if (!existing) throw chatHttpError('Scheduled message not found', 404);
  if (Number(existing.sender_id) !== safeSenderId) {
    throw chatHttpError('Not allowed to cancel this scheduled message', 403);
  }
  if (existing.status !== SCHEDULED_CHAT_STATUSES.PENDING) {
    throw chatHttpError('Only pending scheduled messages can be cancelled', 400);
  }

  // Conditional write so a concurrent flush that already claimed/sent cannot be overwritten.
  const cancelled = await prisma.scheduled_chat_message.updateMany({
    where: {
      scheduled_message_id: safeId,
      sender_id: safeSenderId,
      status: SCHEDULED_CHAT_STATUSES.PENDING,
    },
    data: { status: SCHEDULED_CHAT_STATUSES.CANCELLED },
  });
  if (cancelled.count !== 1) {
    throw chatHttpError('Only pending scheduled messages can be cancelled', 400);
  }

  const row = await prisma.scheduled_chat_message.findUnique({
    where: { scheduled_message_id: safeId },
  });
  return mapRow(row);
}

/**
 * Return abandoned `sending` rows to `pending` so a crashed flush can retry.
 * @param {Date} [now]
 * @param {number} [staleMs]
 * @returns {Promise<number>} rows reclaimed
 */
export async function reclaimStaleSendingScheduledChatMessages(
  now = new Date(),
  staleMs = SCHEDULED_CHAT_SENDING_STALE_MS,
) {
  const cutoff = new Date(now.getTime() - staleMs);
  const result = await prisma.scheduled_chat_message.updateMany({
    where: {
      status: SCHEDULED_CHAT_STATUSES.SENDING,
      OR: [
        { claimed_at: { lt: cutoff } },
        { claimed_at: null },
      ],
    },
    data: {
      status: SCHEDULED_CHAT_STATUSES.PENDING,
      claimed_at: null,
    },
  });
  return result.count;
}

/**
 * Claim and deliver due pending rows. Safe across replicas via status claim.
 * @param {import('socket.io').Server | null | undefined} io
 * @param {{ now?: Date, limit?: number, staleMs?: number }} [opts]
 */
export async function flushDueScheduledChatMessages(io, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 100) : 50;
  const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0
    ? opts.staleMs
    : SCHEDULED_CHAT_SENDING_STALE_MS;

  await reclaimStaleSendingScheduledChatMessages(now, staleMs);

  const due = await prisma.scheduled_chat_message.findMany({
    where: {
      status: SCHEDULED_CHAT_STATUSES.PENDING,
      scheduled_for: { lte: now },
    },
    orderBy: { scheduled_for: 'asc' },
    take: limit,
  });

  let sent = 0;
  let failed = 0;

  for (const row of due) {
    // Re-check scheduled_for so a PATCH that moved the time into the future cannot send.
    const claim = await prisma.scheduled_chat_message.updateMany({
      where: {
        scheduled_message_id: row.scheduled_message_id,
        status: SCHEDULED_CHAT_STATUSES.PENDING,
        scheduled_for: { lte: now },
      },
      data: {
        status: SCHEDULED_CHAT_STATUSES.SENDING,
        claimed_at: new Date(),
      },
    });
    if (claim.count !== 1) continue;

    try {
      const message = await createChatMessage({
        channelId: row.channel_id,
        senderId: row.sender_id,
        content: row.content,
        contentType: row.content_type || 'text',
        metadata: row.metadata,
        clientMsgId: row.client_msg_id,
      });

      io?.to(chatRoomName(message.channel_id)).emit('message-created', message);
      await notifyChatRecipients(io, {
        channelId: message.channel_id,
        senderId: row.sender_id,
        messageId: message.message_id,
        content: message.content,
      }).catch(() => {});

      await prisma.scheduled_chat_message.update({
        where: { scheduled_message_id: row.scheduled_message_id },
        data: {
          status: SCHEDULED_CHAT_STATUSES.SENT,
          created_message_id: message.message_id,
          sent_at: new Date(),
          error_message: null,
        },
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      await prisma.scheduled_chat_message.update({
        where: { scheduled_message_id: row.scheduled_message_id },
        data: {
          status: SCHEDULED_CHAT_STATUSES.FAILED,
          error_message: String(err?.message || 'send failed').slice(0, 500),
        },
      }).catch(() => {});
    }
  }

  return { due: due.length, sent, failed };
}

export { sendChatError, mapRow as mapScheduledChatMessage };
