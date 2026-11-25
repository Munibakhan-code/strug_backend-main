// services/staff-chat-service.js
//
// Internal staff messaging — the service layer for board-member-to-board-member chat.
// Mirrors the proven user-facing chat-service.js design (DM dedupe via dm_key, cursor
// pagination, participant roles) but is keyed on board_member.member_id, NOT user.user_id
// (the two identity systems are disjoint — see the staff_* models in schema.prisma).
//
// Channel kinds:
//   company  — org-wide, every approved member (auto-provisioned: #general, #random)
//   team     — one per RBAC dashboard; visible to anyone with read access to that
//              dashboard_key (auto-provisioned from the DASHBOARDS catalog)
//   dm       — 1:1, deduped by dm_key
//   topic /
//   incident — custom channels; explicit membership, optional allowed_roles invite gate
//
// This module is transport-agnostic: createMessage() persists and returns the row; the
// socket layer (BE-2) is responsible for broadcasting it.

import prisma from '../utils/prisma-client.js';
import { DASHBOARDS, DASHBOARD_IDS, hasDashboardAccess, effectiveAccess } from './board-rbac.js';
import { isStaffOnline } from '../sockets/staff-presence.js';

const CUSTOM_KINDS = ['topic', 'incident'];

function httpErr(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}
function toPositiveInt(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpErr(400, `Invalid ${field}`);
  return n;
}
function toPageSize(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return 40;
  return Math.min(n, 100);
}
export function dmKey(a, b) {
  return `dm_${Math.min(a, b)}_${Math.max(a, b)}`;
}

// Pure access decision for a channel (the security core, unit-tested). `isParticipant` = the
// member has an active participant row. company → everyone; team → read access to its
// dashboard_key (or super-admin); dm/topic/incident → must be a participant.
export function canAccessChannel(channel, { access, isSuperAdmin, isParticipant } = {}) {
  if (!channel || channel.archived_at) return false;
  if (channel.kind === 'company') return true;
  if (channel.kind === 'team') return !!isSuperAdmin || hasDashboardAccess(access || {}, channel.dashboard_key, 'read');
  return !!isParticipant; // dm / topic / incident
}
function publicChannel(c) {
  return {
    channel_id: c.channel_id,
    kind: c.kind,
    name: c.name,
    dashboard_key: c.dashboard_key,
    is_private: c.is_private,
    last_message_at: c.last_message_at,
    created_at: c.created_at,
  };
}

// ── Baseline provisioning ────────────────────────────────────────────────────────────
// Idempotently create the company channels + one team channel per dashboard. Cached per
// process; the compound unique (kind, dashboard_key) makes the upserts safe under races.
let baselineEnsured = false;
const COMPANY_CHANNELS = [
  { key: 'general', name: 'general' },
  { key: 'random', name: 'random' },
];

export async function ensureBaselineChannels() {
  // In tests the DB is truncated between files, so never short-circuit — the upserts are
  // idempotent and cheap enough to re-run so channels always exist for a fresh test DB.
  if (baselineEnsured && process.env.NODE_ENV !== 'test') return;
  const companyChannels = await Promise.all(
    COMPANY_CHANNELS.map(({ key, name }) =>
      prisma.staff_channel.upsert({
        where: { kind_dashboard_key: { kind: 'company', dashboard_key: key } },
        update: {},
        create: { kind: 'company', dashboard_key: key, name, created_by: 0 },
      })
    )
  );
  await Promise.all(
    DASHBOARDS.map((d) =>
      prisma.staff_channel.upsert({
        where: { kind_dashboard_key: { kind: 'team', dashboard_key: d.id } },
        update: {},
        create: { kind: 'team', dashboard_key: d.id, name: d.id, created_by: 0 },
      })
    )
  );
  // Company channels are org-wide. Access is implicit (canAccessChannel → true for everyone),
  // but the roster/avatar-stack is built from participant rows, so back-fill a row for every
  // approved member — otherwise a member who has never opened Messages is absent from the list.
  await enrollAllInCompanyChannels(companyChannels.map((c) => c.channel_id));
  baselineEnsured = true;
}

// Bulk-enroll every approved member into the given company channels (idempotent).
async function enrollAllInCompanyChannels(companyChannelIds) {
  if (!companyChannelIds.length) return;
  const members = await prisma.board_member.findMany({ where: { status: 'approved' }, select: { member_id: true } });
  if (!members.length) return;
  const rows = [];
  for (const cid of companyChannelIds) for (const m of members) rows.push({ channel_id: cid, member_id: m.member_id });
  await prisma.staff_channel_member.createMany({ data: rows, skipDuplicates: true });
}

// Enroll a single member into all company channels — call when a member is approved so a new
// hire shows up in #general/#random immediately, not only after their first Messages load.
export async function enrollMemberInCompanyChannels(memberId) {
  const mid = toPositiveInt(memberId, 'member_id');
  await ensureBaselineChannels();
  const company = await prisma.staff_channel.findMany({ where: { kind: 'company', archived_at: null }, select: { channel_id: true } });
  if (!company.length) return;
  await prisma.staff_channel_member.createMany({
    data: company.map((c) => ({ channel_id: c.channel_id, member_id: mid })),
    skipDuplicates: true,
  });
}

// ── Membership ───────────────────────────────────────────────────────────────────────
export async function ensureParticipant(channelId, memberId, role = 'member') {
  return prisma.staff_channel_member.upsert({
    where: { channel_id_member_id: { channel_id: channelId, member_id: memberId } },
    update: { left_at: null },
    create: { channel_id: channelId, member_id: memberId, role },
  });
}

// Resolve a member's effective access map from the DB — the socket path has only the JWT
// claims (member_id), not the RBAC map that authenticateBoard builds for REST requests, so
// team-channel gating on a socket must resolve access live (roles can change mid-session).
export async function resolveMemberAccess(memberId) {
  const member = await prisma.board_member.findUnique({ where: { member_id: Number(memberId) } });
  if (!member || member.status !== 'approved') throw httpErr(403, 'Not authorized');
  const role = member.role_id ? await prisma.board_role.findUnique({ where: { role_id: member.role_id } }) : null;
  return { access: effectiveAccess(member, role), isSuperAdmin: !!member.is_super_admin };
}

// Load a channel the member is allowed to see, materializing their participant row for
// company/team channels (so read cursors work). Throws 403/404 otherwise.
export async function loadAccessibleChannel(channelId, memberId, access, isSuperAdmin) {
  const channel = await prisma.staff_channel.findUnique({ where: { channel_id: channelId } });
  if (!channel || channel.archived_at) throw httpErr(404, 'Channel not found');

  const isAuto = channel.kind === 'company' || channel.kind === 'team';
  let isParticipant = false;
  if (!isAuto) {
    const part = await prisma.staff_channel_member.findUnique({
      where: { channel_id_member_id: { channel_id: channelId, member_id: memberId } },
    });
    isParticipant = !!(part && !part.left_at);
  }

  if (!canAccessChannel(channel, { access, isSuperAdmin, isParticipant })) {
    throw httpErr(403, channel.kind === 'team' ? 'No access to this team channel' : 'Not a member of this channel');
  }
  // Materialize the participant row for auto (company/team) channels so read cursors work.
  if (isAuto) await ensureParticipant(channelId, memberId);
  return channel;
}

// ── Listing ──────────────────────────────────────────────────────────────────────────
export async function listChannelsForMember({ memberId, access, isSuperAdmin }) {
  await ensureBaselineChannels();

  const teamKeys = isSuperAdmin ? DASHBOARD_IDS : Object.keys(access || {});
  const [companyChannels, teamChannels, myParts] = await Promise.all([
    prisma.staff_channel.findMany({ where: { kind: 'company', archived_at: null }, orderBy: { name: 'asc' } }),
    prisma.staff_channel.findMany({
      where: { kind: 'team', archived_at: null, dashboard_key: { in: teamKeys.length ? teamKeys : ['__none__'] } },
      orderBy: { name: 'asc' },
    }),
    prisma.staff_channel_member.findMany({ where: { member_id: memberId, left_at: null } }),
  ]);

  const myChannelIds = myParts.map((p) => p.channel_id);
  const customAndDms = await prisma.staff_channel.findMany({
    where: {
      channel_id: { in: myChannelIds.length ? myChannelIds : [-1] },
      kind: { in: ['dm', 'topic', 'incident'] },
      archived_at: null,
    },
    orderBy: { last_message_at: 'desc' },
  });

  // Materialize participant rows for the auto (company/team) channels this member sees.
  await Promise.all([...companyChannels, ...teamChannels].map((c) => ensureParticipant(c.channel_id, memberId)));
  const parts = await prisma.staff_channel_member.findMany({ where: { member_id: memberId, left_at: null } });
  const partByChannel = new Map(parts.map((p) => [p.channel_id, p]));

  const all = [...companyChannels, ...teamChannels, ...customAndDms];

  // Resolve the "other side" of each DM for a display name.
  const dmChannels = all.filter((c) => c.kind === 'dm');
  const dmPeers = new Map();
  if (dmChannels.length) {
    const dmMembers = await prisma.staff_channel_member.findMany({
      where: { channel_id: { in: dmChannels.map((c) => c.channel_id) }, member_id: { not: memberId }, left_at: null },
    });
    const peerIds = [...new Set(dmMembers.map((m) => m.member_id))];
    const peers = await prisma.board_member.findMany({
      where: { member_id: { in: peerIds.length ? peerIds : [-1] } },
      select: { member_id: true, name: true, avatar_url: true },
    });
    const peerById = new Map(peers.map((p) => [p.member_id, p]));
    for (const m of dmMembers) {
      const p = peerById.get(m.member_id);
      dmPeers.set(m.channel_id, { member_id: m.member_id, name: p?.name || 'Unknown', avatar_url: p?.avatar_url ?? null });
    }
  }

  // Last-message previews for the list/drawer — one findFirst per channel (fine at staff scale).
  const lastMsgs = await Promise.all(
    all.map((c) =>
      prisma.staff_message.findFirst({
        where: { channel_id: c.channel_id, deleted_at: null },
        orderBy: { message_id: 'desc' },
        select: { content: true, sender_id: true, created_at: true },
      })
    )
  );
  const lastByChannel = new Map(all.map((c, i) => [c.channel_id, lastMsgs[i]]));
  const previewSenderIds = [...new Set(lastMsgs.filter(Boolean).map((m) => m.sender_id).filter((id) => id > 0))];
  const previewSenders = await prisma.board_member.findMany({
    where: { member_id: { in: previewSenderIds.length ? previewSenderIds : [-1] } },
    select: { member_id: true, name: true },
  });
  const previewName = new Map(previewSenders.map((s) => [s.member_id, s.name]));

  const decorated = await Promise.all(
    all.map(async (c) => {
      const part = partByChannel.get(c.channel_id);
      const lastRead = part?.last_read_message_id ?? 0;
      const unread = await prisma.staff_message.count({
        where: { channel_id: c.channel_id, deleted_at: null, message_id: { gt: lastRead }, sender_id: { not: memberId } },
      });
      const base = { ...publicChannel(c), unread, muted: part?.muted ?? false };
      const lm = lastByChannel.get(c.channel_id);
      if (lm) base.last_message = { content: String(lm.content).slice(0, 140), sender_name: previewName.get(lm.sender_id) || 'Unknown', created_at: lm.created_at };
      if (c.kind === 'dm') {
        base.dm_with = dmPeers.get(c.channel_id) || null;
        if (base.dm_with) base.dm_with.online = isStaffOnline(base.dm_with.member_id);
      }
      return base;
    })
  );

  return {
    company: decorated.filter((c) => c.kind === 'company'),
    teams: decorated.filter((c) => c.kind === 'team'),
    custom: decorated.filter((c) => c.kind === 'topic' || c.kind === 'incident'),
    dms: decorated.filter((c) => c.kind === 'dm'),
  };
}

// ── DMs ──────────────────────────────────────────────────────────────────────────────
export async function openDirectChannel({ memberId, targetMemberId }) {
  const me = toPositiveInt(memberId, 'member_id');
  const target = toPositiveInt(targetMemberId, 'target_member_id');
  if (me === target) throw httpErr(400, 'Cannot DM yourself');

  const exists = await prisma.board_member.findUnique({ where: { member_id: target }, select: { member_id: true } });
  if (!exists) throw httpErr(404, 'Member not found');

  const key = dmKey(me, target);
  const keyed = await prisma.staff_channel.findUnique({ where: { dm_key: key }, select: { channel_id: true } });
  if (keyed) {
    await ensureParticipant(keyed.channel_id, me);
    return { channel_id: keyed.channel_id, created: false };
  }

  const channel = await prisma.$transaction(async (tx) => {
    const c = await tx.staff_channel.create({ data: { kind: 'dm', dm_key: key, is_private: true, created_by: me } });
    await tx.staff_channel_member.createMany({
      data: [
        { channel_id: c.channel_id, member_id: me, role: 'member' },
        { channel_id: c.channel_id, member_id: target, role: 'member' },
      ],
    });
    return c;
  });
  return { channel_id: channel.channel_id, created: true };
}

// ── Custom channels ──────────────────────────────────────────────────────────────────
export async function createChannel({ creatorId, kind, name, isPrivate, allowedRoles }) {
  const me = toPositiveInt(creatorId, 'creator_id');
  if (!CUSTOM_KINDS.includes(kind)) throw httpErr(400, 'Invalid channel kind');
  if (!name || !String(name).trim()) throw httpErr(400, 'A channel name is required');
  const roles = Array.isArray(allowedRoles) ? allowedRoles.filter((r) => typeof r === 'string') : null;

  return prisma.$transaction(async (tx) => {
    const c = await tx.staff_channel.create({
      data: {
        kind,
        name: String(name).trim().slice(0, 120),
        is_private: !!isPrivate,
        allowed_roles: roles && roles.length ? roles : undefined,
        created_by: me,
      },
    });
    await tx.staff_channel_member.create({ data: { channel_id: c.channel_id, member_id: me, role: 'owner' } });
    return publicChannel(c);
  });
}

export async function inviteMember({ channelId, actorId, targetMemberId }) {
  const cid = toPositiveInt(channelId, 'channel_id');
  const actor = toPositiveInt(actorId, 'actor_id');
  const target = toPositiveInt(targetMemberId, 'member_id');

  const channel = await prisma.staff_channel.findUnique({ where: { channel_id: cid } });
  if (!channel) throw httpErr(404, 'Channel not found');
  if (!CUSTOM_KINDS.includes(channel.kind)) throw httpErr(400, 'Members can only be invited to custom channels');

  // Any active member of a custom channel may add people (not just owners/admins) — team
  // channels are auto-gated by dashboard access and never reach here (CUSTOM_KINDS guard above).
  const actorPart = await prisma.staff_channel_member.findUnique({
    where: { channel_id_member_id: { channel_id: cid, member_id: actor } },
  });
  if (!actorPart || actorPart.left_at) {
    throw httpErr(403, 'You must be a member of this channel to add people');
  }

  const targetMember = await prisma.board_member.findUnique({ where: { member_id: target } });
  if (!targetMember || targetMember.status !== 'approved') throw httpErr(404, 'Member not found');

  // allowed_roles gate: if set, the invitee's role key must be in the list.
  if (Array.isArray(channel.allowed_roles) && channel.allowed_roles.length) {
    const role = targetMember.role_id
      ? await prisma.board_role.findUnique({ where: { role_id: targetMember.role_id } })
      : null;
    if (!role || !channel.allowed_roles.includes(role.key)) {
      throw httpErr(403, "This member's role is not permitted in this channel");
    }
  }
  await ensureParticipant(cid, target);
  return { channel_id: cid, member_id: target };
}

export async function listChannelMembers({ channelId, memberId, access, isSuperAdmin }) {
  const cid = toPositiveInt(channelId, 'channel_id');
  await loadAccessibleChannel(cid, memberId, access, isSuperAdmin);
  const parts = await prisma.staff_channel_member.findMany({ where: { channel_id: cid, left_at: null } });
  const ids = parts.map((p) => p.member_id).filter((id) => id > 0);
  const members = await prisma.board_member.findMany({
    where: { member_id: { in: ids.length ? ids : [-1] } },
    select: { member_id: true, name: true, email: true, avatar_url: true },
  });
  const byId = new Map(members.map((m) => [m.member_id, m]));
  return parts.map((p) => ({ member_id: p.member_id, role: p.role, ...(byId.get(p.member_id) || {}) }));
}

// ── Messages ─────────────────────────────────────────────────────────────────────────
async function decorateSenders(messages) {
  const ids = [...new Set(messages.map((m) => m.sender_id).filter((id) => id > 0))];
  const senders = await prisma.board_member.findMany({
    where: { member_id: { in: ids.length ? ids : [-1] } },
    select: { member_id: true, name: true, avatar_url: true, role_id: true },
  });
  const roleIds = [...new Set(senders.map((s) => s.role_id).filter(Boolean))];
  const roles = await prisma.board_role.findMany({ where: { role_id: { in: roleIds.length ? roleIds : [-1] } }, select: { role_id: true, name: true } });
  const roleName = new Map(roles.map((r) => [r.role_id, r.name]));
  const byId = new Map(senders.map((s) => [s.member_id, s]));
  return messages.map((m) => {
    const s = byId.get(m.sender_id);
    return { ...m, sender: { member_id: m.sender_id, name: s?.name || 'Unknown', avatar_url: s?.avatar_url ?? null, role: s?.role_id ? roleName.get(s.role_id) || null : null } };
  });
}

export async function getChannelMessages({ channelId, memberId, limit, beforeMessageId, access, isSuperAdmin }) {
  const cid = toPositiveInt(channelId, 'channel_id');
  const safeLimit = toPageSize(limit);
  const before = beforeMessageId ? toPositiveInt(beforeMessageId, 'before_message_id') : null;
  await loadAccessibleChannel(cid, memberId, access, isSuperAdmin);

  // Top-level messages only (thread replies live under their parent).
  const rows = await prisma.staff_message.findMany({
    where: { channel_id: cid, deleted_at: null, parent_id: null, ...(before ? { message_id: { lt: before } } : {}) },
    orderBy: { message_id: 'desc' },
    take: safeLimit + 1,
  });
  const hasMore = rows.length > safeLimit;
  const page = rows.slice(0, safeLimit).reverse();

  // Reply counts + last-reply time per message.
  const parentIds = page.map((m) => m.message_id);
  const groups = parentIds.length
    ? await prisma.staff_message.groupBy({ by: ['parent_id'], where: { parent_id: { in: parentIds }, deleted_at: null }, _count: { _all: true }, _max: { created_at: true } })
    : [];
  const replies = new Map(groups.map((g) => [g.parent_id, { count: g._count._all, last: g._max.created_at }]));

  const decorated = await decorateSenders(page);
  const messages = decorated.map((m) => ({ ...m, reply_count: replies.get(m.message_id)?.count || 0, last_reply_at: replies.get(m.message_id)?.last || null }));
  return {
    messages,
    pagination: { limit: safeLimit, has_more: hasMore, next_before_message_id: hasMore ? page[0]?.message_id ?? null : null },
  };
}

// A single thread: the parent message + its replies (chronological).
export async function getThreadMessages({ channelId, parentId, memberId, access, isSuperAdmin }) {
  const cid = toPositiveInt(channelId, 'channel_id');
  const pid = toPositiveInt(parentId, 'parent_id');
  await loadAccessibleChannel(cid, memberId, access, isSuperAdmin);
  const parent = await prisma.staff_message.findFirst({ where: { message_id: pid, channel_id: cid, deleted_at: null } });
  if (!parent) throw httpErr(404, 'Thread not found');
  const replies = await prisma.staff_message.findMany({ where: { parent_id: pid, deleted_at: null }, orderBy: { message_id: 'asc' } });
  const decorated = await decorateSenders([parent, ...replies]);
  return { parent: decorated[0], replies: decorated.slice(1) };
}

// Pin / unpin a message. Allowed for super-admins (leadership) and owners/admins of a
// custom channel. Team/company channels → super-admin only.
export async function setPinned({ channelId, messageId, pinned, actorId, access, isSuperAdmin }) {
  const cid = toPositiveInt(channelId, 'channel_id');
  const mid = toPositiveInt(messageId, 'message_id');
  const channel = await loadAccessibleChannel(cid, actorId, access, isSuperAdmin);
  let allowed = !!isSuperAdmin;
  if (!allowed && CUSTOM_KINDS.includes(channel.kind)) {
    const part = await prisma.staff_channel_member.findUnique({ where: { channel_id_member_id: { channel_id: cid, member_id: actorId } } });
    allowed = !!(part && ['owner', 'admin'].includes(part.role));
  }
  if (!allowed) throw httpErr(403, 'Only leadership or channel admins can pin');
  await prisma.staff_message.update({ where: { message_id: mid }, data: { pinned: !!pinned } });
  return { channel_id: cid, message_id: mid, pinned: !!pinned };
}

export async function listPinned({ channelId, memberId, access, isSuperAdmin }) {
  const cid = toPositiveInt(channelId, 'channel_id');
  await loadAccessibleChannel(cid, memberId, access, isSuperAdmin);
  const rows = await prisma.staff_message.findMany({ where: { channel_id: cid, pinned: true, deleted_at: null }, orderBy: { message_id: 'desc' }, take: 20 });
  return { pinned: await decorateSenders(rows) };
}

export async function createMessage({ channelId, senderId, content, contentType, parentId, metadata, access, isSuperAdmin }) {
  const cid = toPositiveInt(channelId, 'channel_id');
  const sender = toPositiveInt(senderId, 'sender_id');
  if (!content || !String(content).trim()) throw httpErr(400, 'Message content is required');
  await loadAccessibleChannel(cid, sender, access, isSuperAdmin);

  // Announcements are a leadership (super-admin) affordance and auto-pin to the channel.
  const isAnnouncement = contentType === 'announcement';
  if (isAnnouncement && !isSuperAdmin) throw httpErr(403, 'Only leadership can post announcements');

  const message = await prisma.$transaction(async (tx) => {
    const m = await tx.staff_message.create({
      data: {
        channel_id: cid,
        sender_id: sender,
        content: String(content),
        content_type: contentType || 'text',
        parent_id: parentId ? Number(parentId) : null,
        pinned: isAnnouncement,
        metadata: metadata ?? undefined,
      },
    });
    await tx.staff_channel.update({ where: { channel_id: cid }, data: { last_message_at: new Date() } });
    return m;
  });
  const [decorated] = await decorateSenders([message]);
  return decorated;
}

export async function markRead({ channelId, memberId, access, isSuperAdmin }) {
  const cid = toPositiveInt(channelId, 'channel_id');
  await loadAccessibleChannel(cid, memberId, access, isSuperAdmin);
  const latest = await prisma.staff_message.findFirst({
    where: { channel_id: cid, deleted_at: null },
    orderBy: { message_id: 'desc' },
    select: { message_id: true },
  });
  await prisma.staff_channel_member.updateMany({
    where: { channel_id: cid, member_id: memberId },
    data: { last_read_message_id: latest?.message_id ?? null },
  });
  return { channel_id: cid, last_read_message_id: latest?.message_id ?? null };
}
