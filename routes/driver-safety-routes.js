import express from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import prisma from './../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import {
  requireAuthUserId,
  resolveDriverProfileForUser,
  assertTripAssignedToUser,
} from '../utils/ride-auth.js';
import { notify } from '../services/notify.js';

const router = express.Router();

const SHARE_LINK_TTL_MS = 4 * 60 * 60 * 1000; // 4h hard cap, defense-in-depth if /complete never fires

// Support/safety-inbox recipient for SOS alerts — same pattern as VITE_SUPPORT_USER_ID on the
// frontend, but this is the backend-side counterpart used to notify() a real user row.
// MUST be set per environment (see .env.example); when it isn't, an SOS reaches no human at all,
// so the driver is told so rather than being reassured falsely. See the SOS handler below.
const SAFETY_ALERT_USER_ID = process.env.SAFETY_ALERT_USER_ID ? Number(process.env.SAFETY_ALERT_USER_ID) : null;

function generateShareToken() {
  // URL-safe, not derived from the trip id — mirrors courier_order.tracking_token
  // (routes/courier-order-routes.js) so leaking it reveals nothing else and it can be revoked
  // by nulling the column without touching a signing key.
  return crypto.randomBytes(16).toString('base64url');
}

const emergencyContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(1).max(30),
  relationship: z.string().trim().max(60).optional().nullable(),
});

/** GET /driver-safety/emergency-contact */
router.get('/emergency-contact', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const profile = await resolveDriverProfileForUser(prisma, userId);
    if (!profile) return res.status(404).json({ successful: false, message: 'Driver profile not found' });

    const contact = await prisma.driver_emergency_contact.findUnique({
      where: { driver_profile_id: profile.driver_profile_id },
    });
    return res.json({ successful: true, data: contact });
  } catch (err) {
    console.error('[driver-safety] GET emergency-contact error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/** PUT /driver-safety/emergency-contact */
router.put('/emergency-contact', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const profile = await resolveDriverProfileForUser(prisma, userId);
    if (!profile) return res.status(404).json({ successful: false, message: 'Driver profile not found' });

    const parsed = emergencyContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ successful: false, message: 'Invalid emergency contact', issues: parsed.error.issues });
    }

    const contact = await prisma.driver_emergency_contact.upsert({
      where: { driver_profile_id: profile.driver_profile_id },
      update: parsed.data,
      create: { driver_profile_id: profile.driver_profile_id, ...parsed.data },
    });
    return res.json({ successful: true, data: contact });
  } catch (err) {
    console.error('[driver-safety] PUT emergency-contact error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * POST /driver-safety/:trip_id/sos — driver presses the SOS button mid-trip.
 * Does NOT auto-dial emergency services (liability/false-positive reasons, matches
 * Uber/Lyft behavior) — the client shows the driver a tel: link separately. This just
 * snapshots what's known right now and alerts platform support.
 */
router.post('/:trip_id/sos', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const trip_id = Number(req.params.trip_id);
    const trip = await prisma.active_trip.findUnique({ where: { trip_id } });
    if (!trip) return res.status(404).json({ successful: false, message: 'Trip not found' });

    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const denied = await assertTripAssignedToUser(prisma, trip, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    const [driverProfile, contact] = await Promise.all([
      prisma.driver_profile.findUnique({
        where: { driver_profile_id: trip.driver_id },
        select: { current_lat: true, current_long: true, user: { select: { name: true } } },
      }),
      prisma.driver_emergency_contact.findUnique({ where: { driver_profile_id: trip.driver_id } }),
    ]);

    const incident = await prisma.trip_sos_incident.create({
      data: {
        trip_id,
        triggered_by: userId,
        driver_lat: driverProfile?.current_lat ?? null,
        driver_long: driverProfile?.current_long ?? null,
        contact_name: contact?.name ?? null,
        contact_phone: contact?.phone ?? null,
      },
    });

    // Alert support FIRST, and remember whether it actually went anywhere — the driver's own
    // acknowledgement must not claim "we've been alerted" when SAFETY_ALERT_USER_ID is unset and
    // nobody was. Telling a driver mid-emergency that help is coming when it isn't is worse than
    // telling them to call emergency services themselves.
    let supportAlerted = false;
    if (SAFETY_ALERT_USER_ID) {
      const driverName = driverProfile?.user?.name || `driver user/${userId}`;
      supportAlerted = true;
      notify(io, {
        userId: SAFETY_ALERT_USER_ID,
        vertical: 'rideshare',
        type: 'sos.triggered',
        // 'ambient', not 'actionable': on the client, 'actionable' is reserved for *claimable*
        // offers and routes to the accept/decline claim card. An SOS is not a job to claim.
        urgency: 'ambient',
        title: `SOS: ${driverName}`,
        body: `Trip #${trip_id} — SOS pressed. Incident #${incident.incident_id}.`,
        entityType: 'trip_sos_incident',
        entityId: incident.incident_id,
        actionUrl: 'sd-drive',
      }).catch(() => {});
    } else {
      // error, not warn: this is a safety feature silently doing nothing, and it should show up
      // in whatever surfaces container errors rather than scrolling past in the noise.
      console.error(`[driver-safety] SOS #${incident.incident_id} on trip ${trip_id} reached NO ONE — SAFETY_ALERT_USER_ID is not configured for this environment. Set it (see .env.example).`);
    }

    // Fail-open, fire-and-forget per notify()'s contract — an SOS must be recorded even if
    // the notification pipeline has a problem.
    notify(io, {
      userId,
      vertical: 'rideshare',
      type: 'sos.acknowledged',
      urgency: 'ambient', // see the note above — informational to the driver, not a claim
      title: 'SOS received',
      body: supportAlerted
        ? "We've been alerted. Stay safe — use the emergency call button if you need immediate help."
        : 'Your SOS was recorded. Support alerting is not configured here, so call emergency services directly if you need help now.',
      entityType: 'trip_sos_incident',
      entityId: incident.incident_id,
      actionUrl: 'sd-drive',
    }).catch(() => {});

    return res.json({ successful: true, data: incident, support_alerted: supportAlerted });
  } catch (err) {
    console.error('[driver-safety] POST sos error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/** POST /driver-safety/:trip_id/share-link — generate (or rotate) a no-login trip-tracking link. */
router.post('/:trip_id/share-link', authenticateToken, async (req, res) => {
  try {
    const trip_id = Number(req.params.trip_id);
    const trip = await prisma.active_trip.findUnique({ where: { trip_id } });
    if (!trip) return res.status(404).json({ successful: false, message: 'Trip not found' });

    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const denied = await assertTripAssignedToUser(prisma, trip, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    if (trip.ended_at) {
      return res.status(400).json({ successful: false, message: 'Trip has already ended' });
    }

    const share_token = generateShareToken();
    await prisma.active_trip.update({
      where: { trip_id },
      data: { share_token, share_token_created_at: new Date() },
    });

    const base = process.env.APP_PUBLIC_URL || 'https://app.strug.ca';
    return res.json({ successful: true, share_token, share_url: `${base}/track-trip/${share_token}` });
  } catch (err) {
    console.error('[driver-safety] POST share-link error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/** DELETE /driver-safety/:trip_id/share-link — revoke early. */
router.delete('/:trip_id/share-link', authenticateToken, async (req, res) => {
  try {
    const trip_id = Number(req.params.trip_id);
    const trip = await prisma.active_trip.findUnique({ where: { trip_id } });
    if (!trip) return res.status(404).json({ successful: false, message: 'Trip not found' });

    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const denied = await assertTripAssignedToUser(prisma, trip, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    await prisma.active_trip.update({
      where: { trip_id },
      data: { share_token: null, share_token_created_at: null },
    });
    return res.json({ successful: true });
  } catch (err) {
    console.error('[driver-safety] DELETE share-link error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /driver-safety/incidents — admin/ops read surface for SOS presses.
 *
 * Without this, trip_sos_incident is write-only: nothing in the codebase ever read a row back,
 * so an SOS landed in a table no human could reach. Defaults to open incidents, newest first.
 * Literal path, so it never collides with the "/:trip_id/..." param routes above.
 */
router.get('/incidents', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : 'open';
    const take = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    const incidents = await prisma.trip_sos_incident.findMany({
      where: status === 'all' ? {} : { status },
      orderBy: { created_at: 'desc' },
      take,
      include: {
        active_trip: {
          select: {
            trip_id: true,
            started_at: true,
            ended_at: true,
            driver_profile: { select: { driver_profile_id: true, user: { select: { user_id: true, name: true } } } },
          },
        },
      },
    });
    return res.json({ successful: true, data: incidents });
  } catch (err) {
    console.error('[driver-safety] GET incidents error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/** PATCH /driver-safety/incidents/:incident_id — admin/ops close-out. */
router.patch('/incidents/:incident_id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const incident_id = Number(req.params.incident_id);
    if (!Number.isInteger(incident_id)) {
      return res.status(400).json({ successful: false, message: 'Invalid incident id' });
    }

    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!['open', 'resolved'].includes(status)) {
      return res.status(400).json({ successful: false, message: 'Status must be open or resolved' });
    }

    const reviewerId = requireAuthUserId(req, res);
    if (!reviewerId) return;

    const existing = await prisma.trip_sos_incident.findUnique({ where: { incident_id } });
    if (!existing) return res.status(404).json({ successful: false, message: 'Incident not found' });

    const updated = await prisma.trip_sos_incident.update({
      where: { incident_id },
      data: {
        status,
        resolved_at: status === 'resolved' ? new Date() : null,
        resolved_by: status === 'resolved' ? reviewerId : null,
      },
    });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    console.error('[driver-safety] PATCH incident error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /driver-safety/track/:token — no-login tracking link for whoever the driver shares it
 * with. Registered before "/:trip_id" routes are matched by method, but Express still needs
 * this literal path to win over param routes with the same prefix — mounted at a distinct
 * "/track/:token" shape (no verb overlap with "/:trip_id/..."), so no ordering hazard here.
 * Hand-picks fields — no fare, no passenger identity, just enough to render a map.
 */
router.get('/track/:token', async (req, res) => {
  try {
    const trip = await prisma.active_trip.findUnique({
      where: { share_token: req.params.token },
      select: {
        trip_id: true,
        ended_at: true,
        share_token_created_at: true,
        driver_arrived_at: true,
        started_at: true,
        driver_profile: {
          select: { current_lat: true, current_long: true, user: { select: { name: true } } },
        },
        ride_request: {
          select: { pickup_lat: true, pickup_long: true, drop_lat: true, drop_long: true, status: true },
        },
      },
    });
    if (!trip) return res.status(404).json({ successful: false, message: 'Tracking link not found or no longer active' });
    if (trip.ended_at) return res.status(404).json({ successful: false, message: 'This trip has ended' });

    const ageMs = trip.share_token_created_at ? Date.now() - new Date(trip.share_token_created_at).getTime() : Infinity;
    if (ageMs > SHARE_LINK_TTL_MS) {
      return res.status(404).json({ successful: false, message: 'This tracking link has expired' });
    }

    return res.json({
      successful: true,
      trip_id: trip.trip_id,
      status: trip.ride_request?.status ?? null,
      driver_first_name: trip.driver_profile?.user?.name?.split(' ')[0] || null,
      lat: trip.driver_profile?.current_lat ?? null,
      lng: trip.driver_profile?.current_long ?? null,
      pickup_lat: trip.ride_request?.pickup_lat ?? null,
      pickup_lng: trip.ride_request?.pickup_long ?? null,
      dropoff_lat: trip.ride_request?.drop_lat ?? null,
      dropoff_lng: trip.ride_request?.drop_long ?? null,
    });
  } catch (err) {
    console.error('[driver-safety] GET track error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

export default router;
