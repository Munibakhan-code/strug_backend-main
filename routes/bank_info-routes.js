// routes/bankInfo.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';

const router = express.Router();

// NOTE: this router is currently NOT mounted in app.js. It exposes employee bank account
// numbers, so reads are admin-only as defense-in-depth in case it is ever wired up.

/**
 * Get all bank info records
 */
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const bankInfos = await prisma.bank_info.findMany({
      orderBy: { bank_info_id: 'desc' },
      include: {
        employees: true,
      },
    });

    res.json(bankInfos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch bank info' });
  }
});

/**
 * Get single bank info by bank_info_id
 */
router.get('/:bank_info_id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const bankInfo = await prisma.bank_info.findUnique({
      where: { bank_info_id: Number(req.params.bank_info_id) },
      include: {
        employees: true,
      },
    });

    if (!bankInfo) return res.status(404).json({ error: 'Bank info not found' });

    res.json(bankInfo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch bank info' });
  }
});

/**
 * Create new bank info
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      employee_id,
      account_holder,
      account_type,
      bank_name,
      bank_account_number,
      bank_branch,
    } = req.body;

    if (!employee_id || !bank_account_number) {
      return res.status(400).json({ error: 'employee_id and bank_account_number are required' });
    }

    const newBankInfo = await prisma.bank_info.create({
      data: {
        employee_id: Number(employee_id),
        account_holder,
        account_type,
        bank_name,
        bank_account_number,
        bank_branch,
      },
    });

    io?.emit('bank-info-created', newBankInfo);

    res.status(201).json(newBankInfo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create bank info' });
  }
});

/**
 * Update bank info
 */
router.put('/:bank_info_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { bank_info_id } = req.params;
    const {
      employee_id,
      account_holder,
      account_type,
      bank_name,
      bank_account_number,
      bank_branch,
    } = req.body;

    // Opt bank_account_number back in for merge-on-update (global omit #1292).
    const existing = await prisma.bank_info.findUnique({
      where: { bank_info_id: Number(bank_info_id) },
      omit: { bank_account_number: false },
    });

    if (!existing) return res.status(404).json({ error: 'Bank info not found' });

    const updatedBankInfo = await prisma.bank_info.update({
      where: { bank_info_id: Number(bank_info_id) },
      data: {
        employee_id: employee_id ? Number(employee_id) : existing.employee_id,
        account_holder: account_holder ?? existing.account_holder,
        account_type: account_type ?? existing.account_type,
        bank_name: bank_name ?? existing.bank_name,
        bank_account_number: bank_account_number ?? existing.bank_account_number,
        bank_branch: bank_branch ?? existing.bank_branch,
      },
      omit: { bank_account_number: true },
    });

    io?.emit('bank-info-updated', updatedBankInfo);

    res.json(updatedBankInfo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update bank info' });
  }
});

/**
 * Delete bank info
 */
router.delete('/:bank_info_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.bank_info.delete({
      where: { bank_info_id: Number(req.params.bank_info_id) },
    });

    io?.emit('bank-info-deleted', { bank_info_id: deleted.bank_info_id });

    res.json({ message: 'Bank info deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete bank info' });
  }
});

export default router;