// routes/admin.js
import express from 'express';
import bcrypt from 'bcrypt';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';

const router = express.Router();

// H5: strip password from admin record before returning
function safeAdmin(admin) {
  const { password, ...safe } = admin;
  return safe;
}

/**
 * Get all admins
 */
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const admins = await prisma.admin.findMany({ orderBy: { aid: 'asc' } });
    res.json(admins.map(safeAdmin));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Get single admin by aid
 */
router.get('/:aid', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const admin = await prisma.admin.findUnique({ where: { aid: Number(req.params.aid) } });
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    res.json(safeAdmin(admin));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Create new admin
 */
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { name, email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newAdmin = await prisma.admin.create({
      data: { name, email, password: hashedPassword },
    });

    io?.emit('admin-created', { aid: newAdmin.aid, name: newAdmin.name });

    res.status(201).json(safeAdmin(newAdmin));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Update admin
 */
router.put('/:aid', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { aid } = req.params;
    const { name, email, password } = req.body;

    const existing = await prisma.admin.findUnique({ where: { aid: Number(aid) } });
    if (!existing) return res.status(404).json({ error: 'Admin not found' });

    const updatedAdmin = await prisma.admin.update({
      where: { aid: Number(aid) },
      data: {
        name: name ?? existing.name,
        email: email ?? existing.email,
        ...(password ? { password: await bcrypt.hash(password, 10) } : {}),
      },
    });

    io?.emit('admin-updated', { aid: updatedAdmin.aid, name: updatedAdmin.name });
    res.json(safeAdmin(updatedAdmin));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Delete admin
 */
router.delete('/:aid', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.admin.delete({ where: { aid: Number(req.params.aid) } });
    io?.emit('admin-deleted', { aid: deleted.aid });
    res.json({ message: 'Admin deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;