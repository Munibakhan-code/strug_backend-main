import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { notify } from '../services/notify.js';

const router = express.Router();

// e.g. "2019 Honda Civic" — falls back to a generic label if the vehicle has gaps.
const vehicleLabel = (v) => [v?.year, v?.make, v?.model].filter(Boolean).join(' ') || 'vehicle';

/* POST - Create a new test drive request */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ successful: false, message: 'User not authenticated' });
    }

    const {
      vehicle_id,
      preferred_date,
      preferred_time,
      full_name,
      phone_number,
      email,
      notes,
    } = req.body;

    // Validate required fields. NOTE: seller_id is intentionally NOT accepted from the
    // request body — it is derived from the vehicle's owner so a client can't aim a
    // test-drive request at an arbitrary user.
    if (!vehicle_id || !preferred_date || !preferred_time || !full_name || !phone_number || !email) {
      return res.status(400).json({
        successful: false,
        message: 'Missing required fields: vehicle_id, preferred_date, preferred_time, full_name, phone_number, email',
      });
    }

    // Verify vehicle exists and derive the seller from its actual owner (authoritative).
    const vehicle = await prisma.vehicle.findUnique({
      where: { vehicle_id: Number(vehicle_id) },
    });

    if (!vehicle) {
      return res.status(404).json({ successful: false, message: 'Vehicle not found' });
    }

    // Seller is the vehicle owner — never trust a client-supplied seller_id.
    const seller_id = vehicle.user_id;
    if (!seller_id) {
      return res.status(404).json({ successful: false, message: 'Vehicle has no owner to receive test drive requests' });
    }

    // Reject if this exact vehicle/date/time is already taken — the request form filters
    // these out client-side, but that's advisory only; enforce it here too so a stale form
    // or a direct API call can't double-book the same slot.
    const existingBooking = await prisma.test_drive_request.findFirst({
      where: {
        vehicle_id: Number(vehicle_id),
        preferred_date: new Date(preferred_date),
        preferred_time,
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
    });

    if (existingBooking) {
      return res.status(409).json({
        successful: false,
        message: 'This time slot is already booked for this vehicle. Please choose another time.',
      });
    }

    // Check if buyer already has an active (PENDING or CONFIRMED) test drive request for this vehicle
    // A buyer can only have one active request per vehicle; they can book again if the previous one is CANCELLED
    const existingBuyerRequest = await prisma.test_drive_request.findFirst({
      where: {
        buyer_id: userId,
        vehicle_id: Number(vehicle_id),
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
    });

    if (existingBuyerRequest) {
      return res.status(409).json({
        successful: false,
        message: 'You already have an active test drive request for this vehicle. Please cancel your existing request before booking another.',
      });
    }

    // Create test drive request
    const testDriveRequest = await prisma.test_drive_request.create({
      data: {
        vehicle_id: Number(vehicle_id),
        seller_id,
        buyer_id: userId,
        preferred_date: new Date(preferred_date),
        preferred_time,
        full_name,
        phone_number,
        email,
        notes: notes || null,
      },
      include: {
        vehicle: true,
        seller: {
          select: {
            user_id: true,
            name: true,
            email: true,
          },
        },
        buyer: {
          select: {
            user_id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Let the seller know a buyer is waiting on them — actionable since it needs a
    // confirm/reject response, unlike most 'booking' vertical notifications.
    notify(req.app.get('io'), {
      userId: seller_id,
      vertical: 'booking',
      type: 'test_drive.requested',
      urgency: 'actionable',
      title: 'New test drive request',
      body: `${full_name} requested a test drive for your ${vehicleLabel(testDriveRequest.vehicle)}.`,
      entityType: 'test_drive_request',
      entityId: testDriveRequest.test_drive_request_id,
      actionUrl: 'sd-automotive',
    });

    return res.status(201).json({
      successful: true,
      message: 'Test drive request created successfully',
      data: testDriveRequest,
    });
  } catch (err) {
    // The pre-check above is advisory; the partial unique index
    // "test_drive_active_slot_key" over (vehicle_id, preferred_date, preferred_time)
    // for active statuses is the real guard against a TOCTOU double-booking race.
    // The request that loses the race hits P2002 — return a clean 409, not a 500.
    if (err.code === 'P2002') {
      return res.status(409).json({
        successful: false,
        message: 'This time slot is no longer available for this vehicle. Please choose another time.',
      });
    }
    console.error('Error creating test drive request:', err);
    return res.status(500).json({
      successful: false,
      message: 'Failed to create test drive request',
      error: err.message,
    });
  }
});

/* GET - Get all test drive requests for a user (as buyer) */
router.get('/my-requests', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ successful: false, message: 'User not authenticated' });
    }

    const requests = await prisma.test_drive_request.findMany({
      where: { buyer_id: userId },
      include: {
        vehicle: true,
        seller: {
          select: {
            user_id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    return res.json({ successful: true, data: requests });
  } catch (err) {
    console.error('Error fetching test drive requests:', err);
    return res.status(500).json({
      successful: false,
      message: 'Failed to fetch test drive requests',
      error: err.message,
    });
  }
});

/* GET - Times already booked (PENDING/CONFIRMED) for a vehicle on a given date, so the
   request form can hide slots that are no longer available. Cancelled requests free their
   slot back up, so they're excluded. */
router.get('/vehicle/:vehicle_id/booked-times', authenticateToken, async (req, res) => {
  try {
    const vehicleId = Number(req.params.vehicle_id);
    if (Number.isNaN(vehicleId)) {
      return res.status(400).json({ successful: false, message: 'Invalid vehicle ID' });
    }

    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ successful: false, message: 'date query parameter is required' });
    }

    const preferredDate = new Date(date);
    if (Number.isNaN(preferredDate.getTime())) {
      return res.status(400).json({ successful: false, message: 'Invalid date' });
    }

    const rows = await prisma.test_drive_request.findMany({
      where: {
        vehicle_id: vehicleId,
        preferred_date: preferredDate,
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      select: { preferred_time: true },
    });

    return res.json({ successful: true, data: rows.map((r) => r.preferred_time) });
  } catch (err) {
    console.error('Error fetching booked test drive times:', err);
    return res.status(500).json({
      successful: false,
      message: 'Failed to fetch booked times',
      error: err.message,
    });
  }
});

/* GET - Get all test drive requests for a seller */
router.get('/seller-requests', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ successful: false, message: 'User not authenticated' });
    }

    const requests = await prisma.test_drive_request.findMany({
      where: { seller_id: userId },
      include: {
        vehicle: true,
        buyer: {
          select: {
            user_id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    return res.json({ successful: true, data: requests });
  } catch (err) {
    console.error('Error fetching seller test drive requests:', err);
    return res.status(500).json({
      successful: false,
      message: 'Failed to fetch seller test drive requests',
      error: err.message,
    });
  }
});

/* GET - Get a specific test drive request by ID */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ successful: false, message: 'User not authenticated' });
    }

    const requestId = Number(req.params.id);
    if (Number.isNaN(requestId)) {
      return res.status(400).json({ successful: false, message: 'Invalid request ID' });
    }

    const request = await prisma.test_drive_request.findUnique({
      where: { test_drive_request_id: requestId },
      include: {
        vehicle: true,
        seller: {
          select: {
            user_id: true,
            name: true,
            email: true,
          },
        },
        buyer: {
          select: {
            user_id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!request) {
      return res.status(404).json({ successful: false, message: 'Test drive request not found' });
    }

    // Check if user is authorized to view this request
    if (request.buyer_id !== userId && request.seller_id !== userId) {
      return res.status(403).json({ successful: false, message: 'Unauthorized to view this request' });
    }

    return res.json({ successful: true, data: request });
  } catch (err) {
    console.error('Error fetching test drive request:', err);
    return res.status(500).json({
      successful: false,
      message: 'Failed to fetch test drive request',
      error: err.message,
    });
  }
});

/* PUT - Update test drive request status (seller only) */
router.put('/:id/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ successful: false, message: 'User not authenticated' });
    }

    const requestId = Number(req.params.id);
    if (Number.isNaN(requestId)) {
      return res.status(400).json({ successful: false, message: 'Invalid request ID' });
    }

    const { status } = req.body;

    if (!status || !['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'].includes(status)) {
      return res.status(400).json({
        successful: false,
        message: 'Invalid status. Must be one of: PENDING, CONFIRMED, CANCELLED, COMPLETED',
      });
    }

    // Get the request
    const existingRequest = await prisma.test_drive_request.findUnique({
      where: { test_drive_request_id: requestId },
    });

    if (!existingRequest) {
      return res.status(404).json({ successful: false, message: 'Test drive request not found' });
    }

    // Check if user is the seller
    if (existingRequest.seller_id !== userId) {
      return res.status(403).json({ successful: false, message: 'Only the seller can update the request status' });
    }

    // Update the request
    const updatedRequest = await prisma.test_drive_request.update({
      where: { test_drive_request_id: requestId },
      data: { status },
      include: {
        vehicle: true,
        seller: {
          select: {
            user_id: true,
            name: true,
            email: true,
          },
        },
        buyer: {
          select: {
            user_id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Tell the buyer the seller responded. Only CONFIRMED/CANCELLED are the seller's actual
    // accept/reject decision — PENDING is a no-op transition and COMPLETED is post-drive
    // bookkeeping, neither of which the buyer is waiting on a response for.
    if (status === 'CONFIRMED') {
      notify(req.app.get('io'), {
        userId: updatedRequest.buyer_id,
        vertical: 'booking',
        type: 'test_drive.confirmed',
        urgency: 'ambient',
        title: 'Test drive confirmed',
        body: `Your test drive request for the ${vehicleLabel(updatedRequest.vehicle)} was accepted.`,
        entityType: 'test_drive_request',
        entityId: updatedRequest.test_drive_request_id,
        actionUrl: 'sd-drive',
      });
    } else if (status === 'CANCELLED') {
      notify(req.app.get('io'), {
        userId: updatedRequest.buyer_id,
        vertical: 'booking',
        type: 'test_drive.cancelled',
        urgency: 'ambient',
        title: 'Test drive request declined',
        body: `Your test drive request for the ${vehicleLabel(updatedRequest.vehicle)} was declined.`,
        entityType: 'test_drive_request',
        entityId: updatedRequest.test_drive_request_id,
        actionUrl: 'sd-drive',
      });
    }

    return res.json({
      successful: true,
      message: 'Test drive request status updated successfully',
      data: updatedRequest,
    });
  } catch (err) {
    console.error('Error updating test drive request status:', err);
    return res.status(500).json({
      successful: false,
      message: 'Failed to update test drive request status',
      error: err.message,
    });
  }
});

/* DELETE - Cancel a test drive request (buyer only) */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ successful: false, message: 'User not authenticated' });
    }

    const requestId = Number(req.params.id);
    if (Number.isNaN(requestId)) {
      return res.status(400).json({ successful: false, message: 'Invalid request ID' });
    }

    // Get the request
    const existingRequest = await prisma.test_drive_request.findUnique({
      where: { test_drive_request_id: requestId },
    });

    if (!existingRequest) {
      return res.status(404).json({ successful: false, message: 'Test drive request not found' });
    }

    // Check if user is the buyer
    if (existingRequest.buyer_id !== userId) {
      return res.status(403).json({ successful: false, message: 'Only the buyer can cancel the request' });
    }

    // Check if request can be cancelled (only PENDING or CONFIRMED)
    if (existingRequest.status === 'COMPLETED') {
      return res.status(400).json({ successful: false, message: 'Cannot cancel a completed test drive request' });
    }

    // Update status to CANCELLED instead of deleting
    const updatedRequest = await prisma.test_drive_request.update({
      where: { test_drive_request_id: requestId },
      data: { status: 'CANCELLED' },
    });

    return res.json({
      successful: true,
      message: 'Test drive request cancelled successfully',
      data: updatedRequest,
    });
  } catch (err) {
    console.error('Error cancelling test drive request:', err);
    return res.status(500).json({
      successful: false,
      message: 'Failed to cancel test drive request',
      error: err.message,
    });
  }
});

export default router;
