import prisma from '../utils/prisma-client.js';
import { areUsersBlockedOnPlatform, blockedGraphForUser } from '../utils/platform-blocks.js';
import { normalizeDmSourceVertical, shouldApplyDmSourceTag } from '../utils/dm-source-vertical.js';
import { mergeMessageOriginMetadata } from '../utils/chat-message-origin.js';

export const chatRoomName = (channelId) => `chat_channel_${channelId}`;

// Phase 2 of the per-vertical profile work: a chat tied to a vertical context (a food
// order, a ride, a service/rental job) should display each participant's VERTICAL
// identity, not their main social profile — "messages within those categories reflect
// the category profile". Map the channel's context_type to a vertical; support/DM
// channels have no vertical and keep the main profile.
const CONTEXT_VERTICAL = {
  rideshare: 'rideshare',
  food: 'food',
  services: 'services',
  ondemand: 'services',
  shop: 'hosting',
  marketplace: 'hosting',
  jobs: 'jobs',
  medical: 'medical',
  decor: 'decor',
  automotive: 'automotive',
  social: 'social',
  videos: 'videos',
  realestate: 'realestate',
  hotel: 'hotel',
  venues: 'venues',
  tempstay: 'tempstay',
  wedding: 'wedding',
  equipment: 'equipment',
  experiences: 'experiences',
  preconstruct: 'preconstruct',
  reservations: 'reservations',
  rental: 'hosting',
};

export const verticalForContextType = (contextType) => CONTEXT_VERTICAL[contextType] || null;

// Resolve a user's display identity for a chat. When `vertical` is set, the user's
// vertical_profile for that vertical wins per-field, falling back to the main profile
// (inherit-from-main) so an un-customized vertical still shows a sensible name/photo.
// social_profiles is a to-one relation (social_profile?) — Prisma returns an object or null,
// not an array. Tolerate both shapes so identity (handle/avatar) resolves regardless of how
// the relation was selected (some includes historically treated it as a list).
function firstSocialProfile(user) {
  const sp = user?.social_profiles;
  return Array.isArray(sp) ? sp[0] : sp;
}

export function resolveChatIdentity(user, vertical) {
  const sp = firstSocialProfile(user);
  const base = {
    // Prefer the platform display name the user set on their social profile over
    // user.name — for Google sign-ups user.name holds the real Google profile name,
    // which must NOT override the name they chose on Strug (bug report #92).
    name: sp?.display_name || user?.username || user?.name || 'User',
    handle: sp?.handle || user?.username || null,
    profile_pic_url: sp?.profile_pic_url || null,
  };
  if (!vertical) return base;
  const vp = (user?.vertical_profiles || []).find((v) => v.vertical === vertical);
  if (!vp) return base;
  return {
    name: vp.display_name || base.name,
    handle: vp.handle || base.handle,
    profile_pic_url: vp.profile_pic_url || base.profile_pic_url,
  };
}

const ALLOWED_MESSAGE_CONTENT_TYPES = new Set([
  'text',
  'image',
  'video',
  'audio',
  'file',
  'location',
  'system',
]);

const MAX_TEXT_MESSAGE_LENGTH = 5000;

const messageInclude = {
  user: {
    select: {
      user_id: true,
      name: true,
      username: true,
      social_profiles: {
        select: {
          handle: true,
          display_name: true,
          profile_pic_url: true,
        },
      },
      vertical_profiles: {
        select: { vertical: true, handle: true, display_name: true, profile_pic_url: true },
      },
    },
  },
  chat_channel: true,
  platform_type: true,
};

// Normalize a message's sender identity for display. Always prefers the platform
// display name over the raw user.name — for Google sign-ups user.name holds the real
// Google profile name, which must not show in chat (bug #92). In a vertical-context
// channel (food/ride/service/rental) the sender's vertical profile wins per-field
// (Phase 2 of bug #3).
export function decorateMessageIdentity(message) {
  if (!message?.user) return message;
  const vertical = verticalForContextType(message?.chat_channel?.context_type);
  const id = resolveChatIdentity(message.user, vertical);
  message.user.name = id.name;
  if (vertical) {
    const sp = firstSocialProfile(message.user) || {};
    message.user.social_profiles = [{ ...sp, handle: id.handle, profile_pic_url: id.profile_pic_url }];
  }
  return message;
}

function toPositiveInt(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${fieldName} must be a positive integer`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function toOptionalPositiveInt(value, fieldName) {
  if (value == null || value === '') return null;
  return toPositiveInt(value, fieldName);
}

function toPageSize(value, defaultValue = 30) {
  if (value == null || value === '') return defaultValue;
  const parsed = toPositiveInt(value, 'limit');
  return Math.min(parsed, 100);
}

function requireText(value, fieldName) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    const error = new Error(`${fieldName} is required`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function optionalText(value, fieldName) {
  if (value == null || value === '') return null;
  return requireText(value, fieldName);
}

function toMessageContentType(value) {
  const contentType = typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : 'text';

  if (!ALLOWED_MESSAGE_CONTENT_TYPES.has(contentType)) {
    const error = new Error(
      `content_type must be one of: ${[...ALLOWED_MESSAGE_CONTENT_TYPES].join(', ')}`,
    );
    error.statusCode = 400;
    throw error;
  }

  return contentType;
}

function validateMessageContent(content, contentType) {
  if (contentType === 'text' && content.length > MAX_TEXT_MESSAGE_LENGTH) {
    const error = new Error(`content must be ${MAX_TEXT_MESSAGE_LENGTH} characters or fewer`);
    error.statusCode = 400;
    throw error;
  }

  return content;
}

export function sendChatError(res, error, fallbackMessage = 'Chat request failed') {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message || fallbackMessage });
}

export async function ensureChannelParticipant(channelId, userId) {
  const safeChannelId = toPositiveInt(channelId, 'channel_id');
  const safeUserId = toPositiveInt(userId, 'user_id');
  const participant = await prisma.chat_participants.findFirst({
    where: {
      channel_id: safeChannelId,
      user_id: safeUserId,
    },
    select: {
      chat_participant_id: true,
      channel_id: true,
      user_id: true,
      role: true,
      muted: true,
      last_read_message_id: true,
    },
  });

  if (!participant) {
    const error = new Error('User is not a participant in this channel');
    error.statusCode = 403;
    throw error;
  }

  return participant;
}

async function assertChannelReadable(channelId, userId) {
  const safeChannelId = toPositiveInt(channelId, 'channel_id');
  const safeUserId = toPositiveInt(userId, 'user_id');
  const channel = await prisma.chat_channel.findUnique({
    where: { channel_id: safeChannelId },
    select: {
      status: true,
      type: true,
      chat_participants: {
        where: { user_id: { not: safeUserId }, left_at: null },
        select: { user_id: true },
      },
    },
  });
  if (!channel || channel.status === 'blocked') {
    const error = new Error('This conversation is no longer available');
    error.statusCode = 403;
    throw error;
  }
  if (channel.type !== 'dm') return;
  const blockedGraph = await blockedGraphForUser(safeUserId);
  const blockedUserIds = new Set(blockedGraph.userIds.map(Number));
  if ((channel.chat_participants || []).some((participant) => blockedUserIds.has(Number(participant.user_id)))) {
    const error = new Error('This conversation is no longer available');
    error.statusCode = 403;
    throw error;
  }
}

export async function ensureChannelManager(channelId, userId) {
  const participant = await ensureChannelParticipant(channelId, userId);
  if (!['owner', 'admin'].includes(participant.role)) {
    const error = new Error('Only channel owners or admins can manage this channel');
    error.statusCode = 403;
    throw error;
  }
  return participant;
}

export async function getChannelMessages({ channelId, userId, limit, beforeMessageId }) {
  const safeChannelId = toPositiveInt(channelId, 'channel_id');
  const safeUserId = toPositiveInt(userId, 'user_id');
  const safeLimit = toPageSize(limit);
  const safeBeforeMessageId = toOptionalPositiveInt(beforeMessageId, 'before_message_id');

  await ensureChannelParticipant(safeChannelId, safeUserId);
  await assertChannelReadable(safeChannelId, safeUserId);

  const messages = await prisma.chat_messages.findMany({
    where: {
      channel_id: safeChannelId,
      deleted_at: null,
      ...(safeBeforeMessageId ? { message_id: { lt: safeBeforeMessageId } } : {}),
    },
    orderBy: { message_id: 'desc' },
    take: safeLimit + 1,
    include: messageInclude,
  });

  const hasMore = messages.length > safeLimit;
  const page = messages.slice(0, safeLimit).reverse().map(decorateMessageIdentity);

  return {
    messages: page,
    pagination: {
      limit: safeLimit,
      has_more: hasMore,
      next_before_message_id: hasMore ? page[0]?.message_id ?? null : null,
    },
  };
}

export async function markChannelMessagesRead({ channelId, userId }) {
  const safeChannelId = toPositiveInt(channelId, 'channel_id');
  const safeUserId = toPositiveInt(userId, 'user_id');

  const latestMessage = await prisma.chat_messages.findFirst({
    where: { channel_id: safeChannelId, deleted_at: null },
    orderBy: { message_id: 'desc' },
    select: { message_id: true },
  });

  await ensureChannelParticipant(safeChannelId, safeUserId);
  await assertChannelReadable(safeChannelId, safeUserId);

  const [result] = await prisma.$transaction([
    prisma.chat_messages.updateMany({
      where: {
        channel_id: safeChannelId,
        deleted_at: null,
        OR: [{ is_read: false }, { is_read: null }],
        sender_id: { not: safeUserId },
      },
      data: { is_read: true },
    }),
    prisma.chat_participants.updateMany({
      where: { channel_id: safeChannelId, user_id: safeUserId },
      data: { last_read_message_id: latestMessage?.message_id ?? null },
    }),
  ]);

  return {
    channel_id: safeChannelId,
    user_id: safeUserId,
    read_count: result.count,
    last_read_message_id: latestMessage?.message_id ?? null,
  };
}

export async function getChatMessage({ messageId, userId }) {
  const safeMessageId = toPositiveInt(messageId, 'message_id');
  const safeUserId = toPositiveInt(userId, 'user_id');
  const message = await prisma.chat_messages.findUnique({
    where: { message_id: safeMessageId },
    include: messageInclude,
  });

  if (!message) {
    const error = new Error('Message not found');
    error.statusCode = 404;
    throw error;
  }

  if (message.deleted_at) {
    const error = new Error('Message not found');
    error.statusCode = 404;
    throw error;
  }

  await ensureChannelParticipant(message.channel_id, safeUserId);
  await assertChannelReadable(message.channel_id, safeUserId);
  return decorateMessageIdentity(message);
}

export async function searchChannelMessages({ channelId, userId, query, limit, beforeMessageId }) {
  const safeChannelId = toPositiveInt(channelId, 'channel_id');
  const safeUserId = toPositiveInt(userId, 'user_id');
  const safeQuery = requireText(query, 'query');
  const safeLimit = toPageSize(limit, 20);
  const safeBeforeMessageId = toOptionalPositiveInt(beforeMessageId, 'before_message_id');

  await ensureChannelParticipant(safeChannelId, safeUserId);
  await assertChannelReadable(safeChannelId, safeUserId);

  const messages = await prisma.chat_messages.findMany({
    where: {
      channel_id: safeChannelId,
      deleted_at: null,
      content: { contains: safeQuery, mode: 'insensitive' },
      ...(safeBeforeMessageId ? { message_id: { lt: safeBeforeMessageId } } : {}),
    },
    orderBy: { message_id: 'desc' },
    take: safeLimit + 1,
    include: messageInclude,
  });

  const hasMore = messages.length > safeLimit;
  const page = messages.slice(0, safeLimit).map(decorateMessageIdentity);
  return {
    messages: page,
    pagination: {
      limit: safeLimit,
      has_more: hasMore,
      next_before_message_id: hasMore ? page[page.length - 1]?.message_id ?? null : null,
    },
  };
}

export async function createChatMessage({
  channelId,
  senderId,
  content,
  contentType = 'text',
  platformTypeId = null,
  metadata = null,
  clientMsgId = null,
}) {
  const safeChannelId = toPositiveInt(channelId, 'channel_id');
  const safeSenderId = toPositiveInt(senderId, 'sender_id');
  const safeContentType = toMessageContentType(contentType);
  const safeContent = validateMessageContent(requireText(content, 'content'), safeContentType);
  const safePlatformTypeId = toOptionalPositiveInt(platformTypeId, 'platform_type_id');
  const safeClientMsgId =
    clientMsgId == null || clientMsgId === '' ? null : String(clientMsgId).slice(0, 100);

  await ensureChannelParticipant(safeChannelId, safeSenderId);
  const [channel, blockedGraph] = await Promise.all([
    prisma.chat_channel.findUnique({
      where: { channel_id: safeChannelId },
      select: {
        status: true,
        type: true,
        context_type: true,
        context_id: true,
        chat_participants: {
          where: { user_id: { not: safeSenderId }, left_at: null },
          select: { user_id: true },
        },
      },
    }),
    blockedGraphForUser(safeSenderId),
  ]);
  if (!channel || channel.status === 'blocked') {
    const error = new Error('This conversation is no longer available');
    error.statusCode = 403;
    throw error;
  }
  const blockedUserIds = new Set(blockedGraph.userIds.map(Number));
  if ((channel.chat_participants || []).some((participant) => blockedUserIds.has(Number(participant.user_id)))) {
    const error = new Error('This conversation is no longer available');
    error.statusCode = 403;
    throw error;
  }

  // Idempotency (duplicate-message fix #62/#77): a client retry carrying the same client_msg_id
  // — e.g. the socket ack times out after the message was already delivered and the UI falls
  // back to REST — must NOT insert a second row. Return the original. The client_msg_id is
  // stashed in metadata.__client_msg_id so this needs no schema change. The client also
  // reconciles its optimistic row by client_msg_id, so the UI never double-renders either.
  if (safeClientMsgId) {
    const existing = await prisma.chat_messages.findFirst({
      where: {
        channel_id: safeChannelId,
        sender_id: safeSenderId,
        // Retries arrive within seconds; bound the lookup to a recent window so it rides the
        // (sender_id, sent_at) index instead of scanning a prolific sender's whole history.
        sent_at: { gt: new Date(Date.now() - 60 * 60 * 1000) },
        metadata: { path: ['__client_msg_id'], equals: safeClientMsgId },
      },
      include: messageInclude,
      orderBy: { message_id: 'desc' },
    });
    if (existing) {
      const decorated = decorateMessageIdentity(existing);
      decorated.client_msg_id = safeClientMsgId;
      return decorated;
    }
  }

  const mergedMetadata = mergeMessageOriginMetadata(
    safeClientMsgId
      ? { ...(metadata && typeof metadata === 'object' ? metadata : {}), __client_msg_id: safeClientMsgId }
      : metadata,
    channel,
  );

  const sentAt = new Date();
  return prisma.$transaction(async (tx) => {
    const message = await tx.chat_messages.create({
      data: {
        channel_id: safeChannelId,
        sender_id: safeSenderId,
        content: safeContent,
        content_type: safeContentType,
        sent_at: sentAt,
        is_read: false,
        platform_type_id: safePlatformTypeId,
        metadata: mergedMetadata,
      },
      include: messageInclude,
    });

    await tx.chat_channel.update({
      where: { channel_id: safeChannelId },
      data: { last_message_at: sentAt },
    });

    // A new message revives the conversation for anyone who had left/deleted it,
    // so they don't silently miss messages after deleting the thread (bug #8).
    await tx.chat_participants.updateMany({
      where: { channel_id: safeChannelId, left_at: { not: null } },
      data: { left_at: null },
    });

    const decorated = decorateMessageIdentity(message);
    // Echo client_msg_id back so the sender's optimistic row reconciles by id, not by text.
    if (safeClientMsgId) decorated.client_msg_id = safeClientMsgId;
    return decorated;
  });
}

export async function updateChatMessage({ messageId, userId, content }) {
  const safeMessageId = toPositiveInt(messageId, 'message_id');
  const safeUserId = toPositiveInt(userId, 'user_id');

  const existing = await prisma.chat_messages.findUnique({
    where: { message_id: safeMessageId },
  });

  if (!existing) {
    const error = new Error('Message not found');
    error.statusCode = 404;
    throw error;
  }

  if (existing.deleted_at) {
    const error = new Error('Message not found');
    error.statusCode = 404;
    throw error;
  }

  await ensureChannelParticipant(existing.channel_id, safeUserId);

  const data = {};
  if (content !== undefined) {
    if (existing.sender_id !== safeUserId) {
      const error = new Error('Only the sender can edit this message');
      error.statusCode = 403;
      throw error;
    }
    const contentType = String(existing.content_type ?? 'text').toLowerCase();
    if (contentType !== 'text') {
      const error = new Error('Only text messages can be edited');
      error.statusCode = 400;
      throw error;
    }
    data.content = requireText(content, 'content');
    data.edited_at = new Date();
  }
  if (!Object.keys(data).length) {
    const error = new Error('No valid message fields provided');
    error.statusCode = 400;
    throw error;
  }

  return prisma.chat_messages.update({
    where: { message_id: safeMessageId },
    data,
    include: messageInclude,
  });
}

export async function deleteChatMessage({ messageId, userId }) {
  const safeMessageId = toPositiveInt(messageId, 'message_id');
  const safeUserId = toPositiveInt(userId, 'user_id');

  const existing = await prisma.chat_messages.findUnique({
    where: { message_id: safeMessageId },
  });

  if (!existing) {
    const error = new Error('Message not found');
    error.statusCode = 404;
    throw error;
  }

  if (existing.deleted_at) {
    const error = new Error('Message not found');
    error.statusCode = 404;
    throw error;
  }

  if (existing.sender_id !== safeUserId) {
    const error = new Error('Only the sender can delete this message');
    error.statusCode = 403;
    throw error;
  }

  return prisma.chat_messages.update({
    where: { message_id: safeMessageId },
    data: { deleted_at: new Date() },
    include: messageInclude,
  });
}

export async function getUserInbox(userId) {
  const safeUserId = toPositiveInt(userId, 'user_id');

  const [myParticipations, blockedGraph] = await Promise.all([
    prisma.chat_participants.findMany({
      // Hide conversations the user has left/deleted (left_at set), matching getUserChannels.
      // Without this filter, "delete conversation" appeared to do nothing on refresh (bug #16).
      // A new message in the channel clears left_at again (see createChatMessage), so it reappears.
      where: { user_id: safeUserId, left_at: null },
      include: {
        chat_channel: {
          include: {
            chat_participants: {
              include: {
                user: {
                  select: {
                    user_id: true,
                    name: true,
                    username: true,
                    social_profiles: {
                      select: { handle: true, display_name: true, profile_pic_url: true },
                    },
                    vertical_profiles: {
                      select: { vertical: true, handle: true, display_name: true, profile_pic_url: true },
                    },
                  },
                },
              },
            },
            chat_messages: { where: { deleted_at: null }, orderBy: { sent_at: 'desc' }, take: 1 },
          },
        },
      },
    }),
    blockedGraphForUser(safeUserId),
  ]);
  const blockedUserIds = new Set(blockedGraph.userIds.map(Number));
  const visibleParticipations = myParticipations
    .filter((participation) => participation.chat_channel)
    .filter((participation) => {
      const channel = participation.chat_channel;
      if (channel.type !== 'dm') return true;
      return !(channel.chat_participants || [])
        .some((participant) => participant.user_id !== safeUserId && blockedUserIds.has(Number(participant.user_id)));
    });

  const unreadEntries = await Promise.all(visibleParticipations.map(async (participation) => {
    if (!participation.channel_id) return [participation.channel_id, 0];
    const count = await prisma.chat_messages.count({
      where: {
        channel_id: participation.channel_id,
        deleted_at: null,
        sender_id: { not: safeUserId },
        ...(participation.last_read_message_id
          ? { message_id: { gt: participation.last_read_message_id } }
          : {}),
      },
    });
    return [participation.channel_id, count];
  }));
  const unreadMap = Object.fromEntries(unreadEntries);

  return visibleParticipations
    .map((participation) => {
      const channel = participation.chat_channel;
      const isDm = channel.type === 'dm';
      const otherParticipant = channel.chat_participants
        .find((participant) => participant.user_id !== safeUserId);
      const otherUser = otherParticipant?.user ?? null;
      const lastMessage = channel.chat_messages[0] ?? null;
      // In a vertical-context channel, show each participant's vertical identity.
      const vertical = verticalForContextType(channel.context_type);
      const otherIdentity = resolveChatIdentity(otherUser, vertical);
      const displayName = otherIdentity.name;
      const participants = !isDm
        ? channel.chat_participants
          .filter((participant) => participant.user_id)
          .map((participant) => {
            const identity = resolveChatIdentity(participant.user, vertical);
            return {
              user_id: participant.user_id,
              role: participant.role,
              name: identity.name,
              handle: identity.handle,
              profile_pic_url: identity.profile_pic_url,
            };
          })
        : undefined;

      return {
        channel_id: channel.channel_id,
        channel_name: channel.channel_name,
        type: channel.type,
        context_type: channel.context_type,
        context_id: channel.context_id,
        room: chatRoomName(channel.channel_id),
        member_count: channel.chat_participants.length,
        participants,
        other_user: otherUser ? {
          user_id: otherUser.user_id,
          name: displayName,
          handle: otherIdentity.handle,
          avatar: displayName[0].toUpperCase(),
          profile_pic_url: otherIdentity.profile_pic_url,
        } : null,
        last_message: lastMessage ? {
          message_id: lastMessage.message_id,
          content: lastMessage.content,
          content_type: lastMessage.content_type,
          sent_at: lastMessage.sent_at,
          is_mine: lastMessage.sender_id === safeUserId,
        } : null,
        unread_count: unreadMap[channel.channel_id] || 0,
      };
    })
    .sort((a, b) => {
      const aTime = a.last_message?.sent_at ? new Date(a.last_message.sent_at).getTime() : 0;
      const bTime = b.last_message?.sent_at ? new Date(b.last_message.sent_at).getTime() : 0;
      return bTime - aTime;
    });
}

export async function getUserChannels(userId) {
  const safeUserId = toPositiveInt(userId, 'user_id');

  const [participations, blockedGraph] = await Promise.all([
    prisma.chat_participants.findMany({
      // Hide conversations the user has left/deleted (left_at set). A new message in
      // the channel clears left_at again (see createChatMessage), so it reappears.
      where: { user_id: safeUserId, left_at: null },
      orderBy: { chat_participant_id: 'desc' },
      include: {
        chat_channel: {
          include: {
            platform_type: true,
            chat_participants: { select: { user_id: true } },
          },
        },
      },
    }),
    blockedGraphForUser(safeUserId),
  ]);
  const blockedUserIds = new Set(blockedGraph.userIds.map(Number));

  return participations
    .map((participation) => participation.chat_channel)
    .filter((channel) => channel && channel.status !== 'blocked')
    .filter((channel) => {
      if (channel.type !== 'dm') return true;
      return !(channel.chat_participants || [])
        .some((participant) => participant.user_id !== safeUserId && blockedUserIds.has(Number(participant.user_id)));
    })
    .map((channel) => {
      const { chat_participants: _participants, ...rest } = channel;
      return rest;
    });
}

// Distinct user ids the caller shares at least one chat channel with. Used to scope
// online-presence lookups so a user can only observe presence of people they actually
// message (never arbitrary account enumeration). Bounded by the caller's own channels.
export async function getChatPeerIds(userId) {
  const safeUserId = toPositiveInt(userId, 'user_id');
  const [mine, blockedGraph] = await Promise.all([
    prisma.chat_participants.findMany({
      where: { user_id: safeUserId },
      select: { channel_id: true },
    }),
    blockedGraphForUser(safeUserId),
  ]);
  const channelIds = mine.map((m) => m.channel_id);
  if (!channelIds.length) return [];
  const blockedUserIds = new Set(blockedGraph.userIds.map(Number));
  const peers = await prisma.chat_participants.findMany({
    where: { channel_id: { in: channelIds }, user_id: { not: safeUserId } },
    select: { user_id: true },
    distinct: ['user_id'],
  });
  return peers.map((p) => p.user_id).filter((id) => id != null && !blockedUserIds.has(Number(id)));
}

// "Delete conversation" = leave it for the current user only (soft, per-participant).
// We set left_at rather than hard-deleting the channel so the other participant keeps
// their copy and history; a future message revives it. (bug report #8)
export async function leaveChannel(channelId, userId) {
  const safeChannelId = toPositiveInt(channelId, 'channel_id');
  const safeUserId = toPositiveInt(userId, 'user_id');
  await ensureChannelParticipant(safeChannelId, safeUserId);
  await prisma.chat_participants.updateMany({
    where: { channel_id: safeChannelId, user_id: safeUserId },
    data: { left_at: new Date() },
  });
  return { channel_id: safeChannelId, left: true };
}

// Bring a conversation back for a participant who had left it.
async function reviveParticipant(channelId, userId) {
  await prisma.chat_participants.updateMany({
    where: { channel_id: channelId, user_id: userId, left_at: { not: null } },
    data: { left_at: null },
  });
}

export async function createOwnedChannel({
  userId,
  type,
  channelName,
  platformTypeId,
  contextType,
  contextId,
}) {
  const safeUserId = toPositiveInt(userId, 'user_id');
  const safeType = requireText(type, 'type');
  const safeChannelName = requireText(channelName, 'channel_name');
  const safePlatformTypeId = toOptionalPositiveInt(platformTypeId, 'platform_type_id');
  const safeContextType = optionalText(contextType, 'context_type');
  const safeContextId = optionalText(contextId, 'context_id');

  return prisma.$transaction(async (tx) => {
    const channel = await tx.chat_channel.create({
      data: {
        type: safeType,
        channel_name: safeChannelName,
        platform_type_id: safePlatformTypeId,
        context_type: safeContextType,
        context_id: safeContextId,
        created_by: safeUserId,
      },
    });

    await tx.chat_participants.create({
      data: {
        channel_id: channel.channel_id,
        user_id: safeUserId,
        role: 'owner',
        platform_type_id: safePlatformTypeId,
      },
    });

    return channel;
  });
}

export async function openDirectChannel({ userId, targetUserId, sourceVertical: rawSourceVertical } = {}) {
  const safeUserId = toPositiveInt(userId, 'user_id');
  const safeTargetUserId = toPositiveInt(targetUserId, 'target_user_id');
  const sourceVertical = normalizeDmSourceVertical(rawSourceVertical);

  async function tagDmSourceIfNeeded(channelId, existingContextType, existingContextId) {
    if (!shouldApplyDmSourceTag(existingContextType, existingContextId, sourceVertical)) return;
    await prisma.chat_channel.update({
      where: { channel_id: channelId },
      data: { context_type: sourceVertical, context_id: null },
    });
  }

  if (safeUserId === safeTargetUserId) {
    const error = new Error('Cannot DM yourself');
    error.statusCode = 400;
    throw error;
  }

  const targetUser = await prisma.user.findUnique({
    where: { user_id: safeTargetUserId },
    select: { user_id: true },
  });

  if (!targetUser) {
    const error = new Error('Target user not found');
    error.statusCode = 404;
    throw error;
  }
  if (await areUsersBlockedOnPlatform(safeUserId, safeTargetUserId)) {
    const error = new Error('This conversation is not available');
    error.statusCode = 403;
    throw error;
  }

  const dmKey = `dm_${Math.min(safeUserId, safeTargetUserId)}_${Math.max(safeUserId, safeTargetUserId)}`;
  const keyedChannel = await prisma.chat_channel.findUnique({
    where: { dm_key: dmKey },
    select: { channel_id: true, status: true },
  });

  if (keyedChannel) {
    if (keyedChannel.status === 'blocked') {
      const error = new Error('This conversation is not available');
      error.statusCode = 403;
      throw error;
    }
    const full = await prisma.chat_channel.findUnique({
      where: { channel_id: keyedChannel.channel_id },
      select: { context_type: true, context_id: true },
    });
    await tagDmSourceIfNeeded(keyedChannel.channel_id, full?.context_type, full?.context_id);
    // Re-opening a DM the caller previously deleted should bring it back.
    await reviveParticipant(keyedChannel.channel_id, safeUserId);
    return { channel_id: keyedChannel.channel_id, created: false };
  }

  const myChannelIds = (await prisma.chat_participants.findMany({
    where: { user_id: safeUserId },
    select: { channel_id: true },
  })).map((participant) => participant.channel_id).filter(Boolean);

  if (myChannelIds.length) {
    const existing = await prisma.chat_participants.findFirst({
      where: {
        user_id: safeTargetUserId,
        channel_id: { in: myChannelIds },
        chat_channel: { type: 'dm' },
      },
      select: { channel_id: true, chat_channel: { select: { status: true } } },
    });

    if (existing) {
      if (existing.chat_channel?.status === 'blocked') {
        const error = new Error('This conversation is not available');
        error.statusCode = 403;
        throw error;
      }
      const legacy = await prisma.chat_channel.findUnique({
        where: { channel_id: existing.channel_id },
        select: { context_type: true, context_id: true },
      });
      await tagDmSourceIfNeeded(existing.channel_id, legacy?.context_type, legacy?.context_id);
      await prisma.chat_channel.update({
        where: { channel_id: existing.channel_id },
        data: { dm_key: dmKey },
      });
      await reviveParticipant(existing.channel_id, safeUserId);
      return { channel_id: existing.channel_id, created: false };
    }
  }

  const channel = await prisma.$transaction(async (tx) => {
    const createdChannel = await tx.chat_channel.create({
      data: {
        type: 'dm',
        channel_name: dmKey,
        dm_key: dmKey,
        created_by: safeUserId,
        ...(sourceVertical ? { context_type: sourceVertical } : {}),
      },
    });

    await tx.chat_participants.createMany({
      data: [
        { channel_id: createdChannel.channel_id, user_id: safeUserId, role: 'member' },
        { channel_id: createdChannel.channel_id, user_id: safeTargetUserId, role: 'member' },
      ],
    });

    return createdChannel;
  });

  return { channel_id: channel.channel_id, created: true };
}
