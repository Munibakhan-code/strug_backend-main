// routes/appointmentServiceCategory.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all appointment service categories
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const categories = await prisma.appointment_service_category.findMany({
      orderBy: { service_category_id: 'asc' },
      include: {
        appointment_service: true,
      },
    });

    res.json(categories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch appointment service categories' });
  }
});

/**
 * Get single appointment service category by service_category_id
 */
router.get('/:service_category_id', authenticateToken, async (req, res) => {
  try {
    const category = await prisma.appointment_service_category.findUnique({
      where: { service_category_id: Number(req.params.service_category_id) },
      include: {
        appointment_service: true,
      },
    });

    if (!category) return res.status(404).json({ error: 'Appointment service category not found' });

    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch appointment service category' });
  }
});

/**
 * Create new appointment service category
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { service_category_name } = req.body;

    if (!service_category_name) {
      return res.status(400).json({ error: 'service_category_name is required' });
    }

    const newCategory = await prisma.appointment_service_category.create({
      data: {
        service_category_name,
      },
    });

    io?.emit('appointment-service-category-created', newCategory);

    res.status(201).json(newCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create appointment service category' });
  }
});

/**
 * Update appointment service category
 */
router.put('/:service_category_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { service_category_id } = req.params;
    const { service_category_name } = req.body;

    const existing = await prisma.appointment_service_category.findUnique({
      where: { service_category_id: Number(service_category_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Appointment service category not found' });

    const updatedCategory = await prisma.appointment_service_category.update({
      where: { service_category_id: Number(service_category_id) },
      data: {
        service_category_name: service_category_name ?? existing.service_category_name,
      },
    });

    io?.emit('appointment-service-category-updated', updatedCategory);

    res.json(updatedCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update appointment service category' });
  }
});

/**
 * Delete appointment service category
 */
router.delete('/:service_category_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.appointment_service_category.delete({
      where: { service_category_id: Number(req.params.service_category_id) },
    });

    io?.emit('appointment-service-category-deleted', { service_category_id: deleted.service_category_id });

    res.json({ message: 'Appointment service category deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete appointment service category' });
  }
});

export default router;