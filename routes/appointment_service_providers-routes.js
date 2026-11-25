// routes/appointmentServiceProviders.js
import express from 'express';
import bcrypt from 'bcrypt';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

const PROVIDER_SELECT = {
  service_provider_id: true,
  service_provider_user_id: true,
  company_phone_number: true,
  profile_picture: true,
  company_address: true,
  language: true,
  service_type: true,
  specialization: true,
  work_days_from: true,
  work_days_to: true,
  work_hours_from: true,
  work_hours_to: true,
  company_name: true,
  appointment_fee: true,
  // Embed only safe, public user fields — never the full row (email/address/geo leak).
  user: { select: { user_id: true, name: true, username: true } },
};

/**
 * Get all appointment service providers
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const where = {};
    if (String(req.query.mine) === 'true') {
      const uid = Number(req.user?.user_id ?? req.user?.id);
      if (!Number.isFinite(uid) || uid <= 0) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      where.service_provider_user_id = uid;
    }
    if (req.query.service_type) {
      where.service_type = String(req.query.service_type);
    }
    const providers = await prisma.appointment_service_providers.findMany({
      where,
      orderBy: { service_provider_id: 'desc' },
      select: PROVIDER_SELECT,
    });

    res.json(providers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch appointment service providers' });
  }
});

/**
 * Get single appointment service provider by service_provider_id
 */
router.get('/:service_provider_id', authenticateToken, async (req, res) => {
  try {
    const provider = await prisma.appointment_service_providers.findUnique({
      where: { service_provider_id: Number(req.params.service_provider_id) },
      select: PROVIDER_SELECT,
    });

    if (!provider) return res.status(404).json({ error: 'Appointment service provider not found' });

    res.json(provider);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch appointment service provider' });
  }
});

/**
 * Create new appointment service provider
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      service_provider_user_id,
      company_phone_number,
      profile_picture,
      company_address,
      password,
      language,
      service_type,
      specialization,
      work_days_from,
      work_days_to,
      work_hours_from,
      work_hours_to,
      company_name,
      appointment_fee,
    } = req.body;

    if (!service_provider_user_id || !company_name) {
      return res.status(400).json({ error: 'service_provider_user_id and company_name are required' });
    }

    const hashedPassword = password ? await bcrypt.hash(password, 10) : null;

    const newProvider = await prisma.appointment_service_providers.create({
      data: {
        service_provider_user_id: Number(service_provider_user_id),
        company_phone_number,
        profile_picture,
        company_address,
        password: hashedPassword,
        language,
        service_type,
        specialization,
        work_days_from,
        work_days_to,
        work_hours_from: work_hours_from ? new Date(`1970-01-01T${work_hours_from}`) : null,
        work_hours_to: work_hours_to ? new Date(`1970-01-01T${work_hours_to}`) : null,
        company_name,
        appointment_fee: appointment_fee ? Number(appointment_fee) : null,
      },
    });

    const { password: _pw, ...safeProvider } = newProvider;
    io?.emit('appointment-service-provider-created', safeProvider);

    res.status(201).json(safeProvider);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create appointment service provider' });
  }
});

/**
 * Update appointment service provider
 */
router.put('/:service_provider_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { service_provider_id } = req.params;
    const {
      service_provider_user_id,
      company_phone_number,
      profile_picture,
      company_address,
      password,
      language,
      service_type,
      specialization,
      work_days_from,
      work_days_to,
      work_hours_from,
      work_hours_to,
      company_name,
      appointment_fee,
    } = req.body;

    const existing = await prisma.appointment_service_providers.findUnique({
      where: { service_provider_id: Number(service_provider_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Appointment service provider not found' });

    if (existing.service_provider_user_id !== req.user.user_id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Do not allow reassignment of ownership via body.
    void service_provider_user_id;
    const hashedPassword = password ? await bcrypt.hash(password, 10) : existing.password;

    const updatedProvider = await prisma.appointment_service_providers.update({
      where: { service_provider_id: Number(service_provider_id) },
      data: {
        company_phone_number: company_phone_number ?? existing.company_phone_number,
        profile_picture: profile_picture ?? existing.profile_picture,
        company_address: company_address ?? existing.company_address,
        password: hashedPassword,
        language: language ?? existing.language,
        service_type: service_type ?? existing.service_type,
        specialization: specialization ?? existing.specialization,
        work_days_from: work_days_from ?? existing.work_days_from,
        work_days_to: work_days_to ?? existing.work_days_to,
        work_hours_from: work_hours_from ? new Date(`1970-01-01T${work_hours_from}`) : existing.work_hours_from,
        work_hours_to: work_hours_to ? new Date(`1970-01-01T${work_hours_to}`) : existing.work_hours_to,
        company_name: company_name ?? existing.company_name,
        appointment_fee: appointment_fee != null ? Number(appointment_fee) : existing.appointment_fee,
      },
    });

    const { password: _pw, ...safeUpdated } = updatedProvider;
    io?.emit('appointment-service-provider-updated', safeUpdated);

    res.json(safeUpdated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update appointment service provider' });
  }
});

/**
 * Delete appointment service provider
 */
router.delete('/:service_provider_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const existing = await prisma.appointment_service_providers.findUnique({
      where: { service_provider_id: Number(req.params.service_provider_id) },
    });
    if (!existing) return res.status(404).json({ error: 'Appointment service provider not found' });
    if (existing.service_provider_user_id !== req.user.user_id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const deleted = await prisma.appointment_service_providers.delete({
      where: { service_provider_id: Number(req.params.service_provider_id) },
    });

    io?.emit('appointment-service-provider-deleted', { service_provider_id: deleted.service_provider_id });

    res.json({ message: 'Appointment service provider deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete appointment service provider' });
  }
});

export default router;