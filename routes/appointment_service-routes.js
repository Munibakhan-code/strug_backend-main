/**
 * DEPRECATED — not mounted in app.js.
 * Doctors portal “Add Service” uses /service-type and /service-category (api/services.js),
 * not this appointment_service catalog. See docs/medical-maturity-audit.md Phase 1.
 */
// routes/appointmentService.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all appointment services
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const services = await prisma.appointment_service.findMany({
      orderBy: { service_id: 'desc' },
      include: {
        appointment_service_category: true,
      },
    });

    res.json(services);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch appointment services' });
  }
});

/**
 * Get single appointment service by service_id
 */
router.get('/:service_id', authenticateToken, async (req, res) => {
  try {
    const service = await prisma.appointment_service.findUnique({
      where: { service_id: Number(req.params.service_id) },
      include: {
        appointment_service_category: true,
      },
    });

    if (!service) return res.status(404).json({ error: 'Appointment service not found' });

    res.json(service);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch appointment service' });
  }
});

/**
 * Create new appointment service
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      service_name,
      service_description,
      service_price,
      service_image_url,
      service_category_id,
    } = req.body;

    if (!service_name || !service_price) {
      return res.status(400).json({ error: 'service_name and service_price are required' });
    }

    const newService = await prisma.appointment_service.create({
      data: {
        service_name,
        service_description,
        service_price: Number(service_price),
        service_image_url,
        service_category_id: service_category_id ? Number(service_category_id) : null,
      },
    });

    io?.emit('appointment-service-created', newService);

    res.status(201).json(newService);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create appointment service' });
  }
});

/**
 * Update appointment service
 */
router.put('/:service_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { service_id } = req.params;
    const {
      service_name,
      service_description,
      service_price,
      service_image_url,
      service_category_id,
    } = req.body;

    const existing = await prisma.appointment_service.findUnique({
      where: { service_id: Number(service_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Appointment service not found' });

    const updatedService = await prisma.appointment_service.update({
      where: { service_id: Number(service_id) },
      data: {
        service_name: service_name ?? existing.service_name,
        service_description: service_description ?? existing.service_description,
        service_price: service_price != null ? Number(service_price) : existing.service_price,
        service_image_url: service_image_url ?? existing.service_image_url,
        service_category_id: service_category_id ? Number(service_category_id) : existing.service_category_id,
      },
    });

    io?.emit('appointment-service-updated', updatedService);

    res.json(updatedService);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update appointment service' });
  }
});

/**
 * Delete appointment service
 */
router.delete('/:service_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.appointment_service.delete({
      where: { service_id: Number(req.params.service_id) },
    });

    io?.emit('appointment-service-deleted', { service_id: deleted.service_id });

    res.json({ message: 'Appointment service deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete appointment service' });
  }
});

export default router;