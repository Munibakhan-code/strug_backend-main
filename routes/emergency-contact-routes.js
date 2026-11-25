import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';

const router = express.Router();

// Emergency contacts are HR PII. Admin-only (#1285).
router.use(authenticateToken, requireAdmin);

/**
 * Get all emergency contacts
 */
router.get('/', async (_req, res) => {
  try {
    const contacts = await prisma.emergency_contact.findMany({
      orderBy: { emergency_contact_id: 'asc' },
      include: { employees: { select: { employee_id: true, employee_name: true } } },
      take: 500,
    });

    res.json(contacts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch emergency contacts' });
  }
});

/**
 * Get single emergency contact
 */
router.get('/:emergency_contact_id', async (req, res) => {
  try {
    const emergency_contact_id = Number(req.params.emergency_contact_id);
    if (Number.isNaN(emergency_contact_id)) {
      return res.status(400).json({ error: 'emergency_contact_id must be a number' });
    }

    const contact = await prisma.emergency_contact.findUnique({
      where: { emergency_contact_id },
      include: { employees: true },
    });

    if (!contact) return res.status(404).json({ error: 'Emergency contact not found' });

    res.json(contact);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch emergency contact' });
  }
});

/**
 * Create emergency contact
 */
router.post('/', async (req, res) => {
  try {
    const { employee_id, name, relationship, phone_number, email } = req.body;

    if (!employee_id || !name || !phone_number) {
      return res.status(400).json({ error: 'employee_id, name, and phone_number are required' });
    }

    const newContact = await prisma.emergency_contact.create({
      data: {
        employee_id,
        name,
        relationship,
        phone_number,
        email,
      },
    });

    // No unscoped io.emit of emergency-contact PII.

    res.status(201).json(newContact);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create emergency contact' });
  }
});

/**
 * Update emergency contact
 */
router.put('/:emergency_contact_id', async (req, res) => {
  try {
    const emergency_contact_id = Number(req.params.emergency_contact_id);
    if (Number.isNaN(emergency_contact_id)) {
      return res.status(400).json({ error: 'emergency_contact_id must be a number' });
    }

    const { employee_id, name, relationship, phone_number, email } = req.body;

    const existing = await prisma.emergency_contact.findUnique({
      where: { emergency_contact_id },
    });

    if (!existing) return res.status(404).json({ error: 'Emergency contact not found' });

    const updatedContact = await prisma.emergency_contact.update({
      where: { emergency_contact_id },
      data: { employee_id, name, relationship, phone_number, email },
    });

    res.json(updatedContact);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update emergency contact' });
  }
});

/**
 * Delete emergency contact
 */
router.delete('/:emergency_contact_id', async (req, res) => {
  try {
    const emergency_contact_id = Number(req.params.emergency_contact_id);
    if (Number.isNaN(emergency_contact_id)) {
      return res.status(400).json({ error: 'emergency_contact_id must be a number' });
    }

    await prisma.emergency_contact.delete({
      where: { emergency_contact_id },
    });

    res.json({ message: 'Emergency contact deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete emergency contact' });
  }
});

export default router;
