// routes/board-auth-routes.js
//
// Authentication for the internal Task Board (strug.ca/board). A dedicated
// `board_member` population for dev staff — separate from app `user` and the bare
// `admin` table. See task-board-implementation-plan.md (M1).
//
//   POST  /board-auth/signup   (public)  self-register; @strug.ca only; status="pending"
//   POST  /board-auth/login    (public)  approved members only; issues a board JWT
//   GET   /board-auth/me        (board)   current member + capabilities
//   POST  /board-auth/logout   (public)  stateless ack (frontend clears the cookie)
//
// Self-serve signup is disabled (invite-only). Email verification is not used for v1:
// @strug.ca domain restriction + admin create/approve is the trust gate. Mail is up;
// new members get a branded board-invite when an admin creates their account.

import express from 'express';
import bcrypt from 'bcrypt';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { boardToken } from '../utils/jwt-helper.js';
import { authenticateBoard } from '../middleware/authenticate-board.js';
import { memberPublicView } from '../services/board-rbac.js';
import { uploadPublicBlob, isAzureStorageConfigured } from '../utils/azure-storage.js';
import { checkRateLimit, isRateLimited } from '../utils/rate-limiter.js';
import { validatePasswordStrength } from '../utils/password-policy.js';
import { clientIp } from '../services/activity-log.js';

const router = express.Router();

// Self-serve avatar upload: small images only, held in memory then pushed to a
// public-read Azure blob container (initials remain the fallback when unset).
const AVATAR_CONTAINER = process.env.AZURE_BOARD_AVATAR_CONTAINER || 'board-avatars';
const AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required').max(255),
  password: z.string().min(1, 'Password is required').max(200),
});

// Shape the member object returned to the client — never the password hash.
function publicMember(m) {
  return {
    member_id: m.member_id,
    name: m.name,
    email: m.email,
    status: m.status,
    can_assign: m.can_assign,
    can_review: m.can_review,
    can_manage_members: m.can_manage_members,
    can_view_users: m.can_view_users,
    can_access_restricted: m.can_access_restricted,
    is_super_admin: m.is_super_admin,
  };
}

// POST /board-auth/signup — DISABLED. The board is invite-only: an admin creates
// members via POST /board/members (requireManageMembers). Public self-serve signup is
// closed. The route is kept (rather than removed) so any stale client gets a clean 403
// instead of a 404. See routes/board-members-routes.js for the admin-create flow.
router.post('/signup', (_req, res) => {
  return res.status(403).json({
    successful: false,
    message: 'Self-serve signup is disabled. The board is invite-only — an administrator must create your account.',
  });
});

// POST /board-auth/login
router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  const { email, password } = parsed.data;
  const emailKey = String(email || '').trim().toLowerCase();
  const ip = clientIp(req) || 'unknown';

  try {
    if (await isRateLimited(`rl:board-login:${emailKey}`, 5) || await isRateLimited(`rl:board-login:ip:${ip}`, 30)) {
      return res.status(429).json({ successful: false, message: 'Too many login attempts. Try again later.' });
    }

    // opt back in to the password column (globally omitted) so we can bcrypt.compare it.
    const member = await prisma.board_member.findUnique({ where: { email }, omit: { password: false } });
    // Generic message on missing user OR bad password — don't reveal which.
    if (!member) {
      await checkRateLimit(`rl:board-login:${emailKey}`, 5, 900);
      await checkRateLimit(`rl:board-login:ip:${ip}`, 30, 900);
      return res.status(401).json({ successful: false, message: 'Incorrect email or password' });
    }

    const ok = await bcrypt.compare(password, member.password);
    if (!ok) {
      await checkRateLimit(`rl:board-login:${emailKey}`, 5, 900);
      await checkRateLimit(`rl:board-login:ip:${ip}`, 30, 900);
      return res.status(401).json({ successful: false, message: 'Incorrect email or password' });
    }

    if (member.status !== 'approved') {
      const messages = {
        pending: 'Your account is awaiting supervisor approval.',
        rejected: 'Your account request was not approved.',
        deactivated: 'Your account has been deactivated.',
      };
      return res.status(403).json({
        successful: false,
        status: member.status,
        message: messages[member.status] || 'Your account is not active.',
      });
    }

    const role = member.role_id
      ? await prisma.board_role.findUnique({ where: { role_id: member.role_id } })
      : null;
    const accessToken = boardToken(member);
    return res.status(200).json({
      successful: true,
      accessToken,
      member: memberPublicView(member, role),
    });
  } catch (err) {
    console.error('[board-auth] login error:', err);
    return res.status(500).json({ successful: false, message: 'Could not sign in' });
  }
});

// GET /board-auth/me
router.get('/me', authenticateBoard, (req, res) => {
  return res.status(200).json({ successful: true, member: memberPublicView(req.member, req.memberRole) });
});

const profileSchema = z.object({
  name: z.string().trim().min(1, 'Display name is required').max(60, 'Display name must be 60 characters or fewer'),
});

// PATCH /board-auth/me — update your own display name (the username shown on the board).
// Email, status and capabilities are NOT editable here; only the member themselves can rename.
router.patch('/me', authenticateBoard, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  try {
    const updated = await prisma.board_member.update({
      where: { member_id: req.member.member_id },
      data: { name: parsed.data.name },
    });
    return res.status(200).json({ successful: true, member: memberPublicView(updated, req.memberRole) });
  } catch (err) {
    console.error('[board-auth] profile update error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update your profile' });
  }
});

// POST /board-auth/me/avatar — upload your own profile picture (multipart field: "avatar").
// Validates the real file signature (not just the client MIME), stores it in a public blob,
// and points board_member.avatar_url at it. Returns the refreshed member.
router.post('/me/avatar', authenticateBoard, avatarUpload.single('avatar'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ successful: false, message: 'No image was uploaded' });
    }
    if (!isAzureStorageConfigured()) {
      return res.status(503).json({ successful: false, message: 'Image storage is not configured' });
    }
    const type = await fileTypeFromBuffer(req.file.buffer);
    if (!type || !AVATAR_MIME.has(type.mime)) {
      return res.status(400).json({ successful: false, message: 'Only JPEG, PNG, WebP or GIF images are allowed' });
    }
    const blobName = `member-${req.member.member_id}/${Date.now()}.${type.ext}`;
    const url = await uploadPublicBlob(AVATAR_CONTAINER, blobName, req.file.buffer, type.mime);
    const updated = await prisma.board_member.update({
      where: { member_id: req.member.member_id },
      data: { avatar_url: url },
    });
    return res.status(200).json({ successful: true, member: memberPublicView(updated, req.memberRole) });
  } catch (err) {
    console.error('[board-auth] avatar upload error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update your profile picture' });
  }
});

// DELETE /board-auth/me/avatar — clear it and fall back to initials.
router.delete('/me/avatar', authenticateBoard, async (req, res) => {
  try {
    const updated = await prisma.board_member.update({
      where: { member_id: req.member.member_id },
      data: { avatar_url: null },
    });
    return res.status(200).json({ successful: true, member: memberPublicView(updated, req.memberRole) });
  } catch (err) {
    console.error('[board-auth] avatar remove error:', err);
    return res.status(500).json({ successful: false, message: 'Could not remove your profile picture' });
  }
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(200),
});

// PATCH /board-auth/password — self-serve password change. Verifies the current
// password (bcrypt) then stores a new hash. Lets members (incl. accounts created with a
// temporary password) change their own password.
router.patch('/password', authenticateBoard, async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  const { currentPassword, newPassword } = parsed.data;
  const strength = validatePasswordStrength(newPassword);
  if (strength.length) {
    return res.status(400).json({
      successful: false,
      message: `Password must include ${strength.join(', ')}`,
    });
  }
  try {
    // opt the globally-omitted password column back in to compare it.
    const row = await prisma.board_member.findUnique({ where: { member_id: req.member.member_id }, omit: { password: false } });
    const ok = row?.password ? await bcrypt.compare(currentPassword, row.password) : false;
    if (!ok) return res.status(401).json({ successful: false, message: 'Current password is incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    const updated = await prisma.board_member.update({
      where: { member_id: req.member.member_id },
      data: { password: hashed },
      omit: { password: false },
    });
    // Re-issue so this device stays signed in; other devices' old pwd_fp tokens fail.
    const accessToken = boardToken(updated);
    return res.status(200).json({ successful: true, message: 'Password updated', accessToken });
  } catch (err) {
    console.error('[board-auth] password change error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update password' });
  }
});

// POST /board-auth/logout — stateless; the frontend proxy clears the cookie.
router.post('/logout', (_req, res) => {
  return res.status(200).json({ successful: true });
});

export default router;
