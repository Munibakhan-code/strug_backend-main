import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';

const router = express.Router();

router.use(authenticateToken, requireAdmin);

/**
 * Get all employee attendance records
 */
router.get('/', async (_req, res) => {
  try {
    const attendance = await prisma.employee_attendance.findMany({
      orderBy: { employee_attendance_id: 'desc' },
      include: { employees: true },
      take: 500,
    });

    res.json(attendance);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch employee attendance' });
  }
});

/**
 * Get a single employee attendance record
 */
router.get('/:employee_attendance_id', async (req, res) => {
  try {
    const record = await prisma.employee_attendance.findUnique({
      where: { employee_attendance_id: Number(req.params.employee_attendance_id) },
      include: { employees: true },
    });

    if (!record) return res.status(404).json({ error: 'Attendance record not found' });

    res.json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch attendance record' });
  }
});

/**
 * Create a new attendance record
 */
router.post('/', async (req, res) => {
  const io = req.app.get('io');

  try {
    const { employee_id, clock_in, clock_out } = req.body;

    if (!employee_id || !clock_in) {
      return res.status(400).json({ error: 'employee_id and clock_in are required' });
    }

    const newRecord = await prisma.employee_attendance.create({
      data: {
        employee_id,
        clock_in: new Date(clock_in),
        clock_out: clock_out ? new Date(clock_out) : null,
      },
    });

    io?.emit('employee-attendance-created', newRecord);

    res.status(201).json(newRecord);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create attendance record' });
  }
});

/**
 * Update an attendance record
 */
router.put('/:employee_attendance_id', async (req, res) => {
  const io = req.app.get('io');

  try {
    const { employee_attendance_id } = req.params;
    const { employee_id, clock_in, clock_out } = req.body;

    const existing = await prisma.employee_attendance.findUnique({
      where: { employee_attendance_id: Number(employee_attendance_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Attendance record not found' });

    const updatedRecord = await prisma.employee_attendance.update({
      where: { employee_attendance_id: Number(employee_attendance_id) },
      data: {
        employee_id,
        clock_in: clock_in ? new Date(clock_in) : existing.clock_in,
        clock_out: clock_out ? new Date(clock_out) : existing.clock_out,
      },
    });

    io?.emit('employee-attendance-updated', updatedRecord);

    res.json(updatedRecord);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update attendance record' });
  }
});

/**
 * Delete an attendance record
 */
router.delete('/:employee_attendance_id', async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.employee_attendance.delete({
      where: { employee_attendance_id: Number(req.params.employee_attendance_id) },
    });

    io?.emit('employee-attendance-deleted', { employee_attendance_id: deleted.employee_attendance_id });

    res.json({ message: 'Attendance record deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete attendance record' });
  }
});

export default router;
