import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

const ACTIVE_STATUSES = ['pending', 'confirmed', 'seated'];
const ALL_STATUSES = ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'];

const VENDOR_PUBLIC_SELECT = {
  vendor_id: true,
  owner_id: true,
  vendor_name: true,
  cuisine_type: true,
  location: true,
  lat: true,
  long: true,
  logo_url: true,
  cover_url: true,
  banner_url: true,
  description: true,
  price_level: true,
  opening_hours: true,
  closing_hours: true,
  weekly_hours: true,
  reservation_hours: true,
  gallery: true,
  reservation_policy: true,
  accepts_reservations: true,
  reservation_duration_min: true,
  reservation_buffer_min: true,
  max_party_size: true,
  min_party_size: true,
  is_open: true,
  is_active: true,
  is_paused: true,
};

function minutesOfDay(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function formatHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function dayKey(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getDay()];
}

function resolveOpenClose(vendor, dateStr) {
  const key = dayKey(dateStr);
  const weekly = vendor.weekly_hours || vendor.reservation_hours;
  if (weekly && typeof weekly === 'object' && key && weekly[key]) {
    const day = weekly[key];
    if (day.closed) return null;
    return { open: day.open || day.from, close: day.close || day.to };
  }
  if (vendor.opening_hours && vendor.closing_hours) {
    return { open: vendor.opening_hours, close: vendor.closing_hours };
  }
  return { open: '11:00', close: '22:00' };
}

function slotsForVendor(vendor, dateStr, partySize) {
  const hours = resolveOpenClose(vendor, dateStr);
  if (!hours) return [];
  const open = minutesOfDay(hours.open);
  const close = minutesOfDay(hours.close);
  if (open == null || close == null || close <= open) return [];
  const duration = vendor.reservation_duration_min || 90;
  const step = 30;
  const slots = [];
  for (let t = open; t + duration <= close; t += step) {
    slots.push(formatHHMM(t));
  }
  // party size filter is applied after capacity check
  if (partySize != null) {
    const min = vendor.min_party_size || 1;
    const max = vendor.max_party_size || 12;
    if (partySize < min || partySize > max) return [];
  }
  return slots;
}

function rangesOverlap(aStart, aDur, bStart, bDur) {
  const a0 = minutesOfDay(aStart);
  const b0 = minutesOfDay(bStart);
  if (a0 == null || b0 == null) return false;
  const a1 = a0 + (aDur || 90);
  const b1 = b0 + (bDur || 90);
  return a0 < b1 && b0 < a1;
}

async function assertVendorOwner(vendorId, userId) {
  const vendor = await prisma.food_vendor.findUnique({
    where: { vendor_id: vendorId },
    include: {
      seating_areas: { where: { is_active: true }, orderBy: { sort_order: 'asc' } },
      tables: { where: { is_active: true } },
    },
  });
  if (!vendor) return { error: 'Restaurant not found', status: 404 };
  if (vendor.owner_id !== userId) return { error: 'Forbidden', status: 403 };
  return { vendor };
}

async function findAvailableTable(tx, vendor, { date, time, party_size, seating_area_id, duration_min }) {
  const tables = await tx.restaurant_table.findMany({
    where: {
      vendor_id: vendor.vendor_id,
      is_active: true,
      min_seats: { lte: party_size },
      max_seats: { gte: party_size },
      ...(seating_area_id ? { seating_id: seating_area_id } : {}),
    },
    orderBy: { max_seats: 'asc' },
  });

  if (!tables.length) {
    // No physical tables configured — fall back to soft capacity using seating areas or max party.
    const existing = await tx.reservation.findMany({
      where: {
        vendor_id: vendor.vendor_id,
        date,
        status: { in: ACTIVE_STATUSES },
      },
    });
    const overlapping = existing.filter((r) =>
      rangesOverlap(time, duration_min, r.time, r.duration_min || vendor.reservation_duration_min || 90),
    );
    const seatsUsed = overlapping.reduce((s, r) => s + r.party_size, 0);
    const softCap = (vendor.tables?.length ? 0 : (vendor.max_party_size || 40));
    // When no tables exist, allow up to ~4 concurrent parties worth of seats.
    const capacity = softCap * 4;
    if (seatsUsed + party_size > capacity) return { error: 'No tables available for that time' };
    return { table: null };
  }

  const existing = await tx.reservation.findMany({
    where: {
      vendor_id: vendor.vendor_id,
      date,
      status: { in: ACTIVE_STATUSES },
      table_id: { not: null },
    },
  });

  for (const table of tables) {
    const conflict = existing.some((r) =>
      r.table_id === table.table_id &&
      rangesOverlap(time, duration_min, r.time, r.duration_min || vendor.reservation_duration_min || 90),
    );
    if (!conflict) return { table };
  }
  return { error: 'No tables available for that time' };
}

// GET /reservation/restaurants — bookable food vendors with menu summary
router.get('/restaurants', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const cuisine = typeof req.query.cuisine === 'string' ? req.query.cuisine : '';
    const where = {
      is_active: true,
      accepts_reservations: true,
      // is_paused is nullable; `{ not: true }` would drop legacy NULL rows in SQL.
      AND: [{ OR: [{ is_paused: false }, { is_paused: null }] }],
    };
    if (cuisine && cuisine !== 'All') where.cuisine_type = cuisine;
    if (q) {
      where.OR = [
        { vendor_name: { contains: q, mode: 'insensitive' } },
        { location: { contains: q, mode: 'insensitive' } },
        { cuisine_type: { contains: q, mode: 'insensitive' } },
      ];
    }

    const vendors = await prisma.food_vendor.findMany({
      where,
      select: {
        ...VENDOR_PUBLIC_SELECT,
        seating_areas: { where: { is_active: true }, orderBy: { sort_order: 'asc' } },
        tables: { where: { is_active: true } },
        food_category: {
          include: {
            food_item: {
              where: { is_available: true },
              take: 40,
              include: {
                food_item_pics: true,
                food_item_modifier_group: {
                  include: { options: true },
                },
              },
            },
          },
        },
      },
      orderBy: { vendor_id: 'desc' },
      take: 100,
    });

    const mapped = vendors.map((v) => {
      const menu = (v.food_category || []).flatMap((cat) =>
        (cat.food_item || []).map((item) => ({
          id: item.food_item_id,
          category: cat.name || 'Menu',
          name: item.name,
          price: item.price,
          description: item.description,
          image: item.food_item_pics?.[0]?.url || null,
        })),
      );
      return {
        ...v,
        menu,
        food_category: undefined,
      };
    });

    return res.json({ successful: true, data: mapped });
  } catch (err) {
    console.error('GET /reservation/restaurants error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to fetch restaurants' });
  }
});

// GET /reservation/restaurants/:vendorId — full restaurant + menu + seating
router.get('/restaurants/:vendorId', async (req, res) => {
  try {
    const vendorId = Number(req.params.vendorId);
    if (Number.isNaN(vendorId)) return res.status(400).json({ successful: false, message: 'Invalid vendor id' });

    const vendor = await prisma.food_vendor.findFirst({
      where: { vendor_id: vendorId, is_active: true },
      select: {
        ...VENDOR_PUBLIC_SELECT,
        seating_areas: { where: { is_active: true }, orderBy: { sort_order: 'asc' }, include: { tables: true } },
        tables: { where: { is_active: true } },
        food_category: {
          include: {
            food_item: {
              include: {
                food_item_pics: true,
                food_item_modifier_group: { include: { options: true } },
              },
            },
          },
        },
      },
    });
    if (!vendor) return res.status(404).json({ successful: false, message: 'Restaurant not found' });

    const menu = (vendor.food_category || []).flatMap((cat) =>
      (cat.food_item || []).map((item) => ({
        id: item.food_item_id,
        category: cat.name || 'Menu',
        name: item.name,
        price: item.price,
        description: item.description,
        image: item.food_item_pics?.[0]?.url || null,
        modifiers: item.food_item_modifier_group || [],
      })),
    );

    return res.json({ successful: true, data: { ...vendor, menu, food_category: undefined } });
  } catch (err) {
    console.error('GET /reservation/restaurants/:id error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to fetch restaurant' });
  }
});

// GET /reservation/availability?vendor_id=&date=&party_size=&seating_area_id=
router.get('/availability', async (req, res) => {
  try {
    const vendor_id = Number(req.query.vendor_id);
    const date = String(req.query.date || '');
    const party_size = Number(req.query.party_size || 2);
    const seating_area_id = req.query.seating_area_id ? Number(req.query.seating_area_id) : null;
    if (!vendor_id || !date) {
      return res.status(400).json({ successful: false, message: 'vendor_id and date required' });
    }

    const vendor = await prisma.food_vendor.findUnique({
      where: { vendor_id },
      include: { tables: { where: { is_active: true } }, seating_areas: true },
    });
    if (!vendor || !vendor.accepts_reservations) {
      return res.status(404).json({ successful: false, message: 'Restaurant not bookable' });
    }

    const candidateSlots = slotsForVendor(vendor, date, party_size);
    const duration = vendor.reservation_duration_min || 90;
    const available = [];

    for (const time of candidateSlots) {
      const result = await findAvailableTable(prisma, vendor, {
        date, time, party_size, seating_area_id, duration_min: duration,
      });
      if (!result.error) available.push(time);
    }

    return res.json({
      successful: true,
      data: {
        vendor_id,
        date,
        party_size,
        duration_min: duration,
        slots: available,
        hours: resolveOpenClose(vendor, date),
      },
    });
  } catch (err) {
    console.error('GET /reservation/availability error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to check availability' });
  }
});

// POST /reservation — create table reservation with conflict check
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const user_id = req.user.user_id;
    const {
      vendor_id, date, time, party_size, special_notes,
      seating_area_id, guest_name, guest_phone, guest_email,
    } = req.body;

    if (!vendor_id || !date || !time || !party_size) {
      return res.status(400).json({ successful: false, message: 'vendor_id, date, time, and party_size are required' });
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(5252, ${Number(vendor_id)}::int4)`;

      const vendor = await tx.food_vendor.findUnique({
        where: { vendor_id: Number(vendor_id) },
        include: { tables: true, seating_areas: true },
      });
      if (!vendor || !vendor.is_active || !vendor.accepts_reservations) {
        return { error: 'Restaurant not available', status: 404 };
      }
      if (vendor.owner_id === user_id) {
        return { error: 'You cannot book your own restaurant', status: 400 };
      }

      const size = Number(party_size);
      if (size < (vendor.min_party_size || 1) || size > (vendor.max_party_size || 12)) {
        return { error: `Party size must be between ${vendor.min_party_size || 1} and ${vendor.max_party_size || 12}`, status: 400 };
      }

      const openSlots = slotsForVendor(vendor, date, size);
      if (!openSlots.includes(time)) {
        return { error: 'Selected time is outside reservation hours', status: 400 };
      }

      const duration = vendor.reservation_duration_min || 90;
      const tablePick = await findAvailableTable(tx, vendor, {
        date,
        time,
        party_size: size,
        seating_area_id: seating_area_id ? Number(seating_area_id) : null,
        duration_min: duration,
      });
      if (tablePick.error) return { error: tablePick.error, status: 409 };

      const reservation = await tx.reservation.create({
        data: {
          user_id,
          vendor_id: Number(vendor_id),
          date,
          time,
          party_size: size,
          special_notes: special_notes || null,
          status: 'pending',
          seating_area_id: seating_area_id ? Number(seating_area_id) : (tablePick.table?.seating_id ?? null),
          table_id: tablePick.table?.table_id ?? null,
          duration_min: duration,
          guest_name: guest_name || null,
          guest_phone: guest_phone || null,
          guest_email: guest_email || null,
        },
        include: {
          user: { select: { user_id: true, name: true, username: true } },
          food_vendor: { select: { vendor_id: true, vendor_name: true, owner_id: true } },
        },
      });
      return { reservation, vendor };
    });

    if (result.error) return res.status(result.status).json({ successful: false, message: result.error });

    const vendorUserId = result.reservation.food_vendor?.owner_id;
    if (vendorUserId && io) {
      io.to(`user-${vendorUserId}`).emit(`new-reservation-${vendorUserId}`, {
        reservation_id: result.reservation.reservation_id,
        date,
        time,
        party_size: Number(party_size),
        customer_name: result.reservation.user?.name ?? result.reservation.user?.username ?? 'Guest',
        special_notes: special_notes || null,
      });
    }

    return res.status(201).json({ successful: true, data: result.reservation });
  } catch (err) {
    console.error('POST /reservation error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to create reservation' });
  }
});

// GET /reservation/me — user booking history
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const reservations = await prisma.reservation.findMany({
      where: { user_id: req.user.user_id },
      include: {
        food_vendor: {
          select: {
            vendor_id: true, vendor_name: true, location: true, logo_url: true, cover_url: true, cuisine_type: true,
          },
        },
        seating_area: true,
        table: true,
      },
      orderBy: { created_at: 'desc' },
    });

    return res.json({ successful: true, data: reservations });
  } catch (err) {
    console.error('GET /reservation/me error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to fetch reservations' });
  }
});

// GET /reservation?vendor_id=X — restaurant sees incoming bookings
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { vendor_id } = req.query;

    if (!vendor_id) {
      return res.status(400).json({ successful: false, message: 'vendor_id query param required' });
    }

    const owned = await assertVendorOwner(Number(vendor_id), req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });

    const reservations = await prisma.reservation.findMany({
      where: { vendor_id: Number(vendor_id) },
      include: {
        user: { select: { user_id: true, name: true, username: true } },
        seating_area: true,
        table: true,
      },
      orderBy: { created_at: 'desc' },
    });

    return res.json({ successful: true, data: reservations });
  } catch (err) {
    console.error('GET /reservation error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to fetch reservations' });
  }
});

// PATCH /reservation/:id — status transitions
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!ALL_STATUSES.includes(status)) {
      return res.status(400).json({
        successful: false,
        message: `status must be one of: ${ALL_STATUSES.join(', ')}`,
      });
    }

    const existing = await prisma.reservation.findUnique({
      where: { reservation_id: Number(id) },
      include: { food_vendor: { select: { owner_id: true } } },
    });
    if (!existing) return res.status(404).json({ successful: false, message: 'Reservation not found' });

    const isOwner = existing.food_vendor.owner_id === req.user.user_id;
    const isGuest = existing.user_id === req.user.user_id;
    if (!isOwner && !(isGuest && status === 'cancelled')) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }

    const updated = await prisma.reservation.update({
      where: { reservation_id: Number(id) },
      data: { status },
    });

    return res.json({ successful: true, data: updated });
  } catch (err) {
    console.error('PATCH /reservation/:id error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to update reservation' });
  }
});

// ── Seller: hours / seating / tables ────────────────────────────────────────

router.put('/vendors/:vendorId/settings', authenticateToken, async (req, res) => {
  try {
    const vendorId = Number(req.params.vendorId);
    const owned = await assertVendorOwner(vendorId, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });

    const b = req.body || {};
    const data = {};
    for (const f of [
      'description', 'price_level', 'reservation_policy', 'opening_hours', 'closing_hours',
    ]) {
      if (b[f] !== undefined) data[f] = b[f];
    }
    for (const f of ['weekly_hours', 'reservation_hours', 'gallery']) {
      if (b[f] !== undefined) data[f] = b[f];
    }
    if (b.accepts_reservations !== undefined) data.accepts_reservations = Boolean(b.accepts_reservations);
    if (b.reservation_duration_min !== undefined) data.reservation_duration_min = Number(b.reservation_duration_min) || 90;
    if (b.reservation_buffer_min !== undefined) data.reservation_buffer_min = Number(b.reservation_buffer_min) || 15;
    if (b.max_party_size !== undefined) {
      // Empty/null means "not configured" — do not coerce to the old default of 12.
      if (b.max_party_size === null || b.max_party_size === "") {
        data.max_party_size = null;
      } else {
        const n = Number(b.max_party_size);
        if (Number.isFinite(n) && n > 0) data.max_party_size = Math.trunc(n);
      }
    }
    if (b.min_party_size !== undefined) data.min_party_size = Number(b.min_party_size) || 1;

    const updated = await prisma.food_vendor.update({
      where: { vendor_id: vendorId },
      data,
      select: VENDOR_PUBLIC_SELECT,
    });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    console.error('PUT /reservation/vendors/:id/settings error:', err);
    return res.status(500).json({ successful: false, message: 'Failed to update settings' });
  }
});

router.post('/vendors/:vendorId/seating', authenticateToken, async (req, res) => {
  try {
    const vendorId = Number(req.params.vendorId);
    const owned = await assertVendorOwner(vendorId, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    const { name, description, capacity, sort_order } = req.body || {};
    if (!name) return res.status(400).json({ successful: false, message: 'name required' });
    const row = await prisma.restaurant_seating.create({
      data: {
        vendor_id: vendorId,
        name,
        description: description ?? null,
        capacity: capacity != null ? Number(capacity) : null,
        sort_order: sort_order != null ? Number(sort_order) : 0,
      },
    });
    return res.status(201).json({ successful: true, data: row });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to create seating area' });
  }
});

router.post('/vendors/:vendorId/tables', authenticateToken, async (req, res) => {
  try {
    const vendorId = Number(req.params.vendorId);
    const owned = await assertVendorOwner(vendorId, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    const { name, min_seats, max_seats, seating_id } = req.body || {};
    if (!name) return res.status(400).json({ successful: false, message: 'name required' });
    const row = await prisma.restaurant_table.create({
      data: {
        vendor_id: vendorId,
        name,
        min_seats: Number(min_seats) || 1,
        max_seats: Number(max_seats) || 4,
        seating_id: seating_id != null ? Number(seating_id) : null,
      },
    });
    return res.status(201).json({ successful: true, data: row });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to create table' });
  }
});

router.delete('/vendors/:vendorId/tables/:tableId', authenticateToken, async (req, res) => {
  try {
    const vendorId = Number(req.params.vendorId);
    const tableId = Number(req.params.tableId);
    const owned = await assertVendorOwner(vendorId, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    await prisma.restaurant_table.updateMany({
      where: { table_id: tableId, vendor_id: vendorId },
      data: { is_active: false },
    });
    return res.json({ successful: true, message: 'Table deactivated' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to delete table' });
  }
});

export default router;
