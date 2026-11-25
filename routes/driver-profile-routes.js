import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin } from '../middleware/require-admin.js';
import { z } from 'zod';
import {
  requireAuthUserId,
  resolveDriverProfileForUser,
  assertDriverProfileOwnedByUser,
  syncDriverOnlineStatusForUser,
} from '../utils/ride-auth.js';
import {
  sanitizeDriverEarningsStats,
  sanitizeDriverTripHistoryRow,
  computeDriverAcceptanceRate,
} from '../utils/ride-driver-view.js';
import { RANGE_DAYS, resolveRangeParam, resolveRange, buildEarningsSeries, round2 } from '../utils/analytics-buckets.js';
import { getIncomingDeliveryOffersForDriver } from '../utils/delivery-dispatch.js';
import { publicDeliverLocation } from '../utils/food-fulfillment.js';
import { driverProfileIdsForUser } from '../utils/ride-dispatch.js';
import { emitProductOrderStatusUpdate } from '../utils/shop-order-socket.js';
import { notify } from '../services/notify.js';

const router = express.Router();
const statusSchema = z.object({
  is_online: z.boolean(),
  current_lat: z.number().optional(),
  current_long: z.number().optional()
});
const preferencesSchema = z.object({
  accepts_rides: z.boolean().optional(),
  accepts_food: z.boolean().optional(),
  accepts_product: z.boolean().optional(),
  accepts_courier: z.boolean().optional(),
  has_cold_bag: z.boolean().optional(),
  supports_heavy_items: z.boolean().optional(),
  max_heavy_item_kg: z.coerce.number().min(0).max(200).nullable().optional(),
  max_batch_orders: z.coerce.number().int().min(1).max(6).optional(),
  max_batch_distance_km: z.coerce.number().min(1).max(80).nullable().optional(),
  delivery_vehicle_class: z.enum(['bike', 'scooter', 'motorcycle', 'car', 'van', 'truck']).nullable().optional(),
}).refine((data) => Object.keys(data).length > 0, { message: 'At least one preference must be provided' });






/**
 * Task 09: Get Driver's Trip History (Paginated)
 * GET /driver-profile/trips?page=1&limit=10
 */
router.get('/trips/history', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const profile = await resolveDriverProfileForUser(prisma, userId);
    if (!profile) {
      return res.json({
        successful: true,
        data: [],
        pagination: { total_records: 0, current_page: 1, total_pages: 0, has_more: false },
      });
    }
    const driver_id = profile.driver_profile_id;
    
    // 1. Pagination Parameters (Default: Page 1, Limit 10)
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    
    const [trips, totalCount] = await prisma.$transaction([
      prisma.active_trip.findMany({
        where: { driver_id: driver_id, ended_at: { not: null } },
        orderBy: { ended_at: 'desc' },
        skip: skip,
        take: limit,
        include: {
          ride_request: {
            include: {
              user: { select: { name: true, email: true } } 
            }
          }
        }
      }),
      prisma.active_trip.count({
        where: { driver_id: driver_id, ended_at: { not: null } }
      })
    ]);

    //  Response 
    return res.json({
      successful: true,
      data: trips.map(sanitizeDriverTripHistoryRow),
      pagination: {
        total_records: totalCount,
        current_page: page,
        total_pages: Math.ceil(totalCount / limit),
        has_more: skip + trips.length < totalCount
      }
    });

  } catch (err) {
    console.error('Trip History Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});


/**
 * Task 08: Get Driver's Daily Earnings Summary
 * GET /driver-profile/earnings/today
 */
router.get('/earnings/today', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const profile = await resolveDriverProfileForUser(prisma, userId);
    if (!profile) {
      return res.json({
        successful: true,
        stats: sanitizeDriverEarningsStats({
          date: new Date().toISOString().split('T')[0],
          total_trips: 0,
          driver_earnings: '0.00',
          total_distance_km: '0.00',
          currency: 'CAD',
        }),
      });
    }
    const driver_id = profile.driver_profile_id;

    // (UTC/Local logic)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    
    const dailyTrips = await prisma.active_trip.findMany({
      where: {
        driver_id: driver_id,
        ended_at: {
          gte: today,
          lt: tomorrow,
        },
      },
      select: {
        total_fare: true,
        driver_payout: true,
        platform_fee: true,
        tip_amount: true,
        actual_distance_km: true,
      }
    });

    // (Aggregations)
    const grossEarnings = dailyTrips.reduce((sum, trip) => sum + (trip.total_fare || 0), 0);
    const totalDistance = dailyTrips.reduce((sum, trip) => sum + (trip.actual_distance_km || 0), 0);
    const totalTrips = dailyTrips.length;
    const driverEarnings = dailyTrips.reduce((sum, trip) => {
      // Tips bypass the 79/21 fare split entirely — 100% to the driver, added on top.
      const payout = trip.driver_payout != null ? trip.driver_payout : (trip.total_fare != null ? trip.total_fare * 0.79 : 0);
      return sum + payout + (trip.tip_amount || 0);
    }, 0);

    return res.json({
      successful: true,
      stats: sanitizeDriverEarningsStats({
        date: today.toISOString().split('T')[0],
        total_trips: totalTrips,
        driver_earnings: driverEarnings.toFixed(2),
        total_distance_km: totalDistance.toFixed(2),
        currency: 'CAD',
      }),
    });

  } catch (err) {
    console.error('Earnings Stats Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});



/**
 * GET /driver-profile/me/earnings/breakdown?range=today
 *
 * Per-vertical earnings for the authenticated driver — ride/food/product/courier — for the
 * Home-screen snapshot and Earnings tab. Reuses the exact payout formulas already live in
 * /earnings/today (ride), delivery-driver-routes.js's /:driver_id/earnings/today (food +
 * product), and courier-order-routes.js's /earnings (courier, 79% of price), just re-scoped to
 * "today" and grouped by vertical instead of each being its own endpoint. Only "today" is
 * supported for now — the Home snapshot and Earnings tab don't need range switching yet.
 */
router.get('/me/earnings/breakdown', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const empty = { earnings: '0.00', trips: 0 };
    const emptyResponse = {
      successful: true,
      data: {
        range: 'today',
        currency: 'CAD',
        ride: { ...empty },
        food: { ...empty },
        product: { ...empty },
        courier: { ...empty },
        total: { ...empty },
      },
    };

    const profile = await resolveDriverProfileForUser(prisma, userId);
    if (!profile) return res.json(emptyResponse);
    const driver_id = profile.driver_profile_id;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [rideTrips, foodOrders, productOrders, courierOrders] = await Promise.all([
      prisma.active_trip.findMany({
        where: { driver_id, ended_at: { gte: today, lt: tomorrow } },
        select: { total_fare: true, driver_payout: true, tip_amount: true },
      }),
      prisma.food_order.findMany({
        where: { driver_id, order_status: 'delivered', delivered_at: { gte: today, lt: tomorrow } },
        select: { delivery_fee: true },
      }),
      prisma.product_order.findMany({
        where: { driver_id, status: 'fulfilled', date: { gte: today, lt: tomorrow } },
        select: { delivery_fee: true },
      }),
      prisma.courier_order.findMany({
        where: {
          courier_service_provider_id: driver_id,
          status: 'delivered',
          OR: [{ deliver_date: { gte: today, lt: tomorrow } }, { deliver_date: null, last_update: { gte: today, lt: tomorrow } }],
        },
        select: { price: true },
      }),
    ]);

    // Same 79/21 split as /earnings/today, tips added on top (100% to the driver).
    const rideEarnings = rideTrips.reduce((sum, t) => {
      const payout = t.driver_payout != null ? t.driver_payout : (t.total_fare != null ? t.total_fare * 0.79 : 0);
      return sum + payout + (t.tip_amount || 0);
    }, 0);
    const foodEarnings = foodOrders.reduce((sum, o) => sum + (o.delivery_fee || 0), 0);
    const productEarnings = productOrders.reduce((sum, o) => sum + (o.delivery_fee || 0), 0);
    const courierEarnings = courierOrders.reduce((sum, o) => sum + (parseFloat(o.price) || 0) * 0.79, 0);
    const totalEarnings = rideEarnings + foodEarnings + productEarnings + courierEarnings;
    const totalTrips = rideTrips.length + foodOrders.length + productOrders.length + courierOrders.length;

    return res.json({
      successful: true,
      data: {
        range: 'today',
        currency: 'CAD',
        ride: { earnings: rideEarnings.toFixed(2), trips: rideTrips.length },
        food: { earnings: foodEarnings.toFixed(2), trips: foodOrders.length },
        product: { earnings: productEarnings.toFixed(2), trips: productOrders.length },
        courier: { earnings: courierEarnings.toFixed(2), trips: courierOrders.length },
        total: { earnings: totalEarnings.toFixed(2), trips: totalTrips },
      },
    });
  } catch (err) {
    console.error('Earnings Breakdown Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * Get all driver profiles — admin only (returns every driver's license_number + contact PII).
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
    const drivers = await prisma.driver_profile.findMany({
      orderBy: { driver_profile_id: 'asc' },
      include: {
        user: true,
        booking_type: true,
        active_trip: true,
        carpool_offer: true,
        vehicle: true,
      },
    });

    res.json(drivers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch driver profiles' });
  }
});

/* GET /driver-profile/me — current user's own driver profile */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const profile = await prisma.driver_profile.findFirst({
      where: { user_id: userId },
      include: {
        user: true,
        booking_type: true,
        active_trip: true,
        vehicle: { include: { vehicle_types: true } },
        driver_delivery_profile: true,
      },
    });
    if (!profile) return res.status(404).json({ error: 'Driver profile not found' });
    res.json({
      ...profile,
      ...(profile.driver_delivery_profile || {}),
      acceptance_rate: computeDriverAcceptanceRate(profile),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch driver profile' });
  }
});

/**
 * Get single driver profile
 */
router.get('/:driver_profile_id', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const driver = await prisma.driver_profile.findUnique({
      where: { driver_profile_id: Number(req.params.driver_profile_id) },
      include: {
        user: true,
        booking_type: true,
        active_trip: true,
        carpool_offer: true,
        vehicle: true,
      },
    });

    if (!driver) return res.status(404).json({ error: 'Driver profile not found' });

    const denied = assertDriverProfileOwnedByUser(driver, userId);
    if (denied) {
      return res.status(denied.status).json({ successful: false, message: denied.message });
    }

    res.json(driver);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch driver profile' });
  }
});

/**
 * Create driver profile
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const {
      license_number,
      license_expiry,
      is_online,
      current_lat,
      current_long,
      last_ping,
      rating,
      booking_type_id,
    } = req.body;

    if (!license_number) {
      return res.status(400).json({ error: 'license_number is required' });
    }

    const newDriver = await prisma.driver_profile.create({
      data: {
        user_id: userId,
        license_number,
        license_expiry: license_expiry ? new Date(license_expiry) : null,
        is_online: is_online ?? false,
        current_lat,
        current_long,
        last_ping: last_ping ? new Date(last_ping) : new Date(),
        rating,
        booking_type_id,
      },
    });

    io?.emit('driver-profile-created', newDriver);

    res.status(201).json(newDriver);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create driver profile' });
  }
});

/**
 * Update driver profile
 * NOTE: is_online is intentionally excluded here — use PATCH /me/status or
 * PATCH /:driver_profile_id/status to change online status. Excluding it from the
 * generic PUT prevents accidental resets when the frontend sends profile updates
 * (e.g. location sync) that do not intend to change the driver's online/offline state.
 */
router.put('/:driver_profile_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { driver_profile_id } = req.params;
    const {
      license_number,
      license_expiry,
      current_lat,
      current_long,
      last_ping,
      rating,
      booking_type_id,
    } = req.body;

    const existing = await prisma.driver_profile.findUnique({
      where: { driver_profile_id: Number(driver_profile_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Driver profile not found' });

    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const denied = assertDriverProfileOwnedByUser(existing, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    const updatedDriver = await prisma.driver_profile.update({
      where: { driver_profile_id: Number(driver_profile_id) },
      data: {
        license_number,
        license_expiry: license_expiry ? new Date(license_expiry) : existing.license_expiry,
        // is_online is NOT updated here — use the dedicated status endpoints
        current_lat,
        current_long,
        last_ping: last_ping ? new Date(last_ping) : existing.last_ping,
        rating,
        booking_type_id,
      },
    });

    io?.emit('driver-profile-updated', updatedDriver);

    res.json(updatedDriver);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update driver profile' });
  }
});

/**
 * Delete driver profile
 */
router.delete('/:driver_profile_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const driver_profile_id = Number(req.params.driver_profile_id);
    const existing = await prisma.driver_profile.findUnique({
      where: { driver_profile_id },
    });
    if (!existing) return res.status(404).json({ error: 'Driver profile not found' });

    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const denied = assertDriverProfileOwnedByUser(existing, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    // Soft-archive KYC docs first so compliance artifacts survive profile removal (#1296).
    // FK is ON DELETE SET NULL; deleted_at marks the archive explicitly.
    await prisma.$transaction(async (tx) => {
      await tx.driver_document.updateMany({
        where: { driver_profile_id, deleted_at: null },
        data: { deleted_at: new Date() },
      });
      await tx.driver_profile.delete({
        where: { driver_profile_id },
      });
    });

    io?.emit('driver-profile-deleted', { driver_profile_id });

    res.json({ message: 'Driver profile deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete driver profile' });
  }
});



/**
 * PATCH /driver-profile/me/status — toggle status using the authenticated user's profile
 */
router.patch('/me/status', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const validated = statusSchema.safeParse(req.body);
    if (!validated.success) {
      return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });
    }
    const { is_online, current_lat, current_long } = validated.data;

    const profile = await syncDriverOnlineStatusForUser(prisma, userId, {
      is_online,
      current_lat,
      current_long,
    });
    return res.json({ successful: true, driver_profile_id: profile.driver_profile_id, is_online: profile.is_online });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * PATCH /driver-profile/me/preferences — per-vertical opt-in toggles (accepts_rides,
 * accepts_food, accepts_product, accepts_courier). Independent of is_online: a driver can
 * flip these while offline; they only affect matching once online. GET /me already returns
 * the full driver_profile row, so these are readable there with no separate GET needed.
 * Get-or-creates the driver_profile (mirrors syncDriverOnlineStatusForUser/PATCH /me/status) —
 * a brand-new driver setting Job Types during onboarding has no row yet.
 */
router.patch('/me/preferences', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const validated = preferencesSchema.safeParse(req.body);
    if (!validated.success) {
      return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });
    }

    const profile = await resolveDriverProfileForUser(prisma, userId)
      ?? await prisma.driver_profile.create({ data: { user_id: userId } });

    const {
      has_cold_bag,
      supports_heavy_items,
      max_heavy_item_kg,
      max_batch_orders,
      max_batch_distance_km,
      delivery_vehicle_class,
      ...driverPrefs
    } = validated.data;
    const deliveryPrefs = {
      ...(has_cold_bag !== undefined ? { has_cold_bag } : {}),
      ...(supports_heavy_items !== undefined ? { supports_heavy_items } : {}),
      ...(max_heavy_item_kg !== undefined ? { max_heavy_item_kg } : {}),
      ...(max_batch_orders !== undefined ? { max_batch_orders } : {}),
      ...(max_batch_distance_km !== undefined ? { max_batch_distance_km } : {}),
      ...(delivery_vehicle_class !== undefined ? { delivery_vehicle_class } : {}),
    };
    const updated = Object.keys(driverPrefs).length
      ? await prisma.driver_profile.update({
          where: { driver_profile_id: profile.driver_profile_id },
          data: driverPrefs,
        })
      : profile;
    let deliveryProfile = null;
    if (Object.keys(deliveryPrefs).length > 0 || updated.accepts_food || updated.accepts_product) {
      if (Object.keys(deliveryPrefs).length > 0) {
        deliveryProfile = await prisma.driver_delivery_profile.upsert({
          where: { driver_profile_id: profile.driver_profile_id },
          create: {
            driver_profile_id: profile.driver_profile_id,
            ...deliveryPrefs,
          },
          update: deliveryPrefs,
        });
      } else {
        deliveryProfile = await prisma.driver_delivery_profile.findUnique({
          where: { driver_profile_id: profile.driver_profile_id },
        }) ?? await prisma.driver_delivery_profile.create({
          data: { driver_profile_id: profile.driver_profile_id },
        });
      }
    }

    return res.json({
      successful: true,
      data: {
        accepts_rides: updated.accepts_rides,
        accepts_food: updated.accepts_food,
        accepts_product: updated.accepts_product,
        accepts_courier: updated.accepts_courier,
        ...(deliveryProfile ? {
          has_cold_bag: deliveryProfile.has_cold_bag,
          supports_heavy_items: deliveryProfile.supports_heavy_items,
          max_heavy_item_kg: deliveryProfile.max_heavy_item_kg,
          max_batch_orders: deliveryProfile.max_batch_orders,
          max_batch_distance_km: deliveryProfile.max_batch_distance_km,
          delivery_vehicle_class: deliveryProfile.delivery_vehicle_class,
        } : {}),
      },
    });
  } catch (err) {
    console.error('Driver Preferences Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /driver-profile/me/incoming-delivery-offers
 * Poll fallback: the authenticated driver's own currently-offered food/product orders.
 * Mirrors GET /ride-request/driver/incoming — returns only offers actually assigned to
 * this driver by dispatch, not a browse-all-unassigned list.
 */
router.get('/me/incoming-delivery-offers', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const profile = await resolveDriverProfileForUser(prisma, userId);
    if (!profile || profile.is_online !== true) {
      return res.json({ successful: true, data: [] });
    }

    const offers = await getIncomingDeliveryOffersForDriver(profile.driver_profile_id);
    return res.json({ successful: true, data: offers });
  } catch (err) {
    console.error('Driver Incoming Delivery Offers Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /driver-profile/me/orders — the authenticated driver's non-terminal orders across every
 * vertical (food/product/courier — rides show up via the existing active-trip surface instead).
 * Exists because getBusyDriverProfileIds() (utils/driver-busy.js) treats ANY non-terminal order
 * as "busy" indefinitely — there's no timeout/expiry for these three verticals (unlike rides,
 * which have ride-timeout-cron.js/ride-noshow-cron.js). An order abandoned mid-flow (app crash,
 * dropped connection, a customer who goes dark) used to silently and permanently block that
 * driver from ever being offered a new job again, with zero indication anywhere in their UI that
 * something was wrong. This surfaces those orders so the driver can see them and, if genuinely
 * stuck, cancel out of one via the endpoint below instead of being stuck forever.
 */
router.get('/me/orders', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const profileIds = await driverProfileIdsForUser(userId);
    if (!profileIds.length) return res.json({ successful: true, data: [] });

    const [foodOrders, productOrders, courierOrders] = await Promise.all([
      prisma.food_order.findMany({
        where: { driver_id: { in: profileIds }, order_status: { notIn: ['delivered', 'cancelled'] } },
        select: {
          food_order_id: true, order_status: true, deliver_location: true,
          total_amount: true, created_at: true, last_update: true,
          food_vendor: { select: { vendor_name: true, location: true, lat: true, long: true } },
        },
        orderBy: { created_at: 'desc' },
      }),
      prisma.product_order.findMany({
        where: { driver_id: { in: profileIds }, status: { notIn: ['fulfilled', 'cancelled'] } },
        select: {
          order_id: true, status: true, delivery_address: true,
          total: true, order_time: true,
        },
        orderBy: { order_time: 'desc' },
      }),
      prisma.courier_order.findMany({
        where: {
          courier_service_provider_id: { in: profileIds },
          OR: [{ status: { notIn: ['delivered', 'cancelled'] } }, { status: null }],
        },
        select: {
          courier_order_id: true, status: true, end_location_address: true,
          price: true, pickup_date: true, last_update: true,
        },
        orderBy: { last_update: 'desc' },
      }),
    ]);

    const data = [
      ...foodOrders.map((o) => ({
        vertical: 'food',
        order_id: o.food_order_id,
        status: o.order_status || 'unknown',
        counterparty: o.food_vendor?.vendor_name ?? null,
        // Live restaurant address — driver Active Ride must refresh from this, not a frozen accept-time snapshot.
        pickup_location: o.food_vendor?.location || o.food_vendor?.vendor_name || null,
        dropoff_location: publicDeliverLocation(o),
        address: publicDeliverLocation(o),
        amount: o.total_amount,
        updated_at: o.last_update ?? o.created_at,
      })),
      ...productOrders.map((o) => ({
        vertical: 'product',
        order_id: o.order_id,
        status: o.status || 'unknown',
        counterparty: null,
        address: o.delivery_address,
        amount: o.total,
        updated_at: o.order_time,
      })),
      ...courierOrders.map((o) => ({
        vertical: 'courier',
        order_id: o.courier_order_id,
        status: o.status || 'pending',
        counterparty: null,
        address: o.end_location_address,
        amount: o.price,
        updated_at: o.last_update ?? o.pickup_date,
      })),
    ].sort((a, b) => new Date(b.updated_at ?? 0) - new Date(a.updated_at ?? 0));

    return res.json({ successful: true, data });
  } catch (err) {
    console.error('Driver My Orders Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

const CANCEL_VERTICALS = new Set(['food', 'product', 'courier']);

/**
 * PATCH /driver-profile/me/orders/:vertical/:order_id/cancel — self-service escape hatch for a
 * driver whose order is genuinely stuck (see GET /me/orders above). Files an admin-visible
 * bug_report (driver_support category — same board Item 5 already ships) so support has a
 * record of *why*, rather than the order just silently disappearing.
 */
router.patch('/me/orders/:vertical/:order_id/cancel', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const vertical = String(req.params.vertical || '').toLowerCase();
    if (!CANCEL_VERTICALS.has(vertical)) {
      return res.status(400).json({ successful: false, message: 'Unsupported order type' });
    }
    const orderId = Number(req.params.order_id);
    if (!Number.isInteger(orderId)) {
      return res.status(400).json({ successful: false, message: 'Invalid order_id' });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';

    const profileIds = await driverProfileIdsForUser(userId);
    if (!profileIds.length) return res.status(404).json({ successful: false, message: 'Driver profile not found' });

    let orderLabel;
    let customerUserId = null;

    if (vertical === 'food') {
      const order = await prisma.food_order.findUnique({ where: { food_order_id: orderId } });
      if (!order || !profileIds.includes(order.driver_id)) {
        return res.status(404).json({ successful: false, message: 'Order not found' });
      }
      if (['delivered', 'cancelled'].includes(order.order_status)) {
        return res.status(409).json({ successful: false, message: 'Order is already closed out' });
      }
      await prisma.food_order.update({ where: { food_order_id: orderId }, data: { order_status: 'cancelled' } });
      customerUserId = order.user_id;
      if (io && customerUserId) io.to(`user-${customerUserId}`).emit(`order-status-update-${orderId}`, { order_status: 'cancelled' });
      orderLabel = `Food order #${orderId}`;
    } else if (vertical === 'product') {
      const order = await prisma.product_order.findUnique({ where: { order_id: orderId } });
      if (!order || !profileIds.includes(order.driver_id)) {
        return res.status(404).json({ successful: false, message: 'Order not found' });
      }
      if (['fulfilled', 'cancelled'].includes(order.status)) {
        return res.status(409).json({ successful: false, message: 'Order is already closed out' });
      }
      const updated = await prisma.product_order.update({ where: { order_id: orderId }, data: { status: 'cancelled' } });
      customerUserId = order.buyer_id;
      emitProductOrderStatusUpdate(io, updated, { status: 'cancelled' });
      orderLabel = `Product order #${orderId}`;
    } else {
      const order = await prisma.courier_order.findUnique({ where: { courier_order_id: orderId } });
      if (!order || !profileIds.includes(order.courier_service_provider_id)) {
        return res.status(404).json({ successful: false, message: 'Order not found' });
      }
      if (['delivered', 'cancelled'].includes(order.status)) {
        return res.status(409).json({ successful: false, message: 'Order is already closed out' });
      }
      await prisma.courier_order.update({ where: { courier_order_id: orderId }, data: { status: 'cancelled', last_update: new Date() } });
      customerUserId = order.customer_id;
      if (io && customerUserId) io.to(`user-${customerUserId}`).emit(`courier-cancelled-${orderId}`, { status: 'cancelled' });
      orderLabel = `Courier order #${orderId}`;
    }

    if (io && customerUserId) {
      notify(io, {
        userId: customerUserId,
        vertical,
        type: 'order.cancelled',
        title: 'Your order was cancelled',
        body: 'The driver reported a problem completing this order.',
        urgency: 'ambient',
        entityType: `${vertical}_order`,
        entityId: orderId,
      }).catch(() => {});
    }

    await prisma.bug_report.create({
      data: {
        user_id: userId,
        title: `Driver-cancelled order: ${orderLabel}`,
        description: reason || 'No reason given.',
        category: 'driver_support',
        severity: 'medium',
      },
    }).catch((err) => console.error('[driver-orders] failed to file support ticket for cancelled order:', err));

    return res.json({ successful: true, message: 'Order cancelled.' });
  } catch (err) {
    console.error('Driver Order Cancel Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * Task 1: Toggle Driver Online/Offline Status
 * PATCH /driver-profile/:driver_profile_id/status
 */
router.patch('/:driver_profile_id/status', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const driver_profile_id = Number(req.params.driver_profile_id);

    const existing = await prisma.driver_profile.findUnique({ where: { driver_profile_id } });
    if (!existing) return res.status(404).json({ successful: false, message: 'Driver profile not found' });

    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const denied = assertDriverProfileOwnedByUser(existing, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    const validated = statusSchema.safeParse(req.body);
    if (!validated.success) {
      return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });
    }

    const { is_online, current_lat, current_long } = validated.data;

    const updatedDriver = await syncDriverOnlineStatusForUser(prisma, userId, {
      is_online,
      current_lat,
      current_long,
    });

    io.emit('driver-status-changed', {
      driver_profile_id: updatedDriver.driver_profile_id,
      is_online: updatedDriver.is_online,
    });

    return res.json({ successful: true, data: updatedDriver });

  } catch (err) {
    console.error('Status Update Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * DRIVER ANALYTICS OVERVIEW (earnings + trips, range-aware)
 * GET /driver-profile/analytics/overview?range=7d|28d|90d|365d|lifetime
 *
 * Unified analytics shape: summary (gross/net/count + deltas), per-day timeseries,
 * breakdown (trips by payment method). No "top" list (rideshare has no catalogue).
 *
 * Money model mirrors /earnings/today: gross = active_trip.total_fare; net =
 * driver_payout when set, else total_fare * 0.79 (the driver's 79% share). Trips
 * are bucketed by ended_at (completion), so only completed trips are counted.
 */
router.get('/analytics/overview', authenticateToken, async (req, res, next) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const rangeParam = resolveRangeParam(req.query.range);
    const days = RANGE_DAYS[rangeParam];
    const { start, prevStart, prevEnd } = resolveRange(days);

    const grossOf = t => t.total_fare || 0;
    // Tips bypass the 79/21 fare split entirely — 100% to the driver, added on top of payout.
    const netOf = t => (t.driver_payout != null ? t.driver_payout : (t.total_fare != null ? t.total_fare * 0.79 : 0)) + (t.tip_amount || 0);

    const emptySeries = buildEarningsSeries({ rows: [], dateField: 'ended_at', gross: grossOf, net: netOf, start, days });

    const profile = await resolveDriverProfileForUser(prisma, userId);
    if (!profile) {
      return res.json({ successful: true, data: { range: rangeParam, currency: 'CAD', summary: emptySeries.summary, timeseries: emptySeries.timeseries, breakdown: [], top: [] } });
    }
    const driver_id = profile.driver_profile_id;

    const baseSelect = { total_fare: true, driver_payout: true, tip_amount: true, payment_method: true, actual_distance_km: true, ended_at: true };
    const [rows, prevRows] = await Promise.all([
      prisma.active_trip.findMany({ where: { driver_id, ended_at: { gte: start } }, select: baseSelect }),
      prisma.active_trip.findMany({ where: { driver_id, ended_at: { gte: prevStart, lte: prevEnd } }, select: { total_fare: true, driver_payout: true, tip_amount: true } }),
    ]);

    const { timeseries, summary } = buildEarningsSeries({ rows, prevRows, dateField: 'ended_at', gross: grossOf, net: netOf, start, days });
    // surface total distance as an extra summary metric (km)
    summary.total_distance_km = round2(rows.reduce((s, t) => s + (t.actual_distance_km || 0), 0));

    // breakdown: trips by payment method
    const payMap = new Map();
    rows.forEach(t => { const k = (t.payment_method || 'unknown').toUpperCase(); payMap.set(k, (payMap.get(k) || 0) + 1); });
    const breakdown = [...payMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

    // ── Reliability & rating metrics (the "Performance" grid the panel renders) ──
    // Ratings for this driver's trips completed in the range, plus their lifetime score.
    const ratingRows = await prisma.ride_rating.findMany({
      where: { active_trip: { driver_id, ended_at: { gte: start } } },
      select: { rating: true },
    });
    const ratingCount = ratingRows.length;
    const recentAvg = ratingCount ? round2(ratingRows.reduce((s, r) => s + (r.rating || 0), 0) / ratingCount) : null;
    const fiveStarPct = ratingCount ? round2((ratingRows.filter(r => r.rating === 5).length / ratingCount) * 100) : null;
    const lifetimeRating = profile.rating != null ? round2(profile.rating) : null;
    const avgDistance = summary.count ? round2(summary.total_distance_km / summary.count) : 0;

    // Lifetime, not range-scoped — accept_count/decline_count on driver_profile are running
    // totals with no timestamp per event, so there's no windowed breakdown to compute (same
    // caveat as lifetime_rating above). No cancel_rate here: drivers have no way to cancel an
    // active trip in this codebase today (cancellation is either pre-accept/system-triggered or
    // passenger-initiated — see cancelRideRequest in utils/ride-dispatch.js), so a "driver
    // cancel rate" would always read zero. Add it once a driver-cancel-trip action exists.
    const acceptDecided = profile.accept_count + profile.decline_count;
    const acceptRate = acceptDecided ? round2((profile.accept_count / acceptDecided) * 100) : null;

    const metrics = [
      { key: 'lifetime_rating', label: 'Lifetime rating', value: lifetimeRating, format: 'rating', hint: 'Your all-time average star rating', tone: lifetimeRating == null ? 'neutral' : (lifetimeRating >= 4.7 ? 'good' : lifetimeRating >= 4 ? 'neutral' : 'warn') },
      { key: 'recent_rating', label: 'Recent rating', value: recentAvg, format: 'rating', hint: `Average across ${ratingCount} rating${ratingCount === 1 ? '' : 's'} this period`, tone: recentAvg == null ? 'neutral' : (lifetimeRating != null && recentAvg >= lifetimeRating ? 'good' : 'warn') },
      { key: 'five_star_pct', label: '5-star share', value: fiveStarPct, format: 'pct', hint: 'Share of this period’s ratings that were 5 stars', tone: fiveStarPct == null ? 'neutral' : (fiveStarPct >= 80 ? 'good' : 'neutral') },
      { key: 'avg_distance', label: 'Avg distance / trip', value: avgDistance, format: 'distance', hint: 'Average kilometres per completed trip', tone: 'neutral' },
      { key: 'accept_rate', label: 'Acceptance rate', value: acceptRate, format: 'pct', hint: 'Lifetime share of offers you accepted', tone: acceptRate == null ? 'neutral' : (acceptRate >= 80 ? 'good' : acceptRate >= 50 ? 'neutral' : 'warn') },
    ];

    res.json({ successful: true, data: { range: rangeParam, currency: 'CAD', summary, timeseries, breakdown, top: [], metrics } });
  } catch (err) { next(err); }
});

export default router;
