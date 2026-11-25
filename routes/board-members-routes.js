// routes/board-members-routes.js
//
// Member management for the internal board. Mounted at /board/members. Router-level guard:
// an approved member with the manage_members capability (staff lifecycle: create / approve /
// reject / deactivate).
//
// RBAC v2 (2026-07-13): a member's access is defined by their ROLE (board_role) plus an
// optional per-member access_overrides map ("Custom"). Assigning a role, hand-tuning access,
// and granting super-admin are stricter, SUPER-ADMIN-only actions:
//
//   GET    /board/members            all members (+ role, resolved access, open-task counts)
//   GET    /board/members/pending    signups awaiting approval
//   POST   /board/members            admin-create an approved member with a starting role
//   PATCH  /board/members/:id/approve    approve a pending signup
//   PATCH  /board/members/:id/reject     reject a pending signup
//   PATCH  /board/members/:id/deactivate block login, preserve history
//   PATCH  /board/members/:id/role       (super) assign a role (clears custom overrides)
//   PATCH  /board/members/:id/access     (super) hand-tune per-dashboard access ("Custom")

import express from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import {
  authenticateBoard,
  requireManageMembers,
  requireSuperAdmin,
} from '../middleware/authenticate-board.js';
import { memberPublicView, sanitizeOverrides, DASHBOARD_IDS } from '../services/board-rbac.js';
import { enrollMemberInCompanyChannels } from '../services/staff-chat-service.js';
import { sendEmail } from '../utils/mailer.js';
import { isMailConfigured } from '../services/email-service.js';

const STRUG_DOMAIN = '@strug.ca';

const router = express.Router();

// Staff lifecycle requires the manage_members capability. The role/access endpoints below
// additionally require super-admin (layered per-route).
router.use(authenticateBoard, requireManageMembers);

// Tasks that still count toward a member's load (everything not finished/archived).
const OPEN_TASK_STATUSES = ['backlog', 'in_progress', 'ready_for_review', 'changes_requested', 'approved', 'on_staging'];

// Batch-load roles for a set of members and return role-enriched public views. Optionally
// attaches open_task_count.
async function viewMembers(members, { withCounts = false } = {}) {
  if (members.length === 0) return [];
  const roleIds = [...new Set(members.map((m) => m.role_id).filter((x) => x != null))];
  const roles = roleIds.length
    ? await prisma.board_role.findMany({ where: { role_id: { in: roleIds } } })
    : [];
  const roleMap = new Map(roles.map((r) => [r.role_id, r]));

  let counts = new Map();
  if (withCounts) {
    const grouped = await prisma.board_task.groupBy({
      by: ['assignee_id'],
      where: { assignee_id: { in: members.map((m) => m.member_id) }, status: { in: OPEN_TASK_STATUSES } },
      _count: { _all: true },
    });
    counts = new Map(grouped.map((g) => [g.assignee_id, g._count._all]));
  }

  return members.map((m) => {
    const view = memberPublicView(m, roleMap.get(m.role_id) || null);
    return withCounts ? { ...view, open_task_count: counts.get(m.member_id) || 0 } : view;
  });
}

// GET /board/members/pending
router.get('/pending', async (_req, res) => {
  try {
    const pending = await prisma.board_member.findMany({
      where: { status: 'pending' },
      orderBy: { created_at: 'asc' },
    });
    return res.status(200).json({ successful: true, members: await viewMembers(pending) });
  } catch (err) {
    console.error('[board-members] pending error:', err);
    return res.status(500).json({ successful: false, message: 'Could not load pending signups' });
  }
});

// GET /board/members
router.get('/', async (_req, res) => {
  try {
    const members = await prisma.board_member.findMany({
      orderBy: [{ status: 'asc' }, { created_at: 'asc' }],
    });
    return res.status(200).json({ successful: true, members: await viewMembers(members, { withCounts: true }) });
  } catch (err) {
    console.error('[board-members] list error:', err);
    return res.status(500).json({ successful: false, message: 'Could not load members' });
  }
});

// Resolve a role by key or id; returns the role row or null.
async function resolveRole({ role_key, role_id }) {
  if (role_id != null) return prisma.board_role.findUnique({ where: { role_id } });
  if (role_key) return prisma.board_role.findUnique({ where: { key: role_key } });
  return null;
}

// POST /board/members — admin-create an already-approved member with a starting role.
// Assigning a super-admin role requires the caller to be a super-admin.
const createSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
  email: z.string().trim().toLowerCase().email('A valid email is required').max(255),
  password: z.string().min(8, 'Temporary password must be at least 8 characters').max(200),
  role_key: z.string().trim().min(1).max(60).optional(),
});
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  const { name, email, password } = parsed.data;
  const roleKey = parsed.data.role_key || 'member';
  if (!email.endsWith(STRUG_DOMAIN)) {
    return res.status(400).json({ successful: false, message: 'A @strug.ca email address is required.' });
  }
  try {
    const role = await resolveRole({ role_key: roleKey });
    if (!role) return res.status(400).json({ successful: false, message: `Unknown role "${roleKey}"` });
    if (role.is_super_admin && !req.member?.is_super_admin) {
      return res.status(403).json({ successful: false, message: 'Only a super-admin can grant the Super Admin role.' });
    }
    const existing = await prisma.board_member.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ successful: false, message: 'A member with this email already exists.' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const created = await prisma.board_member.create({
      data: {
        name,
        email,
        password: hashed,
        status: 'approved',
        approved_by: req.member.member_id,
        approved_at: new Date(),
        role_id: role.role_id,
        is_super_admin: !!role.is_super_admin,
      },
    });
    // Company channels are org-wide — enroll the new member so they show up in #general/#random.
    enrollMemberInCompanyChannels(created.member_id).catch((e) => console.error('[board-members] enroll error:', e));

    if (isMailConfigured()) {
      const boardBase = (process.env.BOARD_URL || process.env.MARKETING_URL || 'https://strug.ca').replace(/\/$/, '');
      const board_url = boardBase.endsWith('/board') ? boardBase : `${boardBase}/board`;
      sendEmail(
        'board-invite',
        {
          name,
          email,
          temp_password: password,
          role_label: role.name || role.key || roleKey,
          board_url,
        },
        email,
        'emails.board_invite.subject',
        'en',
      ).catch((e) => console.error('[board-members] invite email failed:', e.message));
    }

    return res.status(201).json({ successful: true, member: memberPublicView(created, role) });
  } catch (err) {
    console.error('[board-members] create error:', err);
    return res.status(500).json({ successful: false, message: 'Could not create member' });
  }
});

// PATCH /board/members/:id/approve — approve a pending signup (status only; access is
// granted separately via a role).
router.patch('/:id/approve', async (req, res) => {
  const memberId = Number(req.params.id);
  if (!Number.isInteger(memberId)) {
    return res.status(400).json({ successful: false, message: 'Invalid member id' });
  }
  try {
    const member = await prisma.board_member.findUnique({ where: { member_id: memberId } });
    if (!member) return res.status(404).json({ successful: false, message: 'Member not found' });

    const updated = await prisma.board_member.update({
      where: { member_id: memberId },
      data: { status: 'approved', approved_by: req.member.member_id, approved_at: new Date() },
    });
    await prisma.board_notification.create({
      data: { member_id: memberId, type: 'account_approved', body: 'Your board account has been approved. Welcome aboard!' },
    });
    enrollMemberInCompanyChannels(memberId).catch((e) => console.error('[board-members] enroll error:', e));
    const role = updated.role_id ? await prisma.board_role.findUnique({ where: { role_id: updated.role_id } }) : null;
    return res.status(200).json({ successful: true, member: memberPublicView(updated, role) });
  } catch (err) {
    console.error('[board-members] approve error:', err);
    return res.status(500).json({ successful: false, message: 'Could not approve member' });
  }
});

// PATCH /board/members/:id/role — assign a role (SUPER-ADMIN only). Assigning a role gives
// the member that role's access and clears any per-member custom overrides. Super-admin is
// granted/revoked here via a role that carries is_super_admin.
const roleSchema = z.object({
  role_key: z.string().trim().min(1).max(60).optional(),
  role_id: z.number().int().optional(),
}).refine((d) => d.role_key || d.role_id != null, { message: 'Provide role_key or role_id' });
router.patch('/:id/role', requireSuperAdmin, async (req, res) => {
  const memberId = Number(req.params.id);
  if (!Number.isInteger(memberId)) {
    return res.status(400).json({ successful: false, message: 'Invalid member id' });
  }
  const parsed = roleSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  try {
    const member = await prisma.board_member.findUnique({ where: { member_id: memberId } });
    if (!member) return res.status(404).json({ successful: false, message: 'Member not found' });
    const role = await resolveRole(parsed.data);
    if (!role) return res.status(400).json({ successful: false, message: 'Unknown role' });

    // Guard against self-lockout: a super-admin can't drop their own super-admin.
    if (member.member_id === req.member.member_id && member.is_super_admin && !role.is_super_admin) {
      return res.status(400).json({ successful: false, message: 'You cannot remove your own super-admin access.' });
    }

    const updated = await prisma.board_member.update({
      where: { member_id: memberId },
      data: { role_id: role.role_id, is_super_admin: !!role.is_super_admin, access_overrides: null },
    });
    return res.status(200).json({ successful: true, member: memberPublicView(updated, role) });
  } catch (err) {
    console.error('[board-members] role error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update role' });
  }
});

// PATCH /board/members/:id/access — hand-tune per-dashboard access ("Custom") on top of the
// member's role (SUPER-ADMIN only). Body: { access: { dashboardId: "none"|"read"|"write" } }.
const accessSchema = z.object({
  access: z.record(z.string(), z.enum(['none', 'read', 'write'])),
});
router.patch('/:id/access', requireSuperAdmin, async (req, res) => {
  const memberId = Number(req.params.id);
  if (!Number.isInteger(memberId)) {
    return res.status(400).json({ successful: false, message: 'Invalid member id' });
  }
  const parsed = accessSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ successful: false, message: 'Provide an access map of dashboardId -> none|read|write' });
  }
  const overrides = sanitizeOverrides(parsed.data.access);
  const unknown = Object.keys(parsed.data.access).filter((k) => !DASHBOARD_IDS.includes(k));
  if (unknown.length) {
    return res.status(400).json({ successful: false, message: `Unknown dashboard(s): ${unknown.join(', ')}` });
  }
  try {
    const member = await prisma.board_member.findUnique({ where: { member_id: memberId } });
    if (!member) return res.status(404).json({ successful: false, message: 'Member not found' });
    const updated = await prisma.board_member.update({
      where: { member_id: memberId },
      data: { access_overrides: Object.keys(overrides).length ? overrides : null },
    });
    const role = updated.role_id ? await prisma.board_role.findUnique({ where: { role_id: updated.role_id } }) : null;
    return res.status(200).json({ successful: true, member: memberPublicView(updated, role) });
  } catch (err) {
    console.error('[board-members] access error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update access' });
  }
});

// PATCH /board/members/:id/reject
router.patch('/:id/reject', async (req, res) => {
  const memberId = Number(req.params.id);
  if (!Number.isInteger(memberId)) {
    return res.status(400).json({ successful: false, message: 'Invalid member id' });
  }
  try {
    const member = await prisma.board_member.findUnique({ where: { member_id: memberId } });
    if (!member) return res.status(404).json({ successful: false, message: 'Member not found' });
    const updated = await prisma.board_member.update({ where: { member_id: memberId }, data: { status: 'rejected' } });
    const role = updated.role_id ? await prisma.board_role.findUnique({ where: { role_id: updated.role_id } }) : null;
    return res.status(200).json({ successful: true, member: memberPublicView(updated, role) });
  } catch (err) {
    console.error('[board-members] reject error:', err);
    return res.status(500).json({ successful: false, message: 'Could not reject member' });
  }
});

// PATCH /board/members/:id/deactivate
router.patch('/:id/deactivate', async (req, res) => {
  const memberId = Number(req.params.id);
  if (!Number.isInteger(memberId)) {
    return res.status(400).json({ successful: false, message: 'Invalid member id' });
  }
  if (memberId === req.member.member_id) {
    return res.status(400).json({ successful: false, message: 'You cannot deactivate your own account' });
  }
  try {
    const member = await prisma.board_member.findUnique({ where: { member_id: memberId } });
    if (!member) return res.status(404).json({ successful: false, message: 'Member not found' });
    const updated = await prisma.board_member.update({ where: { member_id: memberId }, data: { status: 'deactivated' } });
    const role = updated.role_id ? await prisma.board_role.findUnique({ where: { role_id: updated.role_id } }) : null;
    return res.status(200).json({ successful: true, member: memberPublicView(updated, role) });
  } catch (err) {
    console.error('[board-members] deactivate error:', err);
    return res.status(500).json({ successful: false, message: 'Could not deactivate member' });
  }
});

export default router;
