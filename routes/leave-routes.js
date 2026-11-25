import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin, requireAdmin } from '../middleware/require-admin.js';
import mailerEvents from '../utils/mailer-event.js';
import { decrypt } from '../utils/crypto.js';

const router = express.Router();

// Authenticated for all leave routes. List / detail / status updates stay admin-only;
// employees may POST their own leave request (#1298 review).
router.use(authenticateToken);

/* GET ALL LEAVES — admin */
router.get('/', requireAdmin, async (_req, res) => {
  try {
    const leaves = await prisma.leave.findMany({
      orderBy: { leave_id: 'desc' },
      include: {
        employees: {
          include: {
            user: { select: { user_id: true, name: true } },
          },
        },
      },
    });
    res.json(leaves);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch leaves' });
  }
});

/* GET LEAVE BY ID — admin */
router.get('/:id', requireAdmin, async (req, res) => {
  try {
    const leave = await prisma.leave.findUnique({
      where: { leave_id: parseInt(req.params.id, 10) },
      include: {
        employees: {
          include: {
            user: { select: { user_id: true, name: true } },
          },
        },
      },
    });

    if (!leave) {
      return res.status(404).json({ error: 'Leave not found' });
    }

    res.json(leave);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch leave' });
  }
});

/* CREATE LEAVE — employee (self) or admin (any employee_id) */
router.post('/', async (req, res) => {
  try {
    const { employee_id, from_date, to_date, type, status } = req.body;

    let resolvedEmployeeId;
    if (isAdmin(req)) {
      resolvedEmployeeId = parseInt(employee_id, 10);
      if (!Number.isInteger(resolvedEmployeeId) || resolvedEmployeeId <= 0) {
        return res.status(400).json({ error: 'employee_id is required' });
      }
    } else {
      const me = await prisma.employees.findFirst({
        where: { employee_user_id: Number(req.user.user_id) },
        select: { employee_id: true },
      });
      if (!me) {
        return res.status(403).json({ error: 'No employee profile linked to this account.' });
      }
      resolvedEmployeeId = me.employee_id;
    }

    const leave = await prisma.leave.create({
      data: {
        employee_id: resolvedEmployeeId,
        from_date: from_date ? new Date(from_date) : null,
        to_date: to_date ? new Date(to_date) : null,
        type,
        // Employees cannot self-approve; admins may set status when creating.
        status: isAdmin(req) ? (status || 'pending') : 'pending',
      },
    });

    res.status(201).json(leave);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create leave' });
  }
});

/**
 * UPDATE LEAVE STATUS (Admin Action)
 * Triggers Email Notification to Employee
 * PUT /leave/:id
 */
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const leave_id = Number(req.params.id);
    const { status, rejection_reason } = req.body;

    if (Number.isNaN(leave_id)) {
      return res.status(400).json({ successful: false, message: 'Invalid leave ID format.' });
    }

    const updatedLeave = await prisma.leave.update({
      where: { leave_id },
      data: {
        status,
        rejection_reason: status === 'rejected' ? rejection_reason : null,
      },
      include: {
        employees: {
          include: {
            user: {
              select: { name: true, email: true, language: true },
            },
          },
        },
      },
    });

    if (updatedLeave.employees?.user?.email) {
      try {
        const plainEmail = decrypt(updatedLeave.employees.user.email);
        const isApproved = updatedLeave.status === 'approved';
        const empUser = updatedLeave.employees?.user;
        const subjectKey = isApproved ? 'emails.leave_status.subject_approved' : 'emails.leave_status.subject_rejected';

        mailerEvents.emit('send_email', {
          templateName: 'leave-status',
          variables: {
            name: updatedLeave.employees.employee_name,
            isApproved,
            from_date: updatedLeave.from_date ? new Date(updatedLeave.from_date).toLocaleDateString() : 'N/A',
            to_date: updatedLeave.to_date ? new Date(updatedLeave.to_date).toLocaleDateString() : 'N/A',
            rejection_reason: updatedLeave.rejection_reason || null,
          },
          to: plainEmail,
          subjectKey,
          user: empUser,
        });

        console.log(`Queueing leave status email for ${plainEmail}`);
      } catch (mailErr) {
        console.error('Email formatting error:', mailErr.message);
      }
    }

    res.json({
      successful: true,
      message: `Leave request has been ${status} successfully.`,
      data: updatedLeave,
    });
  } catch (err) {
    console.error('Update Leave Error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

export default router;
