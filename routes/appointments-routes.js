// routes/appointments.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import mailerEvents from '../utils/mailer-event.js'; 
import { decrypt } from '../utils/crypto.js';       
import i18next from '../utils/i18n.js';
import { emailLngFromUser } from '../utils/email-lang.js';   

const router = express.Router();

/**
 * Get appointments — customer sees own; provider sees appointments assigned to their profile; admin sees all
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const uid = req.user.user_id;

    const admin = await Promise.resolve(req.user.permission === 'admin' ? true : null);
    if (admin) {
      const all = await prisma.appointments.findMany({
        orderBy: { appointment_id: 'desc' },
        include: {
          appointment_rating: true,
          appointment_reviews: true,
          checkouts: true,
          appointment_service: true,
          appointment_service_providers: true,
          user: true,
        },
      });
      return res.json(all);
    }

    // Find if the user is a service provider
    const providerProfile = await prisma.appointment_service_providers.findFirst({
      where: { service_provider_user_id: uid },
      select: { service_provider_id: true },
    });

    const appointments = await prisma.appointments.findMany({
      where: providerProfile
        ? { OR: [{ user_id: uid }, { service_provider_id: providerProfile.service_provider_id }] }
        : { user_id: uid },
      orderBy: { appointment_id: 'desc' },
      include: {
        appointment_rating: true,
        appointment_reviews: true,
        checkouts: true,
        appointment_service: true,
        appointment_service_providers: true,
        user: true,
      },
    });

    res.json(appointments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
});

/**
 * Get single appointment — customer or assigned provider only
 */
router.get('/:appointment_id', authenticateToken, async (req, res) => {
  try {
    const appointment = await prisma.appointments.findUnique({
      where: { appointment_id: Number(req.params.appointment_id) },
      include: {
        appointment_rating: true,
        appointment_reviews: true,
        checkouts: true,
        appointment_service: true,
        appointment_service_providers: true,
        user: true,
      },
    });

    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    const uid = req.user.user_id;
    const isCustomer = appointment.user_id === uid;
    const isProvider = appointment.appointment_service_providers?.service_provider_user_id === uid;
    const admin = !isCustomer && !isProvider
      ? await Promise.resolve(req.user.permission === 'admin' ? true : null)
      : null;

    if (!isCustomer && !isProvider && !admin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(appointment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch appointment' });
  }
});

/**
 * CREATE NEW APPOINTMENT
 * Production Ready: Validates, Saves to DB, and Notifies both Customer & Provider
 * POST /appointments
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      service_provider_id,
      time_to,
      time_from,
      date,
      note,
      service_id,
      checkout_id,
    } = req.body;

    // 1. Validation
    if (!service_provider_id || !date || !service_id) {
      return res.status(400).json({
          successful: false,
          message: 'Provider, Service, and Date are required fields.'
      });
    }

    // 2. Database Appointment — user_id always from JWT
    const newAppointment = await prisma.appointments.create({
      data: {
        service_provider_id: Number(service_provider_id),
        user_id: req.user.user_id,
        time_to: time_to ? new Date(time_to) : null,
        time_from: time_from ? new Date(time_from) : null,
        date: new Date(date),
        note,
        service_id: Number(service_id),
        checkout_id: checkout_id ? Number(checkout_id) : null,
      },
      include: {
          user: { select: { name: true, email: true, language: true } },
          appointment_service: { select: { service_name: true } },
          appointment_service_providers: { 
              include: { user: { select: { email: true, language: true } } } 
          }
      }
    });


    try {
        const formattedDate = new Date(newAppointment.date).toLocaleDateString();
        const formattedTime = newAppointment.time_from ? new Date(newAppointment.time_from).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';

        const emailVariables = {
            service_name: newAppointment.appointment_service?.service_name || 'Service',
            date: formattedDate,
            time: formattedTime,
        };

        if (newAppointment.user?.email) {
            const customerEmail = decrypt(newAppointment.user.email);
            const lng = emailLngFromUser(newAppointment.user);
            const t = i18next.getFixedT(lng);
            mailerEvents.emit('send_email', {
                templateName: 'service-appointment',
                variables: {
                    ...emailVariables,
                    title: t('emails.services.subjects.confirmed_customer'),
                    message: t('emails.services.messages.confirmed'),
                    other_party_name: newAppointment.appointment_service_providers?.company_name || 'Strug Partner',
                    isProvider: false,
                },
                to: customerEmail,
                subjectKey: 'emails.services.subjects.confirmed_customer',
                user: newAppointment.user,
            });
        }

        const providerUser = newAppointment.appointment_service_providers?.user;
        if (providerUser?.email) {
            const providerEmail = decrypt(providerUser.email);
            const lngP = emailLngFromUser(providerUser);
            const tP = i18next.getFixedT(lngP);
            mailerEvents.emit('send_email', {
                templateName: 'service-appointment',
                variables: {
                    ...emailVariables,
                    title: tP('emails.services.subjects.new_alert_provider'),
                    message: tP('emails.services.messages.provider_alert'),
                    other_party_name: newAppointment.user?.name || 'A Customer',
                    isProvider: true,
                },
                to: providerEmail,
                subjectKey: 'emails.services.subjects.new_alert_provider',
                user: providerUser,
            });
        }
    } catch (mailErr) {
        console.error("⚠️ Appointment Alert Emails failed to queue:", mailErr.message);
    }

    // Scoped realtime: provider user room only (no PII broadcast).
    // Frontend listens on `appointment-created-${user.id}` in SellerServicesDashboard.
    const io = req.app.get('io');
    const providerUid = newAppointment.appointment_service_providers?.service_provider_user_id;
    if (io && providerUid) {
      io.to(`user-${providerUid}`).emit(`appointment-created-${providerUid}`, {
        appointment_id: newAppointment.appointment_id,
        id: newAppointment.appointment_id,
      });
    }

  
    res.status(201).json({
        successful: true,
        message: "Appointment scheduled successfully! Notifications sent.",
        data: newAppointment
    });

  } catch (err) {
    console.error("❌ Create Appointment Error:", err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});


/**
 * Update appointment
 */
router.put('/:appointment_id', authenticateToken, async (req, res) => {
  try {
    const { appointment_id } = req.params;
    const {
      service_provider_id,
      user_id,
      time_to,
      time_from,
      date,
      note,
      service_id,
      checkout_id,
    } = req.body;

    const existing = await prisma.appointments.findUnique({
      where: { appointment_id: Number(appointment_id) },
      include: { appointment_service_providers: { select: { service_provider_user_id: true } } },
    });

    if (!existing) return res.status(404).json({ error: 'Appointment not found' });

    const uid = req.user.user_id;
    const isCustomer = existing.user_id === uid;
    const isProvider = existing.appointment_service_providers?.service_provider_user_id === uid;
    if (!isCustomer && !isProvider) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Never accept user_id / service_provider_id from the client — that would let a party
    // reassign (steal/transfer) the booking. Ownership stays on the existing row.
    void user_id;
    void service_provider_id;
    const updatedAppointment = await prisma.appointments.update({
      where: { appointment_id: Number(appointment_id) },
      data: {
        time_to: time_to ? new Date(time_to) : existing.time_to,
        time_from: time_from ? new Date(time_from) : existing.time_from,
        date: date ? new Date(date) : existing.date,
        note: note ?? existing.note,
        service_id: service_id ? Number(service_id) : existing.service_id,
        checkout_id: checkout_id ? Number(checkout_id) : existing.checkout_id,
      },
    });

    // REMOVED for the same reason as the create emit above: an unscoped io.emit broadcasts the
    // whole appointment row (customer details included) to every connected socket, and nothing
    // listens for `appointment-updated` in any frontend. Status realtime belongs in notify().

    res.json(updatedAppointment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update appointment' });
  }
});

/**
 * Delete appointment — customer only
 */
router.delete('/:appointment_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const existing = await prisma.appointments.findUnique({
      where: { appointment_id: Number(req.params.appointment_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Appointment not found' });

    if (existing.user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const deleted = await prisma.appointments.delete({
      where: { appointment_id: Number(req.params.appointment_id) },
    });

    io?.emit('appointment-deleted', { appointment_id: deleted.appointment_id });

    res.json({ message: 'Appointment deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete appointment' });
  }
});

/* PUT /:appointment_id/confirm — provider confirms appointment */
router.put('/:appointment_id/confirm', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const appointment_id = Number(req.params.appointment_id);
    const appt = await prisma.appointments.findUnique({
      where: { appointment_id },
      include: { appointment_service_providers: { select: { service_provider_user_id: true } } },
    });
    if (!appt) return res.status(404).json({ successful: false, message: 'Appointment not found' });
    if (appt.appointment_service_providers?.service_provider_user_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Access denied' });
    }
    if (appt.status !== 'pending') return res.status(400).json({ successful: false, message: 'Appointment no longer pending' });

    await prisma.appointments.update({ where: { appointment_id }, data: { status: 'confirmed' } });
    io?.to(`user-${appt.user_id}`).emit(`appointment-confirmed-${appointment_id}`, { message: 'Appointment confirmed!' });
    return res.json({ successful: true, message: 'Appointment confirmed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* PUT /:appointment_id/decline — provider declines appointment */
router.put('/:appointment_id/decline', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const appointment_id = Number(req.params.appointment_id);
    const appt = await prisma.appointments.findUnique({
      where: { appointment_id },
      include: { appointment_service_providers: { select: { service_provider_user_id: true } } },
    });
    if (!appt) return res.status(404).json({ successful: false, message: 'Appointment not found' });
    if (appt.appointment_service_providers?.service_provider_user_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Access denied' });
    }
    if (appt.status !== 'pending') return res.status(400).json({ successful: false, message: 'Appointment no longer pending' });

    await prisma.appointments.update({ where: { appointment_id }, data: { status: 'declined' } });
    io?.to(`user-${appt.user_id}`).emit(`appointment-declined-${appointment_id}`, { message: 'Appointment declined.' });
    return res.json({ successful: true, message: 'Appointment declined' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

export default router;
