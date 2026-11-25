import express from 'express';
import Stripe from 'stripe';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { creditRecruiterShares } from '../utils/recruiter-share.js';
import { settleReferralThenRecruit, normalizeReferralCode } from '../utils/referral-settlement.js';
import { platformTakeFromPct } from '../utils/recruiter-settlement.js';
import { PLATFORM_FEE_PERCENTAGE } from '../utils/tax-config.js';
import {
  computeUnits,
  computeQuote,
  checkAvailability,
  canTransition,
  checkHotelRoomAvailability,
  soldOutNightsForRoomType,
  ACTIVE_BOOKING_STATUSES,
  resolveReservationQuantity,
  resolveReservationEndTime,
  listReservationSlots,
  DEFAULT_RESERVATION_TURN_MINUTES,
  attachBookedTodayToListings,
  countBookingsPlacedToday,
  withBookedToday,
  APPOINTMENT_STYLE_VERTICALS,
  appointmentDurationMinutes,
  addMinutesToTime,
  filterHostVisibleBookings,
  hostCanActOnPaidStay,
  shouldNotifyHostOfNewBooking,
  shouldNotifyCounterpartyOfCancel,
  isHostVisibleBooking,
} from '../services/booking-engine.js';
import { handleSubscriptionWebhookEvent } from '../services/live-subscription.js';
import { confirmCoinPurchase } from '../services/live-coins.js';
import { creditArtistBookingOnPaid, failArtistBookingIfPending } from '../utils/artist-booking-settlement.js';
import { refundMechanicBookingToWallet, payoutMechanicOnComplete } from '../utils/mechanic-booking-settlement.js';
import {
  tryCreditSettledBooking,
  reverseBookingWalletCredit,
} from '../services/booking-host-payout.js';
import {
  emitBookingConfirmedMail,
  emitBookingRequestMail,
} from '../utils/booking-vertical-mail.js';
import bookingHostWalletRouter from './booking-host-wallet-routes.js';
import { loadOrderForEmail, queueShopOrderPlacedEmails } from '../utils/product-order-email.js';
import { decrementListingStockForOrder } from '../utils/shop-order-stock.js';
import { notify as notifyUnified } from '../services/notify.js';
import {
  RANGE_DAYS,
  resolveRangeParam,
  resolveRange,
  resolveAnalyticsTimeZone,
  buildEarningsSeries,
  round2 as roundMoney,
} from '../utils/analytics-buckets.js';
import {
  KNOWN_BOOKING_VERTICALS,
  parseBookingVertical,
  verticalWhereClause,
} from '../utils/booking-vertical.js';
import { parseListingBrowseFilters } from '../utils/booking-listing-filters.js';
import { filterListingsByRadius, parseListingGeoQuery } from '../utils/booking-listing-geo.js';
import {
  expandMedicalSearchTerms,
  parseMedicalInsuranceFilter,
  medicalInsuranceWhere,
} from '../utils/medical-search.js';
import { normalizeSingleUnitCapacity, validatePartySize } from '../utils/booking-capacity.js';
import { validateReservationListingConfig } from '../utils/reservation-listing-config.js';

const router = express.Router();

router.use(bookingHostWalletRouter);

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const KNOWN_VERTICALS = new Set(KNOWN_BOOKING_VERTICALS);
// #305 — physical-property verticals must carry an address to be published
// (a stay/hotel/venue with no location can't be found or fulfilled). The address
// is stored but stays private on the public listing view.
const LOCATION_REQUIRED_VERTICALS = new Set(['tempstay', 'hotel', 'venue']);

// Vehicle protection plans are a per-rental-day add-on the guest selects.
// Priced server-side (the client can't influence the charged amount) so the
// chosen tier is actually billed; mirrors VEHICLE_PROTECTION_PLANS on the FE.
const VEHICLE_PROTECTION_PER_DAY = { basic: 14, standard: 28, premium: 45 };

// ── helpers ────────────────────────────────────────────────────────────────

function asInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Fold host-facing reservation config fields into attributes so clients can
 * send either nested `attributes.*` or top-level keys (tables, seating_capacity,
 * turn_time_minutes, service_hours, reservation_hours, time_slots).
 */
function reservationAttributesFromBody(body = {}) {
  const attrs = body.attributes && typeof body.attributes === 'object' && !Array.isArray(body.attributes)
    ? { ...body.attributes }
    : {};
  for (const key of [
    'tables',
    'seating_capacity',
    'turn_time_minutes',
    'turn_minutes',
    'time_slots',
    'service_hours',
    'reservation_hours',
    'food_vendor_id',
    'max_guests',
  ]) {
    if (body[key] !== undefined && attrs[key] === undefined) attrs[key] = body[key];
  }
  return attrs;
}

/**
 * Public-safe user fields for booking party includes.
 * Never expose password/email/tokens — hosts only need identity to greet the guest.
 */
const BOOKING_PARTY_USER_SELECT = {
  user_id: true,
  name: true,
  username: true,
};

/**
 * Base include for list/detail. Guest/host are attached via `attachBookingParty`
 * (separate user lookups) so payment still works when the generated Prisma client
 * is behind schema.prisma relations named `guest` / `host`.
 */
const BOOKING_LIST_INCLUDE = {
  booking_listing: true,
  guest: { select: BOOKING_PARTY_USER_SELECT },
  host: { select: BOOKING_PARTY_USER_SELECT },
  booking_review: {
    select: {
      booking_review_id: true,
      rating: true,
      review: true,
      created_at: true,
    },
  },
};

function parseBookingReviewBody(body = {}) {
  const rawRating = body.rating ?? body.stars ?? body.score;
  const rating = Number(rawRating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: 'rating must be an integer from 1 to 5' };
  }
  const reviewRaw = body.review ?? body.comment ?? body.feedback ?? body.text ?? null;
  const review =
    reviewRaw == null || reviewRaw === ''
      ? null
      : String(reviewRaw).trim().slice(0, 2000) || null;
  return { ok: true, data: { rating, review } };
}

/** Recompute listing avg_rating / review_count and mirror into attributes for older clients. */
async function recomputeListingRating(db, listingId) {
  const agg = await db.booking_review.aggregate({
    where: { booking_listing_id: listingId },
    _avg: { rating: true },
    _count: { _all: true },
  });
  const review_count = agg._count._all || 0;
  const avg_rating =
    agg._avg.rating != null ? Math.round(agg._avg.rating * 10) / 10 : 0;
  const listing = await db.booking_listing.findUnique({
    where: { booking_listing_id: listingId },
    select: { attributes: true },
  });
  const attrs =
    listing?.attributes && typeof listing.attributes === 'object' && !Array.isArray(listing.attributes)
      ? { ...listing.attributes }
      : {};
  attrs.rating = avg_rating;
  attrs.review_count = review_count;
  attrs.reviews = review_count;
  return db.booking_listing.update({
    where: { booking_listing_id: listingId },
    data: { avg_rating, review_count, attributes: attrs },
  });
}

function bookingPartyLabel(user) {
  if (!user) return null;
  const name = typeof user.name === 'string' ? user.name.trim() : '';
  if (name) return name;
  const username = typeof user.username === 'string' ? user.username.trim() : '';
  return username || null;
}

/** Attach guest/host user rows onto one booking or an array of bookings. */
async function attachBookingParty(bookingOrBookings) {
  const list = Array.isArray(bookingOrBookings) ? bookingOrBookings : [bookingOrBookings];
  const ids = new Set();
  for (const b of list) {
    if (!b) continue;
    if (b.guest_id != null) ids.add(b.guest_id);
    if (b.host_id != null) ids.add(b.host_id);
  }
  const users = ids.size
    ? await prisma.user.findMany({
        where: { user_id: { in: [...ids] } },
        select: BOOKING_PARTY_USER_SELECT,
      })
    : [];
  const byId = new Map(users.map((u) => [u.user_id, u]));
  const mapped = list.map((b) => (
    b
      ? {
          ...b,
          guest: byId.get(b.guest_id) ?? null,
          host: byId.get(b.host_id) ?? null,
        }
      : b
  ));
  return Array.isArray(bookingOrBookings) ? mapped : mapped[0];
}

/** For reservation vertical: map guests→quantity and fill end_time from turn window. */
function normalizeReservationBookingBody(listing, body = {}) {
  if (listing?.vertical !== 'reservation') {
    const start_time = body.start_time ?? null;
    // Appointment-style verticals (e.g. mechanic) get a default duration stamped
    // in so the booking-engine's overlap check has an end_time to compare against.
    const end_time = start_time && APPOINTMENT_STYLE_VERTICALS.has(listing?.vertical)
      ? (body.end_time ?? addMinutesToTime(start_time, appointmentDurationMinutes(listing)))
      : (body.end_time ?? null);
    return {
      quantity: body.quantity != null ? asInt(body.quantity) || 1 : 1,
      guests: body.guests != null ? asInt(body.guests) : 1,
      start_time,
      end_time,
    };
  }
  const attrs = listing.attributes && typeof listing.attributes === 'object' ? listing.attributes : {};
  const turn = Number(attrs.turn_time_minutes ?? attrs.turn_minutes) || DEFAULT_RESERVATION_TURN_MINUTES;
  const quantity = resolveReservationQuantity(body);
  const guests = body.guests != null ? (asInt(body.guests) || quantity) : quantity;
  const start_time = body.start_time ?? null;
  const end_time = resolveReservationEndTime(start_time, body.end_time, turn);
  return { quantity, guests, start_time, end_time };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_BOOKING_DAYS = 365; // no single booking spans more than a year

// Reject bookings that start in the past or span an absurd range. Dates are
// optional for date-less verticals (e.g. celebrity/async) — only validated
// when present. Returns an error string, or null when the window is OK.
function validateBookingWindow({ start_date, end_date, start_time }) {
  const todayUTC = (() => {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  })();
  if (start_date) {
    const s = new Date(start_date);
    if (Number.isNaN(s.getTime())) return 'Invalid start date';
    const sUTC = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
    if (sUTC < todayUTC) return 'Cannot book a date in the past';
    if (end_date) {
      const e = new Date(end_date);
      if (Number.isNaN(e.getTime())) return 'Invalid end date';
      const eUTC = Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate());
      if ((eUTC - sUTC) / MS_PER_DAY > MAX_BOOKING_DAYS) {
        return `A booking cannot span more than ${MAX_BOOKING_DAYS} days`;
      }
    }
    if (start_time) {
      const dateKey = String(start_date).slice(0, 10);
      const tm = /^(\d{1,2}):(\d{2})/.exec(String(start_time).trim());
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey) && tm) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        const slotMins = Number(tm[1]) * 60 + Number(tm[2]);
        const nowMins = now.getHours() * 60 + now.getMinutes();
        if (dateKey === todayKey && slotMins <= nowMins) {
          return 'Cannot book a time in the past';
        }
      }
    }
  }
  return null;
}

// Record a lifecycle event (best-effort; never blocks the main mutation).
async function logEvent(db, { booking_id, event_type, actor_id, from_status, to_status, metadata }) {
  try {
    await db.booking_event.create({
      data: { booking_id, event_type, actor_id: actor_id ?? null, from_status, to_status, metadata },
    });
  } catch (err) {
    console.error('[booking] event log failed:', err.message);
  }
}

// Copy for the unified bell, keyed by the socket payload's `type`. `booking` was a declared vertical
// with ZERO producers — a guest was never told their booking was confirmed anywhere durable, only
// via a socket event that vanished if the tab was shut.
const BOOKING_UNIFIED = {
  'new-booking':       { type: 'booking.requested', title: 'New booking request' },
  'booking-confirmed': { type: 'booking.confirmed', title: 'Your booking was confirmed' },
  'booking-declined':  { type: 'booking.declined',  title: 'Your booking was declined' },
  'booking-cancelled': { type: 'booking.cancelled', title: 'A booking was cancelled' },
  'booking-paid':      { type: 'booking.paid',      title: 'Booking payment received' },
  'booking-checked-in':{ type: 'booking.checked_in',title: 'You are checked in' },
  'booking-completed': { type: 'booking.completed', title: 'Your booking is complete' },
};

// Live socket emit + durable notification row. Renamed from `notify` — it collided with
// services/notify.js, which is the real notification writer this now delegates to.
function emitToUser(req, userId, payload) {
  const io = req.app.get('io');
  // Scoped to the recipient's own room (every socket joins `user-<id>` on connect)
  // so a notification reaches only that user, not every connected client.
  if (io && userId) io.to(`user-${userId}`).emit(`notification_user_${userId}`, payload);

  const u = BOOKING_UNIFIED[payload?.type];
  if (userId && u) {
    // A new mechanic/medical booking request deep-links the seller to their Requests tab.
    const isMechanicRequest = payload?.type === 'new-booking' && payload?.vertical === 'mechanic';
    const isMedicalRequest = payload?.type === 'new-booking' && payload?.vertical === 'medical';
    const isMechanic = payload?.vertical === 'mechanic';
    const isMedical = payload?.vertical === 'medical';
    // Mechanic bookings read as "appointment requests" everywhere else in the flow, so give the
    // buyer's accept/decline notification matching copy instead of the generic booking text.
    const mechanicTitle = payload?.type === 'booking-confirmed'
      ? 'Your mechanic accepted your appointment request'
      : payload?.type === 'booking-declined'
        ? 'Your mechanic declined your appointment request'
        : u.title;
    const mechanicBody = payload?.type === 'booking-confirmed'
      ? 'The mechanic accepted your service appointment request.'
      : payload?.type === 'booking-declined'
        ? 'The mechanic declined your service appointment request.'
        : payload.message ?? null;
    const medicalTitle = payload?.type === 'booking-confirmed'
      ? 'Your doctor accepted your appointment'
      : payload?.type === 'booking-declined'
        ? 'Your doctor declined your appointment'
        : u.title;
    const medicalBody = payload?.type === 'booking-confirmed'
      ? 'The doctor accepted your appointment request.'
      : payload?.type === 'booking-declined'
        ? 'The doctor declined your appointment request.'
        : payload.message ?? null;
    notifyUnified(io, {
      userId,
      vertical: 'booking',
      type: u.type,
      title: isMechanic ? mechanicTitle : isMedical ? medicalTitle : u.title,
      body: isMechanic ? mechanicBody : isMedical ? medicalBody : (payload.message ?? null),
      urgency: 'ambient',
      entityType: isMechanicRequest ? 'mechanic_booking' : isMedicalRequest ? 'medical_booking' : 'booking',
      entityId: payload.bookingId ?? null,
      actionUrl: isMechanicRequest ? 'sd-automotive' : isMedicalRequest ? 'sd-doctors' : 'orders',
    });
  }
}

// Load a booking and authorize the caller as guest or host.
async function loadOwnBooking(id, userId) {
  const booking = await prisma.booking.findUnique({ where: { booking_id: id } });
  if (!booking) return { error: 'Booking not found', status: 404 };
  if (booking.guest_id !== userId && booking.host_id !== userId) {
    return { error: 'Not authorized for this booking', status: 403 };
  }
  return { booking };
}

// Transition a booking through the state machine, log it, return updated row.
async function transition(booking, to, { actorId, extraData = {}, eventType } = {}) {
  if (!canTransition(booking.status, to)) {
    return { error: `Cannot move booking from '${booking.status}' to '${to}'`, status: 409 };
  }
  const updated = await prisma.booking.update({
    where: { booking_id: booking.booking_id },
    data: { status: to, ...extraData },
  });
  await logEvent(prisma, {
    booking_id: booking.booking_id,
    event_type: eventType || to,
    actor_id: actorId,
    from_status: booking.status,
    to_status: to,
  });
  return { booking: updated };
}

// ── Listings ─────────────────────────────────────────────────────────────--

// Public search. Filter by vertical / owner / text / price / capacity. Active listings only.
router.get('/listings', async (req, res, next) => {
  try {
    const { owner_id, q } = req.query;
    const parsed = parseBookingVertical(req.query.vertical);
    if (!parsed.ok) {
      return res.status(400).json({ successful: false, message: parsed.error });
    }
    const where = {
      is_active: true,
      ...verticalWhereClause(parsed.vertical),
      ...parseListingBrowseFilters(req.query, parsed.vertical),
    };
    if (owner_id && asInt(owner_id)) where.owner_id = asInt(owner_id);
    if (q) {
      const term = String(q);
      const searchTerms = parsed.vertical === 'medical' ? expandMedicalSearchTerms(term) : [term];
      const or = [];
      for (const t of searchTerms) {
        // Skip blank tokens (whitespace-only q → expandMedicalSearchTerms returns []).
        if (!String(t || '').trim()) continue;
        or.push(
          { title: { contains: t, mode: 'insensitive' } },
          { location: { contains: t, mode: 'insensitive' } },
          { description: { contains: t, mode: 'insensitive' } },
        );
        // Vehicle make/model live in attributes JSON, not title — include them so
        // "Camry" matches a listing titled "Toyota" with attributes.model = "Camry".
        if (parsed.vertical === 'vehicle') {
          or.push(
            { attributes: { path: ['make'], string_contains: t, mode: 'insensitive' } },
            { attributes: { path: ['model'], string_contains: t, mode: 'insensitive' } },
          );
        }
        // Medical Phase 2–3 — doctor fields + symptom-expanded specialties.
        if (parsed.vertical === 'medical') {
          or.push(
            { attributes: { path: ['doctor_name'], string_contains: t, mode: 'insensitive' } },
            { attributes: { path: ['specialty'], string_contains: t, mode: 'insensitive' } },
            { attributes: { path: ['bio'], string_contains: t, mode: 'insensitive' } },
            { attributes: { path: ['credentials'], string_contains: t, mode: 'insensitive' } },
            { attributes: { path: ['insurance'], string_contains: t, mode: 'insensitive' } },
          );
        }
      }
      // Empty OR matches nothing in Prisma — leave where.OR unset for whitespace q.
      if (or.length) where.OR = or;
    }
    const insurancePlan = parsed.vertical === 'medical' ? parseMedicalInsuranceFilter(req.query) : null;
    const insuranceWhere = insurancePlan ? medicalInsuranceWhere(insurancePlan) : null;
    if (insuranceWhere) {
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), insuranceWhere];
    }
    // Pagination: default 50, hard cap 100, so an unbounded list can't be fetched.
    // When a geo radius filter is active, fetch a larger page then post-filter so
    // distance filtering isn't truncated by the first N rows alone.
    const geo = parseListingGeoQuery(req.query);
    const cap = parsed.vertical === 'medical' ? 250 : 100;
    const limit = Math.min(asInt(req.query.limit) || 50, cap);
    const offset = asInt(req.query.offset) || 0;
    const take = geo ? Math.min(Math.max(limit * 4, 100), 400) : limit;
    const skip = geo ? 0 : offset;
    // room_types is hotel-only; including it for reservation/tempstay/etc. is wasteful
    // and 500s if the Prisma client was generated before the hotel_room_type relation existed.
    const includeHotelRooms = !parsed.vertical || parsed.vertical === 'hotel';
    const [rawListings, rawTotal] = await Promise.all([
      prisma.booking_listing.findMany({
        where,
        orderBy: { booking_listing_id: 'desc' },
        take,
        skip,
        ...(includeHotelRooms
          ? {
              include: {
                room_types: {
                  where: { is_active: true },
                  orderBy: [{ sort_order: 'asc' }, { room_type_id: 'asc' }],
                },
              },
            }
          : {}),
      }),
      prisma.booking_listing.count({ where }),
    ]);
    const filtered = geo ? filterListingsByRadius(rawListings, geo) : rawListings;
    const listings = geo ? filtered.slice(offset, offset + limit) : filtered;
    const total = geo ? filtered.length : rawTotal;
    // Reservation cards need attributes.booked_today (OpenTable-style social proof).
    // Computed live from bookings — not a stored attribute hosts edit.
    const data = await attachBookedTodayToListings(prisma, listings);
    res.json({ successful: true, data, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// Host's own listings. Soft-deleted listings (is_active:false, set by DELETE) are
// excluded by default so a "deleted" listing actually disappears from the host
// dashboard — they used to reappear on reload because this returned every status,
// while DELETE only deactivates (the row is kept so booking history FKs survive).
// Pass ?include_inactive=true to also get deactivated rows.
// Pass ?vertical=tempstay (etc.) to scope a single host portal — FE-only filtering
// previously let other-vertical listings leak into the wrong dashboard.
router.get('/listings/mine', authenticateToken, async (req, res, next) => {
  try {
    const includeInactive = String(req.query.include_inactive) === 'true';
    const parsed = parseBookingVertical(req.query.vertical);
    if (!parsed.ok) {
      return res.status(400).json({ successful: false, message: parsed.error });
    }
    const where = {
      owner_id: req.user.user_id,
      ...verticalWhereClause(parsed.vertical),
    };
    if (!includeInactive) where.is_active = true;
    const listings = await prisma.booking_listing.findMany({
      where,
      orderBy: { booking_listing_id: 'desc' },
    });
    const data = await attachBookedTodayToListings(prisma, listings);
    res.json({ successful: true, data });
  } catch (err) {
    next(err);
  }
});

// Public: blocked + booked windows for many listings in one round-trip.
// Must be registered before GET /listings/:id so "availability-batch" is not parsed as an id.
router.get('/listings/availability-batch', async (req, res, next) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => asInt(s))
      .filter(Boolean);
    const unique = [...new Set(ids)].slice(0, 100);
    if (!unique.length) return res.json({ successful: true, data: {} });
    const [blocked, booked] = await Promise.all([
      prisma.availability.findMany({ where: { booking_listing_id: { in: unique } } }),
      prisma.booking.findMany({
        where: { booking_listing_id: { in: unique }, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
        select: {
          booking_listing_id: true,
          start_date: true,
          end_date: true,
          start_time: true,
          end_time: true,
          status: true,
        },
      }),
    ]);
    const byId = {};
    for (const id of unique) byId[id] = { blocked: [], booked: [] };
    for (const row of blocked) {
      const bucket = byId[row.booking_listing_id];
      if (bucket) bucket.blocked.push(row);
    }
    for (const row of booked) {
      const bucket = byId[row.booking_listing_id];
      if (bucket) {
        const { booking_listing_id: _listingId, ...rest } = row;
        bucket.booked.push(rest);
      }
    }
    res.json({ successful: true, data: byId });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /booking/host/me/analytics/overview?range=7d|28d|90d|365d|lifetime&vertical=tempstay&tz=IANA
 *
 * Unified host-earnings analytics for ANY booking-engine vertical, returned in the
 * shape the frontend SellerAnalyticsPanel renders: summary (gross/net/count + %
 * deltas), per-day timeseries, breakdown (bookings by status), top (listings by
 * revenue), optional Performance metrics (occupancy/ADR for date-priced stays).
 *
 * Money model (aligned with Earnings / host wallet Available):
 *   Revenue KPIs count **completed** stays only (host-visible / paid when card).
 *   gross = subtotal + cleaning_fee + service_fee  (transaction value, ex-deposit)
 *   net   = subtotal + cleaning_fee                 (host take-home; 0 if refunded)
 * Status donut includes all host-visible bookings in range (pipeline + cancelled).
 * Occupancy nights use confirmed / in_progress / completed (on-the-books + realized).
 * Date-priced stays bucket charts by checkout (`end_date`); others by `created_at`.
 * `lifetime` = all-time for summary/top/breakdown; trend chart still uses last 365 days.
 */
const REVENUE_STATUSES = ['completed'];
const OCCUPANCY_STATUSES = ['confirmed', 'paid', 'checked_in', 'in_progress', 'completed'];
const ACCEPTED_STATUSES = OCCUPANCY_STATUSES; // cancellation-rate denominator

function bookingAnalyticsAt(b, { dated }) {
  const status = String(b?.status || '').toLowerCase();
  if (dated && status === 'completed') {
    // Align Revenue / Earnings charts with checkout day.
    return b.end_date || b.updated_at || b.created_at || null;
  }
  // Pipeline + cancelled: keep them in the period they were created/requested.
  return b.created_at || b.end_date || null;
}

function inClosedWindow(raw, start, endInclusive) {
  if (!raw) return false;
  const t = new Date(raw).getTime();
  if (Number.isNaN(t)) return false;
  if (t < start.getTime()) return false;
  if (endInclusive != null && t > endInclusive.getTime()) return false;
  return true;
}

router.get('/host/me/analytics/overview', authenticateToken, async (req, res, next) => {
  try {
    const rangeParam = resolveRangeParam(req.query.range);
    const isLifetime = rangeParam === 'lifetime';
    const days = RANGE_DAYS[rangeParam];
    const timeZone = resolveAnalyticsTimeZone(req.query.tz);
    const { start, prevStart, prevEnd } = resolveRange(days, timeZone);
    const now = new Date();

    const vertical = typeof req.query.vertical === 'string'
      ? (() => {
          const p = parseBookingVertical(req.query.vertical);
          return p.ok ? p.vertical : null;
        })()
      : null;
    if (typeof req.query.vertical === 'string' && req.query.vertical && !vertical) {
      return res.status(400).json({ successful: false, message: `Unknown vertical "${req.query.vertical}"` });
    }

    const hostScope = {
      host_id: req.user.user_id,
      ...(vertical ? { vertical } : {}),
    };

    // Listings first — gates dated vs session bucketing and occupancy denominator.
    const hostListings = await prisma.booking_listing.findMany({
      where: { owner_id: req.user.user_id, ...(vertical ? { vertical } : {}) },
      select: { booking_listing_id: true, is_active: true, price_unit: true },
    });
    const activeListings = hostListings.filter((l) => l.is_active !== false);
    const activeListingCount = activeListings.length;
    const DATE_UNITS = new Set(['night', 'day', 'week']);
    const isDated = !!vertical && hostListings.some((l) => DATE_UNITS.has(l.price_unit));

    const select = {
      booking_id: true, booking_listing_id: true, subtotal: true, cleaning_fee: true,
      service_fee: true, status: true, payment_status: true, payment_method: true,
      payment_intent_id: true, total: true, refund_status: true, created_at: true,
      updated_at: true,
      start_date: true, end_date: true, unit_count: true,
    };

    // Broad fetch then JS window by analytics date (checkout for stays, created_at otherwise).
    const recentOr = isLifetime
      ? undefined
      : {
          OR: [
            { created_at: { gte: prevStart } },
            { end_date: { gte: prevStart } },
            { updated_at: { gte: prevStart } },
          ],
        };

    const [revenueCandidates, statusCandidates, occupancyCandidates, statusGroups] = await Promise.all([
      prisma.booking.findMany({
        where: { ...hostScope, status: { in: REVENUE_STATUSES }, ...(recentOr || {}) },
        select,
      }),
      prisma.booking.findMany({
        where: { ...hostScope, ...(recentOr || {}) },
        select: {
          booking_id: true, status: true, payment_status: true, payment_method: true,
          payment_intent_id: true, total: true, created_at: true, start_date: true, end_date: true,
          updated_at: true,
        },
      }),
      prisma.booking.findMany({
        where: { ...hostScope, status: { in: OCCUPANCY_STATUSES }, ...(recentOr || {}) },
        select,
      }),
      prisma.booking.groupBy({
        by: ['status'],
        where: hostScope,
        _count: { _all: true },
      }),
    ]);

    const isRefunded = (b) => b.refund_status === 'issued' || b.payment_status === 'refunded';
    const grossOf = (b) => (b.subtotal || 0) + (b.cleaning_fee || 0) + (b.service_fee || 0);
    const netOf = (b) => (isRefunded(b) ? 0 : (b.subtotal || 0) + (b.cleaning_fee || 0));
    const withAt = (b) => ({ ...b, analytics_at: bookingAnalyticsAt(b, { dated: isDated }) });

    const allRevenue = revenueCandidates.filter(isHostVisibleBooking).map(withAt);
    const earnRows = isLifetime
      ? allRevenue
      : allRevenue.filter((b) => inClosedWindow(b.analytics_at, start, now));
    const earnPrev = allRevenue.filter((b) => inClosedWindow(b.analytics_at, prevStart, prevEnd));
    const seriesRows = isLifetime
      ? allRevenue.filter((b) => inClosedWindow(b.analytics_at, start, now))
      : earnRows;

    const { timeseries, summary: seriesSummary } = buildEarningsSeries({
      rows: seriesRows,
      prevRows: earnPrev,
      dateField: 'analytics_at',
      gross: grossOf,
      net: netOf,
      start,
      days,
      timeZone,
    });

    let summary = seriesSummary;
    if (isLifetime) {
      const sumGross = earnRows.reduce((s, b) => s + grossOf(b), 0);
      const sumNet = earnRows.reduce((s, b) => s + netOf(b), 0);
      const count = earnRows.length;
      summary = {
        gross: roundMoney(sumGross),
        gross_change_pct: seriesSummary.gross_change_pct,
        net: roundMoney(sumNet),
        net_change_pct: seriesSummary.net_change_pct,
        count,
        count_change_pct: seriesSummary.count_change_pct,
        avg_order_value: count > 0 ? roundMoney(sumGross / count) : 0,
      };
    }

    // Status breakdown: host-visible bookings created in range, checking out in range, or overlapping.
    const statusVisible = statusCandidates.filter(isHostVisibleBooking).map(withAt);
    const statusInRange = statusVisible.filter((b) => {
      if (isLifetime) return true;
      if (inClosedWindow(b.analytics_at, start, now)) return true;
      if (inClosedWindow(b.created_at, start, now)) return true;
      if (isDated && b.start_date && b.end_date) {
        const stayStart = new Date(b.start_date).getTime();
        const stayEnd = new Date(b.end_date).getTime();
        if (Number.isNaN(stayStart) || Number.isNaN(stayEnd)) return false;
        return stayEnd >= start.getTime() && stayStart <= now.getTime();
      }
      return false;
    });
    const statusMap = new Map();
    statusInRange.forEach((b) => {
      const k = b.status || 'unknown';
      statusMap.set(k, (statusMap.get(k) || 0) + 1);
    });
    const breakdown = [...statusMap.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);

    // Top listings by completed revenue in range (lifetime = all completed).
    const topSource = earnRows;
    const byListing = new Map();
    for (const b of topSource) {
      if (b.booking_listing_id == null) continue;
      const e = byListing.get(b.booking_listing_id) || { id: b.booking_listing_id, gross: 0, net: 0, count: 0 };
      e.gross += grossOf(b);
      e.net += netOf(b);
      e.count += 1;
      byListing.set(b.booking_listing_id, e);
    }
    let top = [];
    if (byListing.size) {
      const listings = await prisma.booking_listing.findMany({
        where: { booking_listing_id: { in: [...byListing.keys()] } },
        select: { booking_listing_id: true, title: true },
      });
      const titleOf = new Map(listings.map((l) => [l.booking_listing_id, l.title]));
      top = [...byListing.values()]
        .map((e) => ({
          id: e.id,
          title: titleOf.get(e.id) || 'Listing',
          subtitle: `${e.count} booking${e.count === 1 ? '' : 's'}`,
          gross: roundMoney(e.gross),
          net: roundMoney(e.net),
          count: e.count,
        }))
        .sort((a, b) => b.gross - a.gross)
        .slice(0, 8);
    }

    // ── Occupancy / ADR (#289) + cancellation analytics (#291) ──
    const DAY_MS = 86400000;
    const nightsOf = (b) => {
      if (b.start_date && b.end_date) {
        const n = Math.round((new Date(b.end_date) - new Date(b.start_date)) / DAY_MS);
        if (n >= 1) return n;
      }
      return b.unit_count && b.unit_count >= 1 ? b.unit_count : 1;
    };

    const occRows = occupancyCandidates
      .filter(isHostVisibleBooking)
      .filter((b) => {
        if (isLifetime) return true;
        // Realized / in-house: stay overlaps [start, now]
        if (b.start_date && b.end_date) {
          const stayStart = new Date(b.start_date).getTime();
          const stayEnd = new Date(b.end_date).getTime();
          if (!Number.isNaN(stayStart) && !Number.isNaN(stayEnd)
            && stayEnd >= start.getTime() && stayStart <= now.getTime()) {
            return true;
          }
        }
        // On-the-books future stays (and undated) booked during the window
        return inClosedWindow(b.created_at, start, now);
      });

    // Hotel: sellable room inventory; other dated verticals: active listings.
    let capacityUnits = activeListingCount;
    let capacityNounPlural = activeListingCount === 1 ? 'listing' : 'listings';
    let capacityNounSingular = 'listing';
    if (vertical === 'hotel' && activeListings.length) {
      const roomAgg = await prisma.hotel_room_type.aggregate({
        where: {
          is_active: true,
          booking_listing_id: { in: activeListings.map((l) => l.booking_listing_id) },
        },
        _sum: { quantity: true },
      });
      const qty = Number(roomAgg._sum.quantity) || 0;
      if (qty > 0) {
        capacityUnits = qty;
        capacityNounPlural = qty === 1 ? 'room' : 'rooms';
        capacityNounSingular = 'room';
      }
    }

    const cnt = Object.fromEntries(statusGroups.map((g) => [g.status, g._count._all]));
    const earnedAll = ACCEPTED_STATUSES.reduce((s, st) => s + (cnt[st] || 0), 0);
    const cancelledAll = cnt.cancelled || 0;
    const declinedAll = cnt.declined || 0;
    const acceptedOrCancelled = earnedAll + cancelledAll;
    const cancellationRate = acceptedOrCancelled
      ? roundMoney((cancelledAll / acceptedOrCancelled) * 100)
      : null;

    // ADR / RevPAR use host net (subtotal + cleaning) — matches Earnings take-home.
    const hostNetInRange = occRows.reduce((s, b) => s + netOf(b), 0);
    const nightsSold = occRows.reduce((s, b) => s + nightsOf(b), 0);
    const adr = isDated && nightsSold > 0 ? roundMoney(hostNetInRange / nightsSold) : null;
    const avgStay = isDated && occRows.length ? roundMoney(nightsSold / occRows.length) : null;
    const capacityNights = capacityUnits * days;
    const occupancy = isDated && capacityUnits > 0
      ? roundMoney(Math.min(100, (nightsSold / capacityNights) * 100))
      : null;
    const revpar = isDated && capacityUnits > 0
      ? roundMoney(hostNetInRange / capacityNights)
      : null;

    const metrics = [];
    if (isDated) {
      metrics.push(
        {
          key: 'occupancy',
          label: 'Occupancy',
          value: occupancy,
          format: 'pct',
          hint: `Approx. nights sold vs ${capacityUnits} ${capacityNounPlural} available every day this period`,
          tone: occupancy == null ? 'neutral' : (occupancy >= 70 ? 'good' : occupancy >= 40 ? 'neutral' : 'warn'),
        },
        {
          key: 'adr',
          label: 'Avg daily rate',
          value: adr,
          format: 'money',
          hint: 'Host net per night sold (subtotal + cleaning ÷ nights)',
          tone: 'neutral',
        },
        {
          key: 'revpar',
          label: 'RevPAR',
          value: revpar,
          format: 'money',
          hint: `Host net per available ${capacityNounSingular}-night`,
          tone: 'neutral',
        },
        {
          key: 'avg_stay',
          label: 'Avg length of stay',
          value: avgStay,
          format: 'nights',
          hint: 'Average nights per confirmed/in-progress/completed booking this period',
          tone: 'neutral',
        },
      );
    }
    metrics.push(
      {
        key: 'cancellation_rate',
        label: 'Cancellation rate',
        value: cancellationRate,
        format: 'pct',
        hint: `${cancelledAll} cancelled of ${acceptedOrCancelled} accepted bookings (lifetime)`,
        tone: cancellationRate == null ? 'neutral' : (cancellationRate <= 5 ? 'good' : cancellationRate <= 15 ? 'neutral' : 'warn'),
      },
      {
        key: 'declined',
        label: 'Declined requests',
        value: declinedAll,
        format: 'count',
        hint: 'Booking requests you declined (lifetime)',
        tone: 'neutral',
      },
    );

    res.json({
      successful: true,
      data: {
        range: rangeParam,
        currency: 'CAD',
        timezone: timeZone,
        summary,
        timeseries,
        breakdown,
        top,
        metrics,
      },
    });
  } catch (err) { next(err); }
});

/**
 * GET /booking/host/me/reviews?vertical=hotel
 * All guest reviews across the host's listings (for dashboard Reviews tab + AVG REVIEW).
 */
router.get('/host/me/reviews', authenticateToken, async (req, res, next) => {
  try {
    const verticalRaw = typeof req.query.vertical === 'string' ? req.query.vertical.trim() : '';
    let vertical = null;
    if (verticalRaw) {
      const parsed = parseBookingVertical(verticalRaw);
      if (!parsed.ok) {
        return res.status(400).json({ successful: false, message: parsed.error });
      }
      vertical = parsed.vertical;
    }

    const listings = await prisma.booking_listing.findMany({
      where: {
        owner_id: req.user.user_id,
        ...(vertical ? { vertical } : {}),
      },
      select: {
        booking_listing_id: true,
        title: true,
        avg_rating: true,
        review_count: true,
      },
    });
    const listingIds = listings.map((l) => l.booking_listing_id);
    if (!listingIds.length) {
      return res.json({
        successful: true,
        data: { avg_rating: null, review_count: 0, reviews: [] },
      });
    }

    const take = Math.min(Math.max(asInt(req.query.limit) || 50, 1), 100);
    const rows = await prisma.booking_review.findMany({
      where: { booking_listing_id: { in: listingIds } },
      orderBy: { created_at: 'desc' },
      take,
      select: {
        booking_review_id: true,
        booking_id: true,
        booking_listing_id: true,
        rating: true,
        review: true,
        created_at: true,
        user: { select: BOOKING_PARTY_USER_SELECT },
        booking_listing: { select: { title: true } },
      },
    });

    const agg = await prisma.booking_review.aggregate({
      where: { booking_listing_id: { in: listingIds } },
      _avg: { rating: true },
      _count: { _all: true },
    });
    const review_count = agg._count._all || 0;
    const avg_rating =
      agg._avg.rating != null ? Math.round(agg._avg.rating * 10) / 10 : null;

    res.json({
      successful: true,
      data: {
        avg_rating,
        review_count,
        reviews: rows.map((r) => ({
          booking_review_id: r.booking_review_id,
          booking_id: r.booking_id,
          listing_id: r.booking_listing_id,
          listing_title: r.booking_listing?.title || null,
          rating: r.rating,
          review: r.review,
          created_at: r.created_at,
          guest_name: bookingPartyLabel(r.user),
          user: r.user,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/listings/:id', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ successful: false, message: 'Invalid listing id' });
    // Optional ?vertical= scopes the public deep link so Temp Stay / Hotel / Venue
    // surfaces cannot open each other's listings (#1607).
    const parsed = parseBookingVertical(req.query.vertical);
    if (!parsed.ok) {
      return res.status(400).json({ successful: false, message: parsed.error });
    }
    // findFirst so we can filter is_active — soft-deleted listings must not appear on their
    // public page (they were deactivated by the host's delete, not physically removed).
    const listing = await prisma.booking_listing.findFirst({
      where: {
        booking_listing_id: id,
        is_active: true,
        ...verticalWhereClause(parsed.vertical),
      },
      include: { availability: true },
    });
    if (!listing) return res.status(404).json({ successful: false, message: 'Listing not found' });

    let data = listing;
    if (listing.vertical === 'hotel') {
      const room_types = await prisma.hotel_room_type.findMany({
        where: { booking_listing_id: id, is_active: true },
        orderBy: [{ sort_order: 'asc' }, { room_type_id: 'asc' }],
        include: { inventory: true },
      });
      data = { ...listing, room_types };
    } else if (listing.vertical === 'reservation') {
      const counts = await countBookingsPlacedToday(prisma, [listing.booking_listing_id]);
      data = withBookedToday(listing, counts.get(listing.booking_listing_id) || 0);
    }
    res.json({ successful: true, data });
  } catch (err) {
    next(err);
  }
});

router.post('/listings', authenticateToken, async (req, res, next) => {
  try {
    const b = req.body || {};
    const vertical = String(b.vertical || '').trim();
    if (!KNOWN_VERTICALS.has(vertical)) {
      return res.status(400).json({ successful: false, message: 'Unknown or missing vertical' });
    }
    if (LOCATION_REQUIRED_VERTICALS.has(vertical) && !(typeof b.location === 'string' && b.location.trim())) {
      return res.status(400).json({ successful: false, message: 'An address is required for this listing.' });
    }
    // Single-unit verticals (tempstay, vehicle): capacity is pinned to 1 and the incoming
    // people-count is rescued into attributes, so a client still posting the old shape
    // doesn't silently lose it. See utils/booking-capacity.js.
    const unitFix = normalizeSingleUnitCapacity(vertical, b);
    let capacity = unitFix ? unitFix.capacity : (b.capacity != null ? asInt(b.capacity) : null);
    let attributes = unitFix ? unitFix.attributes : (b.attributes ?? null);

    // Reservation verticals must ship with complete host-configured capacity so the
    // engine never permanently blocks booking after a partial create.
    if (vertical === 'reservation') {
      const cfg = validateReservationListingConfig({
        capacity: b.capacity,
        attributes: reservationAttributesFromBody(b),
        isUpdate: false,
      });
      if (!cfg.ok) return res.status(400).json({ successful: false, message: cfg.message });
      capacity = cfg.capacity;
      attributes = cfg.attributes;
    }

    const listing = await prisma.booking_listing.create({
      data: {
        vertical,
        owner_id: req.user.user_id, // forced from JWT — never trust client
        title: b.title ?? null,
        description: b.description ?? null,
        location: b.location ?? null,
        latitude: b.latitude != null ? Number(b.latitude) : null,
        longitude: b.longitude != null ? Number(b.longitude) : null,
        price: b.price != null ? Number(b.price) : null,
        price_unit: b.price_unit || 'night',
        currency: b.currency || 'CAD',
        instant_book: Boolean(b.instant_book),
        requires_deposit: Boolean(b.requires_deposit),
        deposit_amount: b.deposit_amount != null ? Number(b.deposit_amount) : null,
        fulfillment: b.fulfillment || 'onsite',
        capacity,
        cleaning_fee: b.cleaning_fee != null ? Number(b.cleaning_fee) : 0,
        service_fee_pct: b.service_fee_pct != null ? Number(b.service_fee_pct) : 0,
        attributes,
        images: b.images ?? null,
      },
    });
    res.status(201).json({ successful: true, data: listing });
  } catch (err) {
    next(err);
  }
});

router.put('/listings/:id', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ successful: false, message: 'Invalid listing id' });
    const existing = await prisma.booking_listing.findUnique({ where: { booking_listing_id: id } });
    if (!existing) return res.status(404).json({ successful: false, message: 'Listing not found' });
    if (existing.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Not your listing' });
    }
    const b = req.body || {};
    // #305 — don't let a location-required listing be edited into having no address.
    if (LOCATION_REQUIRED_VERTICALS.has(existing.vertical) && b.location !== undefined && !(typeof b.location === 'string' && b.location.trim())) {
      return res.status(400).json({ successful: false, message: 'An address is required for this listing.' });
    }
    // Whitelist mutable fields; vertical and owner_id are immutable.
    const data = {};
    for (const f of ['title', 'description', 'location', 'price_unit', 'currency', 'fulfillment', 'images']) {
      if (b[f] !== undefined) data[f] = b[f];
    }
    if (b.attributes !== undefined) data.attributes = b.attributes;
    for (const f of ['latitude', 'longitude', 'price', 'deposit_amount', 'cleaning_fee', 'service_fee_pct']) {
      if (b[f] !== undefined) data[f] = b[f] != null ? Number(b[f]) : null;
    }
    if (b.capacity !== undefined) data.capacity = b.capacity != null ? asInt(b.capacity) : null;
    for (const f of ['instant_book', 'requires_deposit', 'is_active']) {
      if (b[f] !== undefined) data[f] = Boolean(b[f]);
    }
    // Re-pin capacity on every edit of a single-unit vertical, and fold any incoming
    // people-count into attributes (merging with what's stored when the client didn't send
    // an attributes object). Without the re-pin, one edit from an older client would put a
    // party size back into the units column and reopen the double-booking.
    const unitFix = normalizeSingleUnitCapacity(existing.vertical, b, existing.attributes);
    if (unitFix) {
      data.capacity = unitFix.capacity;
      data.attributes = unitFix.attributes;
    }

    // Reservation edits must keep a complete capacity config and must not persist
    // computed fields (booked_today) or wipe protected engine attributes.
    if (existing.vertical === 'reservation') {
      const cfg = validateReservationListingConfig({
        capacity: b.capacity !== undefined ? b.capacity : existing.capacity,
        attributes: (b.attributes !== undefined || [
          'tables', 'seating_capacity', 'turn_time_minutes', 'turn_minutes',
          'time_slots', 'service_hours', 'reservation_hours', 'food_vendor_id', 'max_guests',
        ].some((k) => b[k] !== undefined))
          ? reservationAttributesFromBody(b)
          : undefined,
        existingAttributes: existing.attributes,
        isUpdate: true,
      });
      if (!cfg.ok) return res.status(400).json({ successful: false, message: cfg.message });
      data.capacity = cfg.capacity;
      data.attributes = cfg.attributes;
    }

    const listing = await prisma.booking_listing.update({ where: { booking_listing_id: id }, data });
    res.json({ successful: true, data: listing });
  } catch (err) {
    next(err);
  }
});

// Soft-delete (deactivate) — preserves any historical bookings.
router.delete('/listings/:id', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ successful: false, message: 'Invalid listing id' });
    const existing = await prisma.booking_listing.findUnique({ where: { booking_listing_id: id } });
    if (!existing) return res.status(404).json({ successful: false, message: 'Listing not found' });
    if (existing.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Not your listing' });
    }
    await prisma.booking_listing.update({ where: { booking_listing_id: id }, data: { is_active: false } });
    res.json({ successful: true, message: 'Listing deactivated' });
  } catch (err) {
    next(err);
  }
});

// ── Availability ────────────────────────────────────────────────────────────

// Public: OpenTable-style time slots for a restaurant listing on a given date.
// GET /booking/listings/:id/reservation-slots?date=YYYY-MM-DD&party_size=N
router.get('/listings/:id/reservation-slots', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ successful: false, message: 'Invalid listing id' });
    const listing = await prisma.booking_listing.findUnique({ where: { booking_listing_id: id } });
    if (!listing || !listing.is_active) {
      return res.status(404).json({ successful: false, message: 'Listing not available' });
    }
    if (listing.vertical !== 'reservation') {
      return res.status(400).json({ successful: false, message: 'Listing is not a reservation vertical' });
    }
    const dateRaw = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (!dateRaw || Number.isNaN(new Date(dateRaw).getTime())) {
      return res.status(400).json({ successful: false, message: 'date query param required (YYYY-MM-DD)' });
    }
    const party_size = asInt(req.query.party_size) || 1;
    const data = await listReservationSlots(prisma, listing, { date: dateRaw, party_size });
    res.json({ successful: true, data });
  } catch (err) {
    next(err);
  }
});

// Public: blocked slots + active bookings so the client can grey out the calendar.
// Hotel: pass ?room_type_id= to get quantity-aware sold_out_nights for that room type
// (listing-level booked[] would over-block multi-room inventory).
router.get('/listings/:id/availability', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ successful: false, message: 'Invalid listing id' });
    const listing = await prisma.booking_listing.findUnique({ where: { booking_listing_id: id } });
    if (!listing) return res.status(404).json({ successful: false, message: 'Listing not found' });

    const roomTypeId = asInt(req.query.room_type_id);
    if (listing.vertical === 'hotel' && roomTypeId) {
      const roomType = await prisma.hotel_room_type.findFirst({
        where: { room_type_id: roomTypeId, booking_listing_id: id, is_active: true },
      });
      if (!roomType) return res.status(404).json({ successful: false, message: 'Room type not found' });
      const [blocked, roomBookings, inventory] = await Promise.all([
        prisma.availability.findMany({ where: { booking_listing_id: id } }),
        prisma.booking.findMany({
          where: {
            room_type_id: roomTypeId,
            status: { in: [...ACTIVE_BOOKING_STATUSES] },
          },
          select: {
            start_date: true,
            end_date: true,
            quantity: true,
            status: true,
          },
        }),
        prisma.hotel_room_inventory.findMany({ where: { room_type_id: roomTypeId } }),
      ]);
      const sold_out_nights = soldOutNightsForRoomType(roomType, roomBookings, inventory);
      // Emit single-night booked stubs so existing FE stayRangeConflicts still works
      // without requiring a schema change on every client.
      const booked = sold_out_nights.map((d) => ({
        start_date: d,
        end_date: (() => {
          const n = new Date(`${d}T12:00:00Z`);
          n.setUTCDate(n.getUTCDate() + 1);
          return n.toISOString().slice(0, 10);
        })(),
        status: 'sold_out',
      }));
      return res.json({
        successful: true,
        data: {
          blocked,
          booked,
          sold_out_nights,
          room_type_id: roomTypeId,
          quantity: roomType.quantity,
        },
      });
    }

    const [blocked, booked] = await Promise.all([
      prisma.availability.findMany({ where: { booking_listing_id: id } }),
      prisma.booking.findMany({
        where: { booking_listing_id: id, status: { in: ['confirmed', 'in_progress', 'awaiting_host', 'requested'] } },
        select: { start_date: true, end_date: true, start_time: true, end_time: true, status: true },
      }),
    ]);
    res.json({ successful: true, data: { blocked, booked } });
  } catch (err) {
    next(err);
  }
});

// Host: set blocked dates / price overrides. Body: { slots: [{date, is_blocked, price_override, time_from, time_to, capacity_override}] }
router.post('/listings/:id/availability', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ successful: false, message: 'Invalid listing id' });
    const listing = await prisma.booking_listing.findUnique({ where: { booking_listing_id: id } });
    if (!listing) return res.status(404).json({ successful: false, message: 'Listing not found' });
    if (listing.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Not your listing' });
    }
    const slots = Array.isArray(req.body?.slots) ? req.body.slots : [];
    if (!slots.length) return res.status(400).json({ successful: false, message: 'slots[] required' });
    // Upsert by date: re-submitting a date replaces its prior row instead of
    // appending a duplicate. Dated rows are deleted first within the txn.
    const dates = slots.map((s) => (s.date ? new Date(s.date) : null)).filter(Boolean);
    const created = await prisma.$transaction([
      ...(dates.length
        ? [prisma.availability.deleteMany({ where: { booking_listing_id: id, date: { in: dates } } })]
        : []),
      ...slots.map((s) =>
        prisma.availability.create({
          data: {
            booking_listing_id: id,
            date: s.date ? new Date(s.date) : null,
            time_from: s.time_from ?? null,
            time_to: s.time_to ?? null,
            is_blocked: Boolean(s.is_blocked),
            price_override: s.price_override != null ? Number(s.price_override) : null,
            capacity_override: s.capacity_override != null ? asInt(s.capacity_override) : null,
          },
        })
      ),
    ]);
    res.status(201).json({ successful: true, data: created.filter((r) => r && r.availability_id !== undefined) });
  } catch (err) {
    next(err);
  }
});

// Host: remove a single availability row (e.g. unblock a date).
router.delete('/listings/:id/availability/:slotId', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const slotId = asInt(req.params.slotId);
    if (!id || !slotId) return res.status(400).json({ successful: false, message: 'Invalid id' });
    const listing = await prisma.booking_listing.findUnique({ where: { booking_listing_id: id } });
    if (!listing) return res.status(404).json({ successful: false, message: 'Listing not found' });
    if (listing.owner_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Not your listing' });
    }
    const slot = await prisma.availability.findUnique({ where: { availability_id: slotId } });
    if (!slot || slot.booking_listing_id !== id) {
      return res.status(404).json({ successful: false, message: 'Availability slot not found' });
    }
    await prisma.availability.delete({ where: { availability_id: slotId } });
    res.json({ successful: true, message: 'Availability slot removed' });
  } catch (err) {
    next(err);
  }
});

// ── Hotel room types + inventory ─────────────────────────────────────────────

/** Sync listing.price (cheapest room) + listing.capacity (sum of room quantities). */
async function syncHotelListingInventoryFields(listingId) {
  const rooms = await prisma.hotel_room_type.findMany({
    where: { booking_listing_id: listingId, is_active: true },
    orderBy: { nightly_price: 'asc' },
  });
  if (!rooms.length) {
    await prisma.booking_listing.update({
      where: { booking_listing_id: listingId },
      data: { capacity: 0 },
    });
    return;
  }
  const capacity = rooms.reduce((sum, r) => sum + Math.max(1, Number(r.quantity) || 1), 0);
  await prisma.booking_listing.update({
    where: { booking_listing_id: listingId },
    data: {
      price: rooms[0].nightly_price,
      capacity,
    },
  });
}

async function assertListingOwner(listingId, userId) {
  const listing = await prisma.booking_listing.findUnique({ where: { booking_listing_id: listingId } });
  if (!listing) return { error: 'Listing not found', status: 404 };
  if (listing.owner_id !== userId) return { error: 'Not your listing', status: 403 };
  return { listing };
}

router.get('/listings/:id/rooms', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ successful: false, message: 'Invalid listing id' });
    const rooms = await prisma.hotel_room_type.findMany({
      where: { booking_listing_id: id, is_active: true },
      orderBy: [{ sort_order: 'asc' }, { room_type_id: 'asc' }],
      include: { inventory: true },
    });
    res.json({ successful: true, data: rooms });
  } catch (err) {
    next(err);
  }
});

router.post('/listings/:id/rooms', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ successful: false, message: 'Invalid listing id' });
    const owned = await assertListingOwner(id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    if (owned.listing.vertical !== 'hotel') {
      return res.status(400).json({ successful: false, message: 'Room types are only for hotel listings' });
    }
    const b = req.body || {};
    if (!b.name || b.nightly_price == null) {
      return res.status(400).json({ successful: false, message: 'name and nightly_price required' });
    }
    // A blank price arrives as '' and used to become a bookable $0 room via Number('').
    if (!(Number(b.nightly_price) > 0)) {
      return res.status(400).json({ successful: false, message: 'nightly_price must be greater than 0' });
    }
    const room = await prisma.hotel_room_type.create({
      data: {
        booking_listing_id: id,
        name: String(b.name),
        description: b.description ?? null,
        beds: b.beds ?? null,
        bed_count: b.bed_count != null ? asInt(b.bed_count) : null,
        max_guests: b.max_guests != null ? asInt(b.max_guests) || 2 : 2,
        // Physical copies of this room type — NEVER guest party size.
        quantity: b.quantity != null ? Math.max(1, asInt(b.quantity) || 1) : 1,
        size_sqm: b.size_sqm != null ? Number(b.size_sqm) : null,
        nightly_price: Number(b.nightly_price),
        amenities: b.amenities ?? null,
        images: b.images ?? null,
        policies: b.policies ?? null,
        sort_order: b.sort_order != null ? asInt(b.sort_order) || 0 : 0,
      },
    });
    // Keep parent listing price in sync with cheapest room for browse cards.
    // capacity = sum of active room-type quantities (hotel inventory), not max guests.
    await syncHotelListingInventoryFields(id);
    res.status(201).json({ successful: true, data: room });
  } catch (err) {
    next(err);
  }
});

router.put('/listings/:id/rooms/:roomId', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const roomId = asInt(req.params.roomId);
    if (!id || !roomId) return res.status(400).json({ successful: false, message: 'Invalid id' });
    const owned = await assertListingOwner(id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    const existing = await prisma.hotel_room_type.findFirst({ where: { room_type_id: roomId, booking_listing_id: id } });
    if (!existing) return res.status(404).json({ successful: false, message: 'Room type not found' });
    const b = req.body || {};
    const data = {};
    for (const f of ['name', 'description', 'beds', 'policies']) {
      if (b[f] !== undefined) data[f] = b[f];
    }
    for (const f of ['amenities', 'images']) {
      if (b[f] !== undefined) data[f] = b[f];
    }
    if (b.bed_count !== undefined) data.bed_count = b.bed_count != null ? asInt(b.bed_count) : null;
    if (b.max_guests !== undefined) data.max_guests = asInt(b.max_guests) || 2;
    if (b.size_sqm !== undefined) data.size_sqm = b.size_sqm != null ? Number(b.size_sqm) : null;
    if (b.quantity !== undefined) data.quantity = Math.max(1, asInt(b.quantity) || 1);
    if (b.nightly_price !== undefined) {
      if (!(Number(b.nightly_price) > 0)) {
        return res.status(400).json({ successful: false, message: 'nightly_price must be greater than 0' });
      }
      data.nightly_price = Number(b.nightly_price);
    }
    if (b.sort_order !== undefined) data.sort_order = asInt(b.sort_order) || 0;
    if (b.is_active !== undefined) data.is_active = Boolean(b.is_active);
    const room = await prisma.hotel_room_type.update({ where: { room_type_id: roomId }, data });
    await syncHotelListingInventoryFields(id);
    res.json({ successful: true, data: room });
  } catch (err) {
    next(err);
  }
});

router.delete('/listings/:id/rooms/:roomId', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const roomId = asInt(req.params.roomId);
    if (!id || !roomId) return res.status(400).json({ successful: false, message: 'Invalid id' });
    const owned = await assertListingOwner(id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    await prisma.hotel_room_type.updateMany({
      where: { room_type_id: roomId, booking_listing_id: id },
      data: { is_active: false },
    });
    await syncHotelListingInventoryFields(id);
    res.json({ successful: true, message: 'Room type deactivated' });
  } catch (err) {
    next(err);
  }
});

router.post('/listings/:id/rooms/:roomId/inventory', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const roomId = asInt(req.params.roomId);
    if (!id || !roomId) return res.status(400).json({ successful: false, message: 'Invalid id' });
    const owned = await assertListingOwner(id, req.user.user_id);
    if (owned.error) return res.status(owned.status).json({ successful: false, message: owned.error });
    const room = await prisma.hotel_room_type.findFirst({ where: { room_type_id: roomId, booking_listing_id: id } });
    if (!room) return res.status(404).json({ successful: false, message: 'Room type not found' });
    const slots = Array.isArray(req.body?.slots) ? req.body.slots : [];
    const upserted = [];
    for (const s of slots) {
      if (!s.date) continue;
      const row = await prisma.hotel_room_inventory.upsert({
        where: {
          room_type_id_date: {
            room_type_id: roomId,
            date: new Date(s.date),
          },
        },
        create: {
          room_type_id: roomId,
          date: new Date(s.date),
          available: s.available != null ? asInt(s.available) : room.quantity,
          price_override: s.price_override != null ? Number(s.price_override) : null,
          is_blocked: Boolean(s.is_blocked),
        },
        update: {
          available: s.available != null ? asInt(s.available) : undefined,
          price_override: s.price_override !== undefined ? (s.price_override != null ? Number(s.price_override) : null) : undefined,
          is_blocked: s.is_blocked !== undefined ? Boolean(s.is_blocked) : undefined,
        },
      });
      upserted.push(row);
    }
    res.status(201).json({ successful: true, data: upserted });
  } catch (err) {
    next(err);
  }
});

// ── Quote (price preview + availability check, no write) ─────────────────────

router.post('/quote', async (req, res, next) => {
  try {
    const b = req.body || {};
    const listingId = asInt(b.booking_listing_id);
    if (!listingId) return res.status(400).json({ successful: false, message: 'booking_listing_id required' });
    const listing = await prisma.booking_listing.findUnique({ where: { booking_listing_id: listingId } });
    if (!listing || !listing.is_active) {
      return res.status(404).json({ successful: false, message: 'Listing not available' });
    }
    const norm = normalizeReservationBookingBody(listing, b);
    if (listing.vertical === 'wedding' && !b.start_date) {
      return res.status(400).json({ successful: false, message: 'start_date is required for wedding bookings' });
    }
    const partyError = validatePartySize(listing, norm.guests);
    if (partyError) return res.status(400).json({ successful: false, message: partyError });
    const u = computeUnits(listing.price_unit, {
      startDate: b.start_date,
      endDate: b.end_date,
      startTime: norm.start_time,
      endTime: norm.end_time,
      vertical: listing.vertical,
    });
    if (u.error) return res.status(400).json({ successful: false, message: u.error });
    const windowErr = validateBookingWindow(b);
    if (windowErr) return res.status(400).json({ successful: false, message: windowErr });
    const quantity = norm.quantity;

    // Hotel room-type pricing path — room_type_id is required (same as create).
    if (listing.vertical === 'hotel') {
      const roomTypeId = asInt(b.room_type_id);
      if (!roomTypeId) {
        return res.status(400).json({ successful: false, message: 'room_type_id is required for hotel quotes' });
      }
      const roomType = await prisma.hotel_room_type.findFirst({
        where: {
          room_type_id: roomTypeId,
          booking_listing_id: listingId,
          is_active: true,
        },
      });
      if (!roomType) return res.status(404).json({ successful: false, message: 'Room type not found' });
      // Inventory is room units, never guest count.
      const roomQty = 1;
      const roomAvail = await checkHotelRoomAvailability(prisma, roomType, {
        start_date: b.start_date, end_date: b.end_date, quantity: roomQty,
      });
      if (!roomAvail.ok) {
        return res.json({
          successful: true,
          data: { ...computeQuote({ ...listing, price: roomType.nightly_price }, u.units, { quantity: roomQty }), available: false, reason: roomAvail.reason, room_type_id: roomType.room_type_id },
        });
      }
      const quote = computeQuote(
        { ...listing, price: roomAvail.unitPrice },
        u.units,
        { quantity: roomQty, unitPriceOverride: roomAvail.unitPrice },
      );
      return res.json({
        successful: true,
        data: {
          ...quote,
          available: true,
          reason: null,
          room_type_id: roomType.room_type_id,
          remaining: roomAvail.remaining,
        },
      });
    }

    const quote = computeQuote(listing, u.units, { quantity });
    const avail = await checkAvailability(prisma, listing, {
      start_date: b.start_date,
      end_date: b.end_date,
      start_time: norm.start_time,
      end_time: norm.end_time,
      quantity,
      guests: norm.guests,
    });
    res.json({
      successful: true,
      data: {
        ...quote,
        available: avail.ok,
        reason: avail.ok ? null : avail.reason,
        remaining: avail.remaining != null ? avail.remaining : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Bookings ─────────────────────────────────────────────────────────────--

// Create a booking. Server computes price + checks availability under a
// per-listing advisory lock so two concurrent requests can't double-book.
router.post('/bookings', authenticateToken, async (req, res, next) => {
  try {
    const b = req.body || {};
    const listingId = asInt(b.booking_listing_id);
    if (!listingId) return res.status(400).json({ successful: false, message: 'booking_listing_id required' });

    const result = await prisma.$transaction(async (tx) => {
      // Serialize all booking attempts for this listing.
      // Cast to int4: Prisma binds JS numbers as bigint, and Postgres has no
      // pg_advisory_xact_lock(int4, bigint) overload — only (int4, int4) / (bigint).
      // Without the cast every booking insert 500s with "function ... does not exist".
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4242, ${listingId}::int4)`;

      const listing = await tx.booking_listing.findUnique({ where: { booking_listing_id: listingId } });
      if (!listing || !listing.is_active) return { error: 'Listing not available', status: 404 };
      if (listing.owner_id === req.user.user_id) return { error: 'You cannot book your own listing', status: 400 };

      const norm = normalizeReservationBookingBody(listing, b);
      if (listing.vertical === 'wedding' && !b.start_date) {
        return { error: 'start_date is required for wedding bookings', status: 400 };
      }
      const partyError = validatePartySize(listing, norm.guests);
      if (partyError) return { error: partyError, status: 400 };
      const u = computeUnits(listing.price_unit, {
        startDate: b.start_date,
        endDate: b.end_date,
        startTime: norm.start_time,
        endTime: norm.end_time,
        vertical: listing.vertical,
      });
      if (u.error) return { error: u.error, status: 400 };
      const windowErr = validateBookingWindow(b);
      if (windowErr) return { error: windowErr, status: 400 };

      const quantity = norm.quantity;
      let roomType = null;
      let quote;

      if (listing.vertical === 'hotel') {
        const roomTypeId = asInt(b.room_type_id);
        if (!roomTypeId) return { error: 'room_type_id is required for hotel bookings', status: 400 };
        roomType = await tx.hotel_room_type.findFirst({
          where: { room_type_id: roomTypeId, booking_listing_id: listingId, is_active: true },
        });
        if (!roomType) return { error: 'Room type not found', status: 404 };
        // One booking = one room unit. Guests ride on `guests`, never on inventory quantity.
        const roomQty = 1;
        const roomAvail = await checkHotelRoomAvailability(tx, roomType, {
          start_date: b.start_date, end_date: b.end_date, quantity: roomQty,
        });
        if (!roomAvail.ok) return { error: roomAvail.reason, status: 409 };
        quote = computeQuote(
          { ...listing, price: roomAvail.unitPrice },
          u.units,
          { quantity: roomQty, unitPriceOverride: roomAvail.unitPrice },
        );
      } else {
        const avail = await checkAvailability(tx, listing, {
          start_date: b.start_date,
          end_date: b.end_date,
          start_time: norm.start_time,
          end_time: norm.end_time,
          quantity,
          guests: norm.guests,
        });
        if (!avail.ok) return { error: avail.reason, status: 409 };
        quote = computeQuote(listing, u.units, { quantity });
      }

      const status = listing.instant_book ? 'confirmed' : 'awaiting_host';

      // Vehicle protection: per-day add-on for the guest's chosen tier, priced
      // server-side and folded into the fee + total so it's actually charged
      // (createBookingIntent charges booking.total). Other verticals: 0.
      const protectionPerDay = listing.vertical === 'vehicle' ? VEHICLE_PROTECTION_PER_DAY[b.protection_plan] : undefined;
      const protectionFee = protectionPerDay != null ? Math.round(protectionPerDay * u.units * 100) / 100 : 0;
      const serviceFee = Math.round((Number(quote.service_fee) + protectionFee) * 100) / 100;
      const total = Math.round((Number(quote.total) + protectionFee) * 100) / 100;

      const booking = await tx.booking.create({
        data: {
          booking_listing_id: listing.booking_listing_id,
          vertical: listing.vertical,
          guest_id: req.user.user_id,
          host_id: listing.owner_id,
          start_date: b.start_date ? new Date(b.start_date) : null,
          end_date: b.end_date ? new Date(b.end_date) : null,
          start_time: norm.start_time ?? null,
          end_time: norm.end_time ?? null,
          unit_count: quote.unit_count,
          quantity: quote.quantity,
          guests: norm.guests,
          subtotal: quote.subtotal,
          cleaning_fee: quote.cleaning_fee,
          service_fee: serviceFee,
          deposit: quote.deposit,
          total: total,
          currency: listing.currency,
          status,
          payment_method: b.payment_method ?? null,
          notes: b.notes ?? null,
          room_type_id: roomType?.room_type_id ?? null,
          referral_code: normalizeReferralCode(b.referral_code),
        },
      });
      await tx.booking_event.create({
        data: {
          booking_id: booking.booking_id,
          event_type: 'created',
          actor_id: req.user.user_id,
          to_status: status,
          metadata: roomType ? { room_type_id: roomType.room_type_id, room_name: roomType.name } : undefined,
        },
      });
      return { booking, listing, status };
    });

    if (result.error) return res.status(result.status).json({ successful: false, message: result.error });

    // Resolve guest display name for the host socket (JWT often has only user_id).
    let customerName = null;
    try {
      const guestUser = await prisma.user.findUnique({
        where: { user_id: req.user.user_id },
        select: BOOKING_PARTY_USER_SELECT,
      });
      customerName = bookingPartyLabel(guestUser);
    } catch {
      customerName = null;
    }

    // Card create-then-pay: wait until Stripe marks the row paid before the host
    // sees a request they can Accept (webhook emits new-booking on paid).
    if (shouldNotifyHostOfNewBooking(result.booking)) {
      emitToUser(req, result.listing.owner_id, {
        type: 'new-booking',
        vertical: result.listing.vertical,
        bookingId: result.booking.booking_id,
        booking_id: result.booking.booking_id,
        amount: result.booking.total,
        instant: result.status === 'confirmed',
        message: result.status === 'confirmed' ? 'New confirmed booking' : 'New booking request',
        guest_id: req.user.user_id,
        customer_name: customerName,
        guest_name: customerName,
        date: result.booking.start_date
          ? String(result.booking.start_date).slice(0, 10)
          : null,
        time: result.booking.start_time ?? null,
        start_time: result.booking.start_time ?? null,
        party_size: result.booking.guests ?? result.booking.quantity ?? 1,
        guests: result.booking.guests ?? result.booking.quantity ?? 1,
        title: result.listing.title ?? null,
        notes: result.booking.notes ?? null,
      });
      emitBookingRequestMail({
        vertical: result.listing.vertical,
        hostId: result.listing.owner_id,
        guestName: customerName,
        bookingId: result.booking.booking_id,
        listingTitle: result.listing.title,
      });
    }

    if (result.status === 'confirmed') {
      emitBookingConfirmedMail({
        vertical: result.listing.vertical,
        guestId: req.user.user_id,
        bookingId: result.booking.booking_id,
        listingTitle: result.listing.title,
        booking: result.booking,
      });
    }

    // Return the booking with party fields so clients don't need a follow-up GET.
    const created = await prisma.booking.findUnique({
      where: { booking_id: result.booking.booking_id },
      include: BOOKING_LIST_INCLUDE,
    });
    const withParty = created ? await attachBookingParty(created) : null;

    res.status(201).json({ successful: true, data: withParty ?? result.booking });
  } catch (err) {
    next(err);
  }
});

// List my bookings as guest (default) or host (?role=host).
// Pass ?vertical=tempstay so a multi-vertical host portal does not bleed bookings.
router.get('/bookings', authenticateToken, async (req, res, next) => {
  try {
    const role = req.query.role === 'host' ? 'host' : 'guest';
    const parsed = parseBookingVertical(req.query.vertical);
    if (!parsed.ok) {
      return res.status(400).json({ successful: false, message: parsed.error });
    }
    const where = {
      ...(role === 'host' ? { host_id: req.user.user_id } : { guest_id: req.user.user_id }),
      ...verticalWhereClause(parsed.vertical),
    };
    const bookings = await prisma.booking.findMany({
      where,
      orderBy: { booking_id: 'desc' },
      include: BOOKING_LIST_INCLUDE,
    });
    const visible = role === 'host' ? filterHostVisibleBookings(bookings) : bookings;
    res.json({ successful: true, data: await attachBookingParty(visible) });
  } catch (err) {
    next(err);
  }
});

router.get('/bookings/:id', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ successful: false, message: 'Invalid booking id' });
    const loaded = await loadOwnBooking(id, req.user.user_id);
    if (loaded.error) return res.status(loaded.status).json({ successful: false, message: loaded.error });
    const full = await prisma.booking.findUnique({
      where: { booking_id: id },
      include: {
        ...BOOKING_LIST_INCLUDE,
        booking_event: { orderBy: { booking_event_id: 'asc' } },
      },
    });
    res.json({ successful: true, data: full ? await attachBookingParty(full) : full });
  } catch (err) {
    next(err);
  }
});

// Host accepts a pending request.
router.put('/bookings/:id/accept', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const loaded = await loadOwnBooking(id, req.user.user_id);
    if (loaded.error) return res.status(loaded.status).json({ successful: false, message: loaded.error });
    if (loaded.booking.host_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Only the host can accept' });
    }
    if (!hostCanActOnPaidStay(loaded.booking)) {
      return res.status(409).json({
        successful: false,
        message: 'This booking cannot be accepted until payment is complete',
      });
    }
    // Re-check hotel room inventory before confirming (another booking may have taken the last unit).
    if (loaded.booking.vertical === 'hotel' && loaded.booking.room_type_id) {
      const roomType = await prisma.hotel_room_type.findFirst({
        where: {
          room_type_id: loaded.booking.room_type_id,
          booking_listing_id: loaded.booking.booking_listing_id,
          is_active: true,
        },
      });
      if (!roomType) {
        return res.status(409).json({ successful: false, message: 'Room type is no longer available' });
      }
      const roomAvail = await checkHotelRoomAvailability(prisma, roomType, {
        start_date: loaded.booking.start_date,
        end_date: loaded.booking.end_date,
        quantity: 1,
        exclude_booking_id: loaded.booking.booking_id,
      });
      if (!roomAvail.ok) {
        return res.status(409).json({
          successful: false,
          message: roomAvail.reason || 'Those dates are fully booked for this room type',
        });
      }
    }
    const t = await transition(loaded.booking, 'confirmed', { actorId: req.user.user_id });
    if (t.error) return res.status(t.status).json({ successful: false, message: t.error });
    emitToUser(req, loaded.booking.guest_id, { type: 'booking-confirmed', bookingId: id, message: 'Your booking was confirmed', vertical: loaded.booking.vertical });
    emitBookingConfirmedMail({
      vertical: loaded.booking.vertical,
      guestId: loaded.booking.guest_id,
      bookingId: id,
      listingTitle: null,
      booking: loaded.booking,
    });
    res.json({ successful: true, data: t.booking });
  } catch (err) {
    next(err);
  }
});

// Host declines a pending request.
router.put('/bookings/:id/decline', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const loaded = await loadOwnBooking(id, req.user.user_id);
    if (loaded.error) return res.status(loaded.status).json({ successful: false, message: loaded.error });
    if (loaded.booking.host_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Only the host can decline' });
    }
    const t = await transition(loaded.booking, 'declined', { actorId: req.user.user_id });
    if (t.error) return res.status(t.status).json({ successful: false, message: t.error });
    await refundMechanicBookingToWallet(t.booking);
    emitToUser(req, loaded.booking.guest_id, { type: 'booking-declined', bookingId: id, message: 'Your booking was declined', vertical: loaded.booking.vertical });
    res.json({ successful: true, data: t.booking });
  } catch (err) {
    next(err);
  }
});

// Guest or host cancels.
router.put('/bookings/:id/cancel', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const loaded = await loadOwnBooking(id, req.user.user_id);
    if (loaded.error) return res.status(loaded.status).json({ successful: false, message: loaded.error });
    const wasPaid = loaded.booking.payment_status === 'paid';
    // Process a refund for a paid booking. Best-effort: if it can't be issued, fall back to
    // 'requested' for manual follow-up so the cancellation itself still goes through.
    let refundStatus = wasPaid ? 'requested' : 'none';
    let refunded = false;
    if (wasPaid && loaded.booking.vertical === 'mechanic') {
      const result = await refundMechanicBookingToWallet(loaded.booking);
      refunded = result.refunded;
      refundStatus = refunded ? 'issued' : 'requested';
    } else if (wasPaid && stripe && loaded.booking.payment_intent_id) {
      try {
        await stripe.refunds.create({ payment_intent: loaded.booking.payment_intent_id });
        refundStatus = 'issued';
        refunded = true;
      } catch (refundErr) {
        console.error('[booking] refund failed:', refundErr.message);
        refundStatus = 'requested';
      }
    }
    const t = await transition(loaded.booking, 'cancelled', {
      actorId: req.user.user_id,
      eventType: 'cancelled',
      extraData: {
        cancellation_reason: req.body?.reason ?? null,
        refund_status: refundStatus,
        payment_status: refunded ? 'refunded' : loaded.booking.payment_status,
      },
    });
    if (t.error) return res.status(t.status).json({ successful: false, message: t.error });
    if (loaded.booking.wallet_credited_at) {
      await reverseBookingWalletCredit(loaded.booking).catch((err) =>
        console.error('[booking] host wallet reverse failed:', err.message),
      );
    }
    const other = loaded.booking.guest_id === req.user.user_id ? loaded.booking.host_id : loaded.booking.guest_id;
    if (shouldNotifyCounterpartyOfCancel(loaded.booking, wasPaid)) {
      emitToUser(req, other, { type: 'booking-cancelled', bookingId: id, message: 'A booking was cancelled' });
    }
    res.json({ successful: true, data: t.booking });
  } catch (err) {
    next(err);
  }
});

// Host marks check-in / completion.
router.patch('/bookings/:id/check-in', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const loaded = await loadOwnBooking(id, req.user.user_id);
    if (loaded.error) return res.status(loaded.status).json({ successful: false, message: loaded.error });
    if (loaded.booking.host_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Only the host can check in a booking' });
    }
    if (!hostCanActOnPaidStay(loaded.booking)) {
      return res.status(409).json({
        successful: false,
        message: 'This booking cannot be checked in until payment is complete',
      });
    }
    const t = await transition(loaded.booking, 'in_progress', { actorId: req.user.user_id, eventType: 'checked_in' });
    if (t.error) return res.status(t.status).json({ successful: false, message: t.error });
    emitToUser(req, loaded.booking.guest_id, { type: 'booking-checked-in', bookingId: id, message: 'Your host checked you in' });
    res.json({ successful: true, data: t.booking });
  } catch (err) {
    next(err);
  }
});

router.patch('/bookings/:id/complete', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    const loaded = await loadOwnBooking(id, req.user.user_id);
    if (loaded.error) return res.status(loaded.status).json({ successful: false, message: loaded.error });
    if (loaded.booking.host_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Only the host can complete a booking' });
    }
    const t = await transition(loaded.booking, 'completed', { actorId: req.user.user_id });
    if (t.error) return res.status(t.status).json({ successful: false, message: t.error });
    await payoutMechanicOnComplete(t.booking);
    await tryCreditSettledBooking(t.booking).catch((err) =>
      console.error('[booking] host wallet settle failed:', err.message),
    );
    emitToUser(req, loaded.booking.guest_id, { type: 'booking-completed', bookingId: id, message: 'Your booking is complete' });
    res.json({ successful: true, data: t.booking });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /booking/bookings/:id/review — guest rates the host/listing after completion.
 * Body: { rating: 1-5, review|comment?: string }
 */
router.post('/bookings/:id/review', authenticateToken, async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ successful: false, message: 'Invalid booking id' });

    const parsed = parseBookingReviewBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ successful: false, message: parsed.error });
    }

    const booking = await prisma.booking.findUnique({
      where: { booking_id: id },
      include: {
        booking_review: {
          select: { booking_review_id: true },
        },
      },
    });
    if (!booking) {
      return res.status(404).json({ successful: false, message: 'Booking not found' });
    }
    if (booking.guest_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Only the guest can review this booking' });
    }
    if (booking.status !== 'completed') {
      return res.status(400).json({
        successful: false,
        message: 'Booking must be completed before rating',
      });
    }
    if (booking.booking_review) {
      return res.status(400).json({ successful: false, message: 'Review already submitted for this booking' });
    }

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.booking_review.create({
        data: {
          booking_id: id,
          booking_listing_id: booking.booking_listing_id,
          user_id: req.user.user_id,
          rating: parsed.data.rating,
          review: parsed.data.review,
        },
      });
      await recomputeListingRating(tx, booking.booking_listing_id);
      return row;
    });

    res.status(201).json({ successful: true, data: created });
  } catch (err) {
    if (err?.code === 'P2002') {
      return res.status(400).json({ successful: false, message: 'Review already submitted for this booking' });
    }
    next(err);
  }
});

/**
 * GET /booking/listings/:id/reviews — public list of reviews for a listing.
 */
router.get('/listings/:id/reviews', async (req, res, next) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ successful: false, message: 'Invalid listing id' });
    const listing = await prisma.booking_listing.findUnique({
      where: { booking_listing_id: id },
      select: {
        booking_listing_id: true,
        avg_rating: true,
        review_count: true,
        is_active: true,
      },
    });
    if (!listing) {
      return res.status(404).json({ successful: false, message: 'Listing not found' });
    }
    const take = Math.min(Math.max(asInt(req.query.limit) || 20, 1), 50);
    const reviews = await prisma.booking_review.findMany({
      where: { booking_listing_id: id },
      orderBy: { created_at: 'desc' },
      take,
      select: {
        booking_review_id: true,
        rating: true,
        review: true,
        created_at: true,
        user: { select: BOOKING_PARTY_USER_SELECT },
      },
    });
    res.json({
      successful: true,
      data: {
        avg_rating: listing.avg_rating ?? 0,
        review_count: listing.review_count ?? 0,
        reviews,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Payment ──────────────────────────────────────────────────────────────--

// Create a Stripe PaymentIntent for a booking. Amount is server-authoritative
// (booking.total) — the client cannot influence the charged amount.
router.post('/bookings/:id/intent', authenticateToken, async (req, res) => {
  try {
    const id = asInt(req.params.id);
    const loaded = await loadOwnBooking(id, req.user.user_id);
    if (loaded.error) return res.status(loaded.status).json({ successful: false, message: loaded.error });
    const booking = loaded.booking;
    if (booking.guest_id !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Only the guest pays for a booking' });
    }
    if (booking.payment_status === 'paid') {
      return res.status(409).json({ successful: false, message: 'Booking already paid' });
    }
    if (!['requested', 'awaiting_host', 'confirmed'].includes(booking.status)) {
      return res.status(409).json({ successful: false, message: 'Booking is not payable in its current state' });
    }
    // Free bookings (e.g. in-person medical visits, no-charge reservations) have
    // nothing to charge — mark paid and return no clientSecret. The client treats
    // a null clientSecret as success and skips the card step.
    if (!(Number(booking.total) > 0)) {
      await prisma.booking.update({
        where: { booking_id: booking.booking_id },
        data: { payment_status: 'paid' },
      });
      return res.json({ successful: true, clientSecret: null });
    }
    if (!stripe) return res.status(503).json({ successful: false, message: 'Stripe not configured' });
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(Number(booking.total) * 100),
      currency: (booking.currency || 'CAD').toLowerCase(),
      metadata: {
        booking_id: String(booking.booking_id),
        user_id: String(booking.guest_id),
        vertical: booking.vertical,
        purpose: 'booking',
      },
    });
    await prisma.booking.update({
      where: { booking_id: booking.booking_id },
      data: { payment_status: 'processing', payment_intent_id: intent.id },
    });
    res.json({ successful: true, clientSecret: intent.client_secret, paymentIntentId: intent.id });
  } catch (err) {
    console.error('[booking] intent error:', err.message);
    res.status(500).json({ successful: false, message: 'Failed to create payment intent' });
  }
});

// export default router;

// Flip a commerce order / donation to paid once its Stripe charge succeeds.
// Keyed by the PaymentIntent id stored on the row at creation time. Returns true
// when a matching row was found (whether it was already paid or just updated), so
// the webhook knows the charge was reconciled and is not orphaned.
async function reconcilePlatformPayment(intentId, io, chargedCents) {
  const food = await prisma.food_order.findFirst({ where: { payment_intent_id: intentId } });
  if (food) {
    if (!food.ispaid) {
      // The card charge is server-priced; the persisted total_amount comes from the client.
      // Flag any divergence between what was actually charged and the recorded total so finance
      // can reconcile (we don't overwrite total_amount — its delivery_fee/tax breakdown is the
      // order-of-record and recomputing it here could corrupt it).
      if (chargedCents != null && food.total_amount != null) {
        const recordedCents = Math.round(parseFloat(food.total_amount) * 100);
        if (Math.abs(recordedCents - chargedCents) > 1) {
          console.error(`[payment] food_order ${food.food_order_id} total mismatch: charged ${chargedCents}c vs recorded ${recordedCents}c (PI ${intentId})`);
        }
      }
      await prisma.food_order.update({
        where: { food_order_id: food.food_order_id },
        data: { ispaid: true, order_status: food.order_status === 'pending' ? 'confirmed' : food.order_status },
      });
      io?.to(`user-${food.user_id}`).emit(`order-status-update-${food.food_order_id}`, { status: 'paid', message: 'Payment confirmed' });
      const foodVendor = food.vendor_id
        ? await prisma.food_vendor.findUnique({ where: { vendor_id: food.vendor_id }, select: { owner_id: true } })
        : null;
      const foodSubtotal = food.platform_fee != null ? food.platform_fee / PLATFORM_FEE_PERCENTAGE : (food.total_amount || 0);
      const foodTake = food.platform_fee != null ? food.platform_fee : (food.total_amount || 0) * PLATFORM_FEE_PERCENTAGE;
      // Referral (buyer friend code) then Recruit (vendor receive-side), shared platform-take budget.
      await settleReferralThenRecruit({
        referralCode: food.referral_code,
        buyerUserId: food.user_id,
        recruitParticipantUserIds: [foodVendor?.owner_id],
        subtotal: foodSubtotal,
        platformTake: foodTake,
        orderType: 'food',
        orderRef: food.food_order_id,
        creditRecruiterShares,
      });
    }
    return true;
  }
  const product = await prisma.product_order.findFirst({ where: { payment_intent_id: intentId } });
  if (product) {
    if (!product.ispaid) {
      await prisma.product_order.update({ where: { order_id: product.order_id }, data: { ispaid: true } });
      // Card order just confirmed paid — now (and only now) notify buyer + seller. Order
      // creation no longer emails for unpaid card orders, so this is the single send point.
      const fullOrder = await loadOrderForEmail(product.order_id);
      if (fullOrder) queueShopOrderPlacedEmails(fullOrder);
      const listingId = fullOrder?.product_variation?.product_listing?.listing_id ?? null;
      if (listingId) {
        await decrementListingStockForOrder(listingId, product.qty ?? 1);
      }
      // Referral (buyer friend code) then Recruit (seller receive-side), shared platform-take budget.
      await settleReferralThenRecruit({
        referralCode: product.referral_code,
        buyerUserId: product.buyer_id,
        recruitParticipantUserIds: [product.seller_id],
        subtotal: product.platform_fee ? product.platform_fee / PLATFORM_FEE_PERCENTAGE : (product.total || 0),
        platformTake: product.platform_fee || (product.total || 0) * PLATFORM_FEE_PERCENTAGE,
        orderType: 'product',
        orderRef: product.order_id,
        creditRecruiterShares,
      });
    }
    return true;
  }
  // A digital/book checkout creates one dg_order row PER cart item, all sharing
  // the same payment_intent_id, so flip every matching row (updateMany) rather
  // than only the first one.
  const dgPaid = await prisma.dg_order.updateMany({
    where: { payment_intent_id: intentId, ispaid: false },
    data: { ispaid: true },
  });
  if (dgPaid.count > 0) {
    // Recruit is receive-side only. dg_order / dg_content has no seller user_id — do not
    // credit on buyer spend (would violate Alfred's rule). Deferred until a seller link exists.
    return true;
  }
  const dgExisting = await prisma.dg_order.findFirst({ where: { payment_intent_id: intentId } });
  if (dgExisting) return true;
  const donation = await prisma.donations.findFirst({ where: { payment_intent_id: intentId } });
  if (donation) {
    if (donation.payment_status !== 'paid') {
      await prisma.donations.update({ where: { donation_id: donation.donation_id }, data: { payment_status: 'paid' } });
    }
    // Recruiter Phase 2: no platform fee at donate time — share fires on raise campaign
    // payout when fee_amount is taken (utils/raise-payout.js markCampaignPayoutPaid).
    return true;
  }
  return false;
}

// ── Stripe webhook (mounted separately with a raw body in index.js) ──────────
// The platform's single Stripe webhook (already registered on staging+prod at
// /booking/webhook/stripe). Reconciles every server-side charge to its row:
//   • bookings        -> payment_status = paid   (the original Temp Stay fix)
//   • commerce orders -> ispaid = true           (food/product/dg)
//   • donations       -> payment_status = paid
// A successful charge with no matching row is recorded as an orphan so a
// charged-but-unpersisted order can never fail silently.
export const bookingWebhookRouter = express.Router();

// ── Celebrity booking webhook handlers ──────────────────────────────────────

/**
 * Handle successful payment intent for celebrity bookings
 */
async function handleCelebrityPaymentIntentSucceeded(paymentIntent) {
  console.log(`[celebrity] Processing payment_intent.succeeded for: ${paymentIntent.id}`);

  const bookingId = parseInt(paymentIntent.metadata.booking_id);
  if (isNaN(bookingId)) {
    console.error(`[celebrity] Invalid booking_id in metadata: ${paymentIntent.metadata.booking_id}`);
    return;
  }

  const booking = await prisma.celebrityBooking.findUnique({
    where: { id: bookingId },
  });

  if (!booking) {
    console.error(`[celebrity] Booking not found for ID: ${bookingId}`);
    return;
  }

  // Idempotency guard - only update if still in PENDING state
  if (booking.payment_status === 'PENDING') {
    await prisma.$transaction(async (tx) => {
      // Update booking payment status
      await tx.celebrityBooking.update({
        where: { id: bookingId },
        data: {
          payment_status: 'PAID',
        },
      });

      // Get or create wallet
      const wallet = await tx.celebrityWallet.upsert({
        where: { celebrity_profile_id: booking.celebrity_profile_id },
        update: {},
        create: {
          celebrity_profile_id: booking.celebrity_profile_id,
          pending_balance: 0,
          available_balance: 0,
          total_earned: 0,
          total_withdrawn: 0,
        },
      });

      // Add to pending balance (available after booking completion)
      await tx.celebrityWallet.update({
        where: { id: wallet.id },
        data: {
          pending_balance: { increment: booking.price },
        },
      });

      // Check if transaction already exists (idempotency)
      const existingTransaction = await tx.celebrityWalletTransaction.findFirst({
        where: {
          wallet_id: wallet.id,
          booking_id: booking.id,
          type: 'BOOKING',
        },
      });

      if (!existingTransaction) {
        // Create pending transaction record
        await tx.celebrityWalletTransaction.create({
          data: {
            wallet_id: wallet.id,
            booking_id: booking.id,
            buyer_profile_id: booking.buyer_profile_id,
            celebrity_profile_id: booking.celebrity_profile_id,
            amount: booking.price,
            type: 'BOOKING',
            status: 'PENDING',
            available_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days clearance
          },
        });
      }
    });

    // Recruiter Phase 2 — platform fee carve on celebrity booking GMV.
    try {
      const full = await prisma.celebrityBooking.findUnique({
        where: { id: bookingId },
        include: {
          buyer_profile: { select: { user_id: true } },
          celebrity_profile: { select: { user_id: true } },
        },
      });
      if (full) {
        await settleReferralThenRecruit({
          referralCode: full.referral_code,
          buyerUserId: full.buyer_profile?.user_id,
          recruitParticipantUserIds: [full.celebrity_profile?.user_id],
          subtotal: full.price,
          platformTake: platformTakeFromPct(full.price),
          orderType: 'celebrity',
          orderRef: full.id,
          creditRecruiterShares,
        });
      }
    } catch (e) {
      console.error('[celebrity] recruiter share failed:', e.message);
    }

    console.log(`[celebrity] Payment succeeded for booking ${bookingId}`);
  } else {
    console.log(`[celebrity] Booking ${bookingId} already has status: ${booking.payment_status}, skipping duplicate`);
  }
}

/**
 * Handle failed payment intent for celebrity bookings
 */
async function handleCelebrityPaymentIntentFailed(paymentIntent) {
  console.log(`[celebrity] Processing payment_intent.payment_failed for: ${paymentIntent.id}`);

  const bookingId = parseInt(paymentIntent.metadata.booking_id);
  if (isNaN(bookingId)) {
    console.error(`[celebrity] Invalid booking_id in metadata: ${paymentIntent.metadata.booking_id}`);
    return;
  }

  const booking = await prisma.celebrityBooking.findUnique({
    where: { id: bookingId },
  });

  if (!booking) {
    console.error(`[celebrity] Booking not found for ID: ${bookingId}`);
    return;
  }

  // Only update if still in PENDING state (don't clobber a paid order)
  if (booking.payment_status === 'PENDING') {
    await prisma.celebrityBooking.update({
      where: { id: bookingId },
      data: {
        payment_status: 'FAILED',
      },
    });

    console.log(`[celebrity] Payment failed for booking ${bookingId}`);
  } else {
    console.log(`[celebrity] Booking ${bookingId} already has status: ${booking.payment_status}, skipping failed update`);
  }
}

/**
 * Handle canceled payment intent for celebrity bookings
 */
async function handleCelebrityPaymentIntentCanceled(paymentIntent) {
  console.log(`[celebrity] Processing payment_intent.canceled for: ${paymentIntent.id}`);

  const bookingId = parseInt(paymentIntent.metadata.booking_id);
  if (isNaN(bookingId)) {
    console.error(`[celebrity] Invalid booking_id in metadata: ${paymentIntent.metadata.booking_id}`);
    return;
  }

  const booking = await prisma.celebrityBooking.findUnique({
    where: { id: bookingId },
  });

  if (!booking) {
    console.error(`[celebrity] Booking not found for ID: ${bookingId}`);
    return;
  }

  // Only cancel if still pending
  if (booking.payment_status === 'PENDING') {
    await prisma.celebrityBooking.update({
      where: { id: bookingId },
      data: {
        payment_status: 'CANCELLED',
      },
    });

    console.log(`[celebrity] Payment canceled for booking ${bookingId}`);
  }
}

// ── Webhook endpoint ─────────────────────────────────────────────────────────

bookingWebhookRouter.post('/', async (req, res) => {
  if (!stripe) return res.status(503).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (secret) {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } else if (process.env.NODE_ENV === 'test') {
      event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body);
    } else {
      console.error('[booking-webhook] STRIPE_WEBHOOK_SECRET is unset — refusing unsigned event');
      return res.status(503).send('Webhook signing secret not configured');
    }
  } catch (err) {
    // 4xx: Stripe will not retry. Only signature/payload parse failures belong here.
    console.error('[booking] webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    console.log(`Received Stripe event: ${event.type} (ID: ${event.id})`);

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const intentId = pi.id;
      const meta = pi.metadata || {};
      const purpose = meta.purpose || null;
      const io = req.app.get('io');

      // 0) Live coin packs — credit even if the browser never calls /live-coins/buy/confirm.
      // confirmCoinPurchase is idempotent on stripe_payment_intent_id (client + webhook safe).
      if (purpose === 'live_coin_purchase') {
        const userId = meta.user_id ? Number(meta.user_id) : null;
        if (!Number.isInteger(userId) || userId <= 0) {
          console.error(`[live-coins] webhook missing user_id on ${intentId}`);
          // 5xx so Stripe retries — without user_id we cannot credit safely.
          return res.status(500).json({ received: false, error: 'missing_user_id' });
        }
        try {
          await confirmCoinPurchase(userId, intentId);
        } catch (e) {
          console.error(`[live-coins] webhook credit failed for ${intentId}:`, e?.message || e);
          // Do NOT ACK — Stripe will retry until credit succeeds (confirm is idempotent).
          return res.status(500).json({ received: false, error: 'credit_failed' });
        }
        return res.json({ received: true });
      }

      // 0a) Celebrity bookings
      if (purpose === 'celebrity_booking') {
        await handleCelebrityPaymentIntentSucceeded(pi);
        return res.json({ received: true });
      }

      // 1) Booking engine (the original use case).
      const booking = await prisma.booking.findFirst({ where: { payment_intent_id: intentId } });
      if (booking) {
        if (booking.payment_status !== 'paid') {
          await prisma.booking.update({
            where: { booking_id: booking.booking_id },
            data: { payment_status: 'paid' },
          });
          await prisma.booking_event.create({
            data: { booking_id: booking.booking_id, event_type: 'paid', metadata: { intentId } },
          });
          io?.to(`user-${booking.host_id}`).emit(`notification_user_${booking.host_id}`, {
            type: 'booking-paid', bookingId: booking.booking_id, message: 'A booking was paid',
          });
          // Host list is filtered to paid card stays and create no longer emits
          // new-booking — surface the request now that money landed.
          io?.to(`user-${booking.host_id}`).emit(`notification_user_${booking.host_id}`, {
            type: 'new-booking',
            vertical: booking.vertical,
            bookingId: booking.booking_id,
            booking_id: booking.booking_id,
            amount: booking.total,
            instant: booking.status === 'confirmed',
            message: booking.status === 'confirmed' ? 'New confirmed booking' : 'New booking request',
          });
          emitBookingRequestMail({
            vertical: booking.vertical,
            hostId: booking.host_id,
            guestName: null,
            bookingId: booking.booking_id,
            listingTitle: null,
          });
          if (booking.status === 'confirmed') {
            emitBookingConfirmedMail({
              vertical: booking.vertical,
              guestId: booking.guest_id,
              bookingId: booking.booking_id,
              listingTitle: null,
              booking,
            });
          }
          // This is a webhook, not a user request — there is no `req.user`, and emitToUser() is
          // fine to use since it only reads req.app. Notify BOTH parties: the host that money
          // landed, and the guest (who was previously told nothing at all) that their payment
          // went through.
          notifyUnified(io, {
            userId: booking.host_id, vertical: 'booking', type: 'booking.paid',
            title: 'A booking was paid', urgency: 'ambient',
            entityType: 'booking', entityId: booking.booking_id, actionUrl: 'orders',
          });
          notifyUnified(io, {
            userId: booking.guest_id, vertical: 'booking', type: 'booking.paid',
            title: 'Your booking payment went through', urgency: 'ambient',
            entityType: 'booking', entityId: booking.booking_id, actionUrl: 'orders',
          });
          // Referral (guest friend code) then Recruit (host receive-side), shared platform-take budget.
          await settleReferralThenRecruit({
            referralCode: booking.referral_code,
            buyerUserId: booking.guest_id,
            recruitParticipantUserIds: [booking.host_id],
            subtotal: booking.subtotal != null ? booking.subtotal : (booking.total || 0),
            platformTake: booking.service_fee != null ? booking.service_fee : (booking.total || 0) * PLATFORM_FEE_PERCENTAGE,
            orderType: 'booking',
            orderRef: booking.booking_id,
            creditRecruiterShares,
          });
        }
        return res.json({ received: true });
      }

      // 1b) Freelance (digital services) orders. Their PaymentIntents are created in
      //     routes/freelance-orders-routes.js and carry no `purpose`, so match on the order
      //     row via the unique stripe_payment_intent_id. This is the single Stripe webhook the
      //     Dashboard delivers to, so these events already arrive here — the old dedicated
      //     freelance webhook (routes/stripe-webhook-routes.js) was mounted after json() and
      //     400'd on every delivery, leaving every paid order stuck PENDING. Idempotent: only a
      //     PENDING order is touched, so a Stripe re-delivery is a no-op.
      const freelanceOrder = await prisma.freelancerOrder.findUnique({
        where: { stripe_payment_intent_id: intentId },
        include: {
          buyer_profile: { select: { user_id: true } },
          freelancer_profile: { select: { user_id: true } },
        },
      });
      if (freelanceOrder) {
        if (freelanceOrder.payment_status === 'PENDING') {
          await prisma.freelancerOrder.update({
            where: { id: freelanceOrder.id },
            data: { payment_status: 'PAID', status: 'IN_PROGRESS' },
          });
          const buyerId = meta.buyer_id ? Number(meta.buyer_id) : freelanceOrder.buyer_profile?.user_id;
          if (Number.isInteger(buyerId) && buyerId > 0) {
            notifyUnified(io, {
              userId: buyerId, vertical: 'freelance', type: 'freelance.paid',
              title: 'Your order payment went through', urgency: 'ambient',
              entityType: 'freelance_order', entityId: freelanceOrder.id, actionUrl: 'orders',
            });
          }
          // Referral (buyer friend code) then Recruit (freelancer receive-side).
          await settleReferralThenRecruit({
            referralCode: freelanceOrder.referral_code,
            buyerUserId: freelanceOrder.buyer_profile?.user_id ?? buyerId,
            recruitParticipantUserIds: [freelanceOrder.freelancer_profile?.user_id],
            subtotal: freelanceOrder.price,
            platformTake: (Number(freelanceOrder.price) || 0) * PLATFORM_FEE_PERCENTAGE,
            orderType: 'freelance',
            orderRef: freelanceOrder.id,
            creditRecruiterShares,
          });
        }
        return res.json({ received: true });
      }

      // 1c) Book-an-artist bookings. Same pattern as freelance: the PaymentIntent is
      //     created in routes/book-artist-routes.js /pay carrying the booking's unique
      //     stripe_payment_intent_id, so match on that. creditArtistBookingOnPaid flips
      //     PENDING->PAID and credits the artist's pending wallet exactly once (atomic
      //     guard), so a Stripe re-delivery or a racing GET self-heal is a no-op.
      //     (Previously this lived on a second /artist/stripe webhook whose per-endpoint
      //     signing secret never matched, so buyers were charged but wallets never credited.)
      const artistBooking = await prisma.artistBooking.findUnique({
        where: { stripe_payment_intent_id: intentId },
        include: {
          buyer_profile: { select: { user_id: true } },
          artist_profile: { select: { user_id: true } },
          artist_listing: { select: { service_fee_pct: true } },
        },
      });
      if (artistBooking) {
        await creditArtistBookingOnPaid(artistBooking);
        return res.json({ received: true });
      }

      // 2) Commerce orders + donations.
      const reconciled = await reconcilePlatformPayment(intentId, io, pi.amount);

      // 3) Nothing matched. For a commerce/donation charge that means the order
      //    never persisted (or this webhook beat the insert): record an orphan so
      //    the charge can be reconciled/refunded. The order-create path clears it
      //    if the row arrives afterwards. Rideshare/unknown charges are handled by
      //    their own flow — don't flag them.
      if (!reconciled && (purpose === 'commerce' || purpose === 'donation')) {
        await prisma.stripe_orphan_payment.upsert({
          where: { payment_intent_id: intentId },
          update: {},
          create: {
            payment_intent_id: intentId,
            user_id: meta.user_id ? Number(meta.user_id) : null,
            amount: pi.amount != null ? pi.amount / 100 : null,
            currency: pi.currency || null,
            purpose,
            vertical: meta.vertical || null,
          },
        }).catch((e) => console.error('[payment] orphan upsert failed:', e.message));
        console.error(`[payment] ORPHANED CHARGE ${intentId} (${purpose}/${meta.vertical || '?'}) — no order row found`);
      }
    }

    // Payment failed / card declined. This branch did not exist — the webhook only ever handled
    // success, so a declined card was completely silent to the user: no email, no notification,
    // nothing. They'd just find their order never appeared.
    //
    // The recipient comes from the PaymentIntent metadata, which routes/payment-routes.js stamps
    // with user_id on creation. If it's absent there is genuinely no one to tell.
    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      const meta = pi.metadata || {};
      const io = req.app.get('io');

      // Celebrity booking failure
      if (meta.purpose === 'celebrity_booking') {
        await handleCelebrityPaymentIntentFailed(pi);
        return res.json({ received: true });
      }

      // Freelance order failure. Guard on PENDING so a late-arriving payment_failed can never
      // clobber an order that already succeeded — Stripe does not guarantee delivery ordering,
      // and confirmCardPayment retries a declined card in place, so payment_failed and
      // payment_intent.succeeded can both fire on the same intent, in either order.
      const freelanceOrder = await prisma.freelancerOrder.findUnique({ where: { stripe_payment_intent_id: pi.id } });
      if (freelanceOrder) {
        if (freelanceOrder.payment_status === 'PENDING') {
          await prisma.freelancerOrder.update({
            where: { id: freelanceOrder.id },
            data: { payment_status: 'FAILED' },
          });
        }
        const buyerId = meta.buyer_id ? Number(meta.buyer_id) : null;
        if (Number.isInteger(buyerId) && buyerId > 0) {
          notifyUnified(io, {
            userId: buyerId, vertical: 'payments', type: 'payment.failed',
            title: 'Your order payment failed',
            body: pi.last_payment_error?.message || 'Your card was declined. Try a different payment method.',
            urgency: 'actionable', entityType: 'freelance_order', entityId: freelanceOrder.id,
            actionUrl: 'orders', data: { payment_intent_id: pi.id },
          });
        }
        return res.json({ received: true });
      }

      // Book-an-artist booking failure (same PENDING guard).
      const artistBookingFailed = await prisma.artistBooking.findUnique({ where: { stripe_payment_intent_id: pi.id } });
      if (artistBookingFailed) {
        await failArtistBookingIfPending(artistBookingFailed.id);
        return res.json({ received: true });
      }

      // Booking-engine hold: a declined card must release the calendar so the
      // date is not stranded as awaiting_host/confirmed forever.
      const failedBooking = await prisma.booking.findFirst({ where: { payment_intent_id: pi.id } });
      if (failedBooking && failedBooking.payment_status !== 'paid') {
        const cancelable = ['requested', 'awaiting_host', 'confirmed'].includes(failedBooking.status);
        if (cancelable) {
          await transition(failedBooking, 'cancelled', {
            eventType: 'payment_failed',
            extraData: {
              payment_status: 'failed',
              cancellation_reason: pi.last_payment_error?.message || 'Payment failed',
            },
          });
        } else {
          await prisma.booking.update({
            where: { booking_id: failedBooking.booking_id },
            data: { payment_status: 'failed' },
          });
        }
        const guestId = failedBooking.guest_id || (meta.user_id ? Number(meta.user_id) : null);
        if (Number.isInteger(guestId) && guestId > 0) {
          notifyUnified(io, {
            userId: guestId,
            vertical: 'booking',
            type: 'payment.failed',
            title: 'Your booking payment failed',
            body: pi.last_payment_error?.message || 'Your card was declined. Try a different payment method.',
            urgency: 'actionable',
            entityType: 'booking',
            entityId: failedBooking.booking_id,
            actionUrl: 'orders',
            data: { payment_intent_id: pi.id, purpose: 'booking', vertical: failedBooking.vertical },
          });
        }
        return res.json({ received: true });
      }

      const userId = meta.user_id ? Number(meta.user_id) : null;
      if (Number.isInteger(userId)) {
        const reason = pi.last_payment_error?.message || null;
        notifyUnified(io, {
          userId,
          vertical: 'payments',
          type: 'payment.failed',
          title: 'Your payment failed',
          body: reason || 'Your card was declined. Try a different payment method.',
          urgency: 'actionable',
          entityType: 'payment_intent',
          entityId: null,
          actionUrl: 'wallet',
          data: { payment_intent_id: pi.id, purpose: meta.purpose || null, vertical: meta.vertical || null },
        });
      }
      return res.json({ received: true });
    }

    // Payment intent canceled. Merged from the standalone celebrity webhook
    // (routes/celebrity-stripe-webhook.js) — celebrity bookings are currently
    // the only vertical that reacts to this event, so it's gated on `purpose`
    // the same way succeeded/failed are above. If another vertical needs
    // cancel handling later, add a branch here rather than a new endpoint.
    if (event.type === 'payment_intent.canceled') {
      const pi = event.data.object;
      const meta = pi.metadata || {};
      if (meta.purpose === 'celebrity_booking') {
        await handleCelebrityPaymentIntentCanceled(pi);
      }
      return res.json({ received: true });
    }

    // Chargeback / dispute opened. Also had no code path at all.
    if (event.type === 'charge.dispute.created') {
      const dispute = event.data.object;
      const io = req.app.get('io');
      const intentId = dispute.payment_intent;
      // Resolve the payer the same way reconcilePlatformPayment does — by the intent id, which is
      // the only join key a dispute carries back to our own rows.
      const [booking, orphan] = await Promise.all([
        intentId ? prisma.booking.findFirst({ where: { payment_intent_id: intentId }, select: { guest_id: true, booking_id: true } }) : null,
        intentId ? prisma.stripe_orphan_payment.findUnique({ where: { payment_intent_id: intentId }, select: { user_id: true } }).catch(() => null) : null,
      ]);
      const userId = booking?.guest_id ?? orphan?.user_id ?? null;
      if (Number.isInteger(userId)) {
        notifyUnified(io, {
          userId,
          vertical: 'payments',
          type: 'payment.disputed',
          title: 'A payment dispute was opened',
          body: 'We are reviewing a dispute raised on one of your payments.',
          urgency: 'ambient',
          entityType: booking ? 'booking' : 'payment_intent',
          entityId: booking?.booking_id ?? null,
          actionUrl: 'wallet',
          data: { payment_intent_id: intentId || null, reason: dispute.reason || null },
        });
      }
      return res.json({ received: true });
    }

    // Chargeback / dispute resolved (added for celebrity and other services)
    if (event.type === 'charge.dispute.closed') {
      const dispute = event.data.object;
      const io = req.app.get('io');
      const intentId = dispute.payment_intent;
      const [booking, orphan] = await Promise.all([
        intentId ? prisma.booking.findFirst({ where: { payment_intent_id: intentId }, select: { guest_id: true, booking_id: true } }) : null,
        intentId ? prisma.stripe_orphan_payment.findUnique({ where: { payment_intent_id: intentId }, select: { user_id: true } }).catch(() => null) : null,
      ]);
      const userId = booking?.guest_id ?? orphan?.user_id ?? null;
      if (Number.isInteger(userId)) {
        const status = dispute.status || 'closed';
        notifyUnified(io, {
          userId,
          vertical: 'payments',
          type: 'payment.dispute_resolved',
          title: `Payment dispute ${status === 'won' ? 'resolved in your favor' : 'closed'}`,
          body: status === 'won' ? 'The dispute was resolved in your favor.' : 'The dispute has been closed.',
          urgency: 'ambient',
          entityType: booking ? 'booking' : 'payment_intent',
          entityId: booking?.booking_id ?? null,
          actionUrl: 'wallet',
          data: { payment_intent_id: intentId || null, status },
        });
      }
      return res.json({ received: true });
    }

    // Live subscription lifecycle (Twitch-style paid subs). These event types are
    // only emitted once subscriptions exist; the handler dispatches by event.type
    // and is a no-op for anything that isn't a live subscription.
    if (
      event.type === 'checkout.session.completed' ||
      event.type.startsWith('invoice.') ||
      event.type.startsWith('customer.subscription.')
    ) {
      await handleSubscriptionWebhookEvent(event);
    }

    res.json({ received: true });
  } catch (err) {
    // 5xx: Stripe retries. A transient DB/Redis blip must not look like a delivered event.
    console.error('[booking] webhook processing error:', err.message);
    res.status(500).send('Webhook handler failed');
  }
});

export default router;