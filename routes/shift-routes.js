import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';
import mailerEvents from '../utils/mailer-event.js';
import { decrypt } from '../utils/crypto.js';
import { formatShiftTimeForEmail } from '../utils/shift-time-format.js';

const router = express.Router();

// HR shift records. Admin-only (same lockdown as /employee, #1285 follow-up).
router.use(authenticateToken, requireAdmin);

/* GET ALL SHIFTS */
router.get('/', async (_req, res) => {
  try {
    const shifts = await prisma.shift.findMany({
      orderBy: { shift_id: 'desc' },
      include: {
        employees: true,
      },
    });

    res.json(shifts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch shifts' });
  }
});

/* GET SHIFTS BY EMPLOYEE ID — before /:shift_id so "employee" is not parsed as an id */
router.get('/employee/:employee_id', async (req, res) => {
  try {
    const employee_id = Number(req.params.employee_id);

    if (Number.isNaN(employee_id)) {
      return res.status(400).json({ error: 'employee_id must be a number' });
    }

    const shifts = await prisma.shift.findMany({
      where: { employee_id },
      include: {
        employees: true,
      },
    });

    res.json(shifts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch shifts for employee' });
  }
});

/* GET SHIFT BY ID */
router.get('/:shift_id', async (req, res) => {
  try {
    const shift_id = Number(req.params.shift_id);

    if (Number.isNaN(shift_id)) {
      return res.status(400).json({ error: 'shift_id must be a number' });
    }

    const shift = await prisma.shift.findUnique({
      where: { shift_id },
      include: {
        employees: true,
      },
    });

    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }

    res.json(shift);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch shift' });
  }
});

/* CREATE SHIFT */
router.post('/', async (req, res) => {
  try {
    const { employee_id, from_time, to_time } = req.body;

    const shift = await prisma.shift.create({
      data: {
        employee_id,
        from_time: from_time ? new Date(from_time) : undefined,
        to_time: to_time ? new Date(to_time) : undefined,
      },
      include: {
        employees: true,
      },
    });

    res.status(201).json(shift);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create shift' });
  }
});

/**
 * UPDATE SHIFT
 * Updates DB and notifies employee via email
 * PUT /shift/:shift_id
 */
router.put('/:shift_id', async (req, res) => {
  try {
    const shift_id = Number(req.params.shift_id);
    const { from_time, to_time } = req.body;

    const updatedShift = await prisma.shift.update({
      where: { shift_id },
      data: {
        from_time: from_time ? new Date(from_time) : undefined,
        to_time: to_time ? new Date(to_time) : undefined,
      },
      include: {
        employees: {
          include: {
            user: { select: { email: true, language: true } },
          },
        },
      },
    });

    if (updatedShift.employees?.user?.email) {
      try {
        const plainEmail = decrypt(updatedShift.employees.user.email);

        mailerEvents.emit('send_email', {
          templateName: 'shift-update',
          variables: {
            from_time: formatShiftTimeForEmail(updatedShift.from_time),
            to_time: formatShiftTimeForEmail(updatedShift.to_time),
          },
          to: plainEmail,
          subjectKey: 'emails.shift_update.subject',
          user: updatedShift.employees.user,
        });
      } catch (mailErr) {
        console.error('Shift alert email failed:', mailErr.message);
      }
    }

    res.json({ successful: true, message: 'Shift updated and employee notified.', data: updatedShift });
  } catch (err) {
    console.error('Update Shift Error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* DELETE SHIFT */
router.delete('/:shift_id', async (req, res) => {
  try {
    const shift_id = Number(req.params.shift_id);

    if (Number.isNaN(shift_id)) {
      return res.status(400).json({ error: 'shift_id must be a number' });
    }

    await prisma.shift.delete({
      where: { shift_id },
    });

    res.json({ message: 'Shift deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete shift' });
  }
});

export default router;
