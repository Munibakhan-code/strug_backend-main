// routes/board-roles-routes.js
//
// RBAC v2 role catalog for the internal board. Mounted at /board/roles. Listing requires an
// approved member (so assignment UIs can show the options); creating / editing / deleting
// roles is SUPER-ADMIN only. Built-in roles are read-only (cannot be edited or deleted).
//
//   GET    /board/roles         list all roles (built-in + custom)
//   POST   /board/roles         (super) create a named custom role
//   PATCH  /board/roles/:id     (super) edit a custom role
//   DELETE /board/roles/:id     (super) delete an unused custom role

import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireSuperAdmin } from '../middleware/authenticate-board.js';
import { publicRole, sanitizeAccess } from '../services/board-rbac.js';

const router = express.Router();

router.use(authenticateBoard);

// Slugify a role name into a stable unique key (prefixed so custom roles never collide with
// the built-in keys).
async function uniqueKey(name) {
  const base = 'custom_' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  let key = base || 'custom_role';
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.board_role.findUnique({ where: { key } })) {
    n += 1;
    key = `${base}_${n}`;
  }
  return key;
}

// Keys are validated/sanitized against DASHBOARD_IDS by sanitizeAccess; keep the schema a
// permissive string->level map (an exhaustive enum-keyed record would reject partial maps).
const accessRecord = z.record(z.string(), z.enum(['read', 'write'])).optional();
const roleBodySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(500).optional(),
  access: accessRecord,
  manage_members: z.boolean().optional(),
  review_tasks: z.boolean().optional(),
  assign_tasks: z.boolean().optional(),
  can_create_channels: z.boolean().optional(),
});

// GET /board/roles
router.get('/', async (_req, res) => {
  try {
    const roles = await prisma.board_role.findMany({ orderBy: [{ is_builtin: 'desc' }, { name: 'asc' }] });
    return res.status(200).json({ successful: true, roles: roles.map(publicRole) });
  } catch (err) {
    console.error('[board-roles] list error:', err);
    return res.status(500).json({ successful: false, message: 'Could not load roles' });
  }
});

// POST /board/roles — create a custom role (super-admin only). is_super_admin can never be
// granted through a custom role — that tier is reserved for the built-in Super Admin role.
router.post('/', requireSuperAdmin, async (req, res) => {
  const parsed = roleBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  try {
    const key = await uniqueKey(parsed.data.name);
    const created = await prisma.board_role.create({
      data: {
        key,
        name: parsed.data.name,
        description: parsed.data.description || null,
        is_builtin: false,
        is_super_admin: false,
        access: sanitizeAccess(parsed.data.access),
        manage_members: !!parsed.data.manage_members,
        review_tasks: !!parsed.data.review_tasks,
        assign_tasks: !!parsed.data.assign_tasks,
        can_create_channels: !!parsed.data.can_create_channels,
      },
    });
    return res.status(201).json({ successful: true, role: publicRole(created) });
  } catch (err) {
    console.error('[board-roles] create error:', err);
    return res.status(500).json({ successful: false, message: 'Could not create role' });
  }
});

// PATCH /board/roles/:id — edit a custom role (super-admin only). Built-ins are immutable.
router.patch('/:id', requireSuperAdmin, async (req, res) => {
  const roleId = Number(req.params.id);
  if (!Number.isInteger(roleId)) {
    return res.status(400).json({ successful: false, message: 'Invalid role id' });
  }
  const parsed = roleBodySchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  try {
    const role = await prisma.board_role.findUnique({ where: { role_id: roleId } });
    if (!role) return res.status(404).json({ successful: false, message: 'Role not found' });
    if (role.is_builtin) {
      return res.status(400).json({ successful: false, message: 'Built-in roles cannot be edited.' });
    }
    const data = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.description !== undefined) data.description = parsed.data.description || null;
    if (parsed.data.access !== undefined) data.access = sanitizeAccess(parsed.data.access);
    if (parsed.data.manage_members !== undefined) data.manage_members = parsed.data.manage_members;
    if (parsed.data.review_tasks !== undefined) data.review_tasks = parsed.data.review_tasks;
    if (parsed.data.assign_tasks !== undefined) data.assign_tasks = parsed.data.assign_tasks;
    if (parsed.data.can_create_channels !== undefined) data.can_create_channels = parsed.data.can_create_channels;
    const updated = await prisma.board_role.update({ where: { role_id: roleId }, data });
    return res.status(200).json({ successful: true, role: publicRole(updated) });
  } catch (err) {
    console.error('[board-roles] update error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update role' });
  }
});

// DELETE /board/roles/:id — delete an unused custom role (super-admin only).
router.delete('/:id', requireSuperAdmin, async (req, res) => {
  const roleId = Number(req.params.id);
  if (!Number.isInteger(roleId)) {
    return res.status(400).json({ successful: false, message: 'Invalid role id' });
  }
  try {
    const role = await prisma.board_role.findUnique({ where: { role_id: roleId } });
    if (!role) return res.status(404).json({ successful: false, message: 'Role not found' });
    if (role.is_builtin) {
      return res.status(400).json({ successful: false, message: 'Built-in roles cannot be deleted.' });
    }
    const inUse = await prisma.board_member.count({ where: { role_id: roleId } });
    if (inUse > 0) {
      return res.status(409).json({ successful: false, message: `Role is assigned to ${inUse} member(s). Reassign them first.` });
    }
    await prisma.board_role.delete({ where: { role_id: roleId } });
    return res.status(200).json({ successful: true });
  } catch (err) {
    console.error('[board-roles] delete error:', err);
    return res.status(500).json({ successful: false, message: 'Could not delete role' });
  }
});

export default router;
