import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import { recordProfileChange } from '../services/profile-history.js';

const router = express.Router();
router.use(authenticateToken, requireAdmin);

// ─── GET ALL USERS (paginated + search) ───────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', verified, banned } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const hasFilter =
      search ||
      verified === 'true' ||
      verified === 'false' ||
      banned === 'true' ||
      banned === 'false';

    const where = hasFilter
      ? {
          social_profiles: {
            some: {
              ...(search && {
                OR: [
                  { handle: { contains: search, mode: 'insensitive' } },
                  { display_name: { contains: search, mode: 'insensitive' } },
                ],
              }),
              ...((verified === 'true' || verified === 'false') && {
                is_verified: verified === 'true',
              }),
              ...((banned === 'true' || banned === 'false') && {
                is_banned: banned === 'true',
              }),
            },
          },
        }
      : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: parseInt(limit),
        select: {
          user_id: true,
          name: true,
          email: true,
          username: true,
          role: true,
          social_profiles: {
            select: {
              profile_id: true,
              handle: true,
              display_name: true,
              profile_pic_url: true,
              is_verified: true,
              verification_type: true,
              is_banned: true,
              is_shadow_banned: true,
              created_at: true,
            },
          },
        },
        orderBy: { user_id: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      users,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET SINGLE USER DETAIL ────────────────────────────────────────────────────
router.get('/users/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { user_id: parseInt(req.params.id) },
      select: {
        user_id: true,
        name: true,
        email: true,
        username: true,
        role: true,
        social_profiles: {
          select: {
            profile_id: true,
            handle: true,
            display_name: true,
            bio: true,
            profile_pic_url: true,
            banner_url: true,
            is_verified: true,
            verification_type: true,
            is_banned: true,
            is_shadow_banned: true,
            is_private: true,
            created_at: true,
            updated_at: true,
          },
        },
      },
    });

    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── VERIFY USER + ASSIGN BADGE ───────────────────────────────────────────────
router.patch('/users/:id/verify', async (req, res) => {
  try {
    const { is_verified, verification_type } = req.body;
    const userId = parseInt(req.params.id);
    const before = await prisma.social_profile.findFirst({
      where: { user_id: userId },
      select: { is_verified: true, verification_type: true },
    });
    const profile = await prisma.social_profile.update({
      where: { user_id: userId },
      data: { is_verified, verification_type },
      select: { profile_id: true, is_verified: true, verification_type: true },
    });
    // Record the verification change for User Management → Verification History.
    const fmt = (v) => `${v?.is_verified ? 'verified' : 'unverified'}${v?.verification_type && v.verification_type !== 'NONE' ? ` · ${v.verification_type}` : ''}`;
    recordProfileChange(userId, 'verification', fmt(before), fmt(profile), { changedBy: 'admin', actorId: req.user?.user_id });
    res.json({ message: 'Verification updated', profile });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── BAN / UNBAN USER ─────────────────────────────────────────────────────────
router.patch('/users/:id/ban', async (req, res) => {
  try {
    const { is_banned } = req.body;
    const profile = await prisma.social_profile.update({
      where: { user_id: parseInt(req.params.id) },
      data: { is_banned },
      select: { profile_id: true, is_banned: true },
    });
    res.json({ message: `User ${is_banned ? 'banned' : 'unbanned'}`, profile });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── SHADOW BAN / UNBAN ───────────────────────────────────────────────────────
router.patch('/users/:id/shadow-ban', async (req, res) => {
  try {
    const { is_shadow_banned } = req.body;
    const profile = await prisma.social_profile.update({
      where: { user_id: parseInt(req.params.id) },
      data: { is_shadow_banned },
      select: { profile_id: true, is_shadow_banned: true },
    });
    res.json({ message: `Shadow ban ${is_shadow_banned ? 'applied' : 'removed'}`, profile });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── CHANGE USER ROLE ─────────────────────────────────────────────────────────
router.patch('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body; // USER | MODERATOR | ADMIN
    const user = await prisma.user.update({
      where: { user_id: parseInt(req.params.id) },
      data: { role },
      select: { user_id: true, role: true },
    });
    res.json({ message: 'Role updated', user });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;