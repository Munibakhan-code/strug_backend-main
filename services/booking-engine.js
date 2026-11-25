// Shared Booking Engine — pure logic for the Airbnb-style verticals.
// Pricing, unit math, availability/conflict checks, and the status machine
// live here so they are testable and identical across every vertical.
// No Express / no Prisma session state in the pure helpers; the DB-touching
// helpers take a Prisma client (or transaction) as their first argument.

import { isSingleUnitVertical } from '../utils/booking-capacity.js';
import { dayRangeInTimeZone } from '../utils/business-time.js';

// price_unit -> how a booking's span is measured.
export const DATE_RANGE_UNITS = new Set(['night', 'day', 'week']);
export const TIME_SLOT_UNITS = new Set(['hour']);
export const SINGLE_UNITS = new Set(['session', 'event', 'async']);

// Verticals where a "session"-priced booking is really a scheduled appointment:
// several appointments can share the same calendar day as long as their time
// windows don't overlap. Everything else in the generic session/event/async
// branch keeps the original, deliberately conservative whole-day behaviour —
// a celebrity booking, a full-day rental, etc. really does occupy the day.
export const APPOINTMENT_STYLE_VERTICALS = new Set(['mechanic', 'medical']);

// Appointment-style listings don't carry a structured service duration, so a
// booked slot is assumed to occupy this long unless the client sends an
// explicit end_time. Medical UI slots are 30 minutes; mechanic stays 60.
export const DEFAULT_APPOINTMENT_DURATION_MINUTES = 60;
export const MEDICAL_APPOINTMENT_DURATION_MINUTES = 30;

export function appointmentDurationMinutes(listingOrVertical) {
  const vertical = typeof listingOrVertical === 'string'
    ? listingOrVertical
    : listingOrVertical?.vertical;
  return vertical === 'medical'
    ? MEDICAL_APPOINTMENT_DURATION_MINUTES
    : DEFAULT_APPOINTMENT_DURATION_MINUTES;
}

// Bookings in these states occupy the calendar (block conflicting bookings).
// Terminal/negative states (declined, cancelled, completed) do not.
export const ACTIVE_BOOKING_STATUSES = ['requested', 'awaiting_host', 'confirmed', 'in_progress'];

// Allowed status transitions for the unified lifecycle.
const TRANSITIONS = {
  requested: ['awaiting_host', 'confirmed', 'declined', 'cancelled'],
  awaiting_host: ['confirmed', 'declined', 'cancelled'],
  confirmed: ['in_progress', 'cancelled', 'completed'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  declined: [],
  cancelled: [],
};

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

/** Guest/host may cancel while the stay is still active (not terminal). */
export function canCancelBooking(status) {
  return canTransition(status, 'cancelled');
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDateOnly(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Default restaurant turn time (OpenTable-style seating window).
export const DEFAULT_RESERVATION_TURN_MINUTES = 90;

// Parse "HH:MM" -> minutes since midnight; null if malformed.
function minutesOfDay(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function formatHHMM(totalMinutes) {
  const mins = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Add minutes to an HH:MM string; returns HH:MM or null. */
export function addMinutesToTime(hhmm, minutes) {
  const base = minutesOfDay(hhmm);
  if (base == null || !Number.isFinite(Number(minutes))) return null;
  return formatHHMM(base + Number(minutes));
}

/**
 * Resolve end_time for a restaurant reservation. Prefer explicit end_time;
 * otherwise start + turn minutes (default 90).
 */
export function resolveReservationEndTime(startTime, endTime, turnMinutes = DEFAULT_RESERVATION_TURN_MINUTES) {
  if (endTime && minutesOfDay(endTime) != null) return endTime;
  const turn = Number.isFinite(Number(turnMinutes)) && Number(turnMinutes) > 0
    ? Number(turnMinutes)
    : DEFAULT_RESERVATION_TURN_MINUTES;
  return addMinutesToTime(startTime, turn);
}

/**
 * Party size for availability math. Prefer quantity; fall back to guests.
 * For legacy rows where quantity stayed at the default 1 but guests has the
 * real party size, prefer guests when it is larger.
 */
export function partySizeFromBookingLike(row) {
  const q = Math.floor(Number(row?.quantity));
  const g = Math.floor(Number(row?.guests));
  if (Number.isFinite(g) && g > 1 && (!Number.isFinite(q) || q === 1)) return g;
  if (Number.isFinite(q) && q > 0) return q;
  if (Number.isFinite(g) && g > 0) return g;
  return 1;
}

/** Resolve quantity for a proposed booking (guests → quantity when omitted). */
export function resolveReservationQuantity(proposed = {}) {
  if (proposed.quantity != null && proposed.quantity !== '') {
    return normalizeQuantity(proposed.quantity);
  }
  if (proposed.guests != null && proposed.guests !== '') {
    return normalizeQuantity(proposed.guests);
  }
  return 1;
}

function reservationTurnMinutes(listing) {
  const attrs = listing?.attributes && typeof listing.attributes === 'object' ? listing.attributes : {};
  const fromAttrs = Number(attrs.turn_time_minutes ?? attrs.turn_minutes);
  if (Number.isFinite(fromAttrs) && fromAttrs > 0) return fromAttrs;
  return DEFAULT_RESERVATION_TURN_MINUTES;
}

function isReservationListing(listing) {
  return listing?.vertical === 'reservation';
}

// How many billable units a booking spans, given the listing's price_unit.
// Returns a positive integer, or { error } when the span is invalid.
// Optional `vertical`: wedding multi-day ranges (inclusive end) bill per event-day.
export function computeUnits(priceUnit, { startDate, endDate, startTime, endTime, vertical } = {}) {
  const unit = priceUnit || 'night';

  if (DATE_RANGE_UNITS.has(unit)) {
    const s = toDateOnly(startDate);
    const e = toDateOnly(endDate);
    if (!s || !e) return { error: 'start_date and end_date are required' };
    const days = Math.round((e.getTime() - s.getTime()) / MS_PER_DAY);
    if (days <= 0) return { error: 'end_date must be after start_date' };
    if (unit === 'week') return { units: Math.ceil(days / 7) };
    return { units: days }; // night & day both bill per 24h span
  }

  if (TIME_SLOT_UNITS.has(unit)) {
    const from = minutesOfDay(startTime);
    const to = minutesOfDay(endTime);
    if (from == null || to == null) return { error: 'start_time and end_time are required (HH:MM)' };
    if (to <= from) return { error: 'end_time must be after start_time' };
    return { units: Math.ceil((to - from) / 60) };
  }

  // Wedding packages: inclusive multi-day span bills once per calendar day in the range.
  if (vertical === 'wedding' && (unit === 'event' || !unit)) {
    const s = toDateOnly(startDate);
    const e = toDateOnly(endDate) || s;
    if (!s) return { units: 1 };
    if (e.getTime() < s.getTime()) return { error: 'end_date must be on or after start_date' };
    const inclusiveDays = Math.round((e.getTime() - s.getTime()) / MS_PER_DAY) + 1;
    return { units: Math.max(1, inclusiveDays) };
  }

  // session / event / async — a single bookable unit.
  return { units: 1 };
}

// Coerce a quantity (tickets / seats / people / items) to a positive integer.
export function normalizeQuantity(quantity) {
  const n = Math.floor(Number(quantity));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Server-authoritative price breakdown. NEVER trust client totals.
// `unitPrice` may be overridden per-date by the availability table.
// `quantity` is a per-booking multiplier (event tickets, per-person sessions,
// rented items) applied on top of the time-span unit_count; it defaults to 1
// so single-booking and date-range verticals (stays/rentals) are unaffected.
export function computeQuote(listing, units, { unitPriceOverride, quantity = 1 } = {}) {
  const qty = normalizeQuantity(quantity);
  const unitPrice = Number(unitPriceOverride ?? listing.price ?? 0);
  const subtotal = round2(unitPrice * units * qty);
  const cleaningFee = round2(Number(listing.cleaning_fee ?? 0));
  const serviceFeePct = Number(listing.service_fee_pct ?? 0);
  const serviceFee = round2(subtotal * (serviceFeePct / 100));
  // Deposit scales with quantity (a per-item security hold); flat fees stay flat.
  const depositEach = listing.requires_deposit ? Number(listing.deposit_amount ?? 0) : 0;
  const deposit = round2(depositEach * qty);
  const total = round2(subtotal + cleaningFee + serviceFee + deposit);
  return { unit_count: units, quantity: qty, subtotal, cleaning_fee: cleaningFee, service_fee: serviceFee, deposit, total };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Two date-range spans [aStart,aEnd) and [bStart,bEnd) overlap?
function dateRangesOverlap(aStart, aEnd, bStart, bEnd) {
  const as = toDateOnly(aStart), ae = toDateOnly(aEnd);
  const bs = toDateOnly(bStart), be = toDateOnly(bEnd);
  if (!as || !ae || !bs || !be) return false;
  return as.getTime() < be.getTime() && bs.getTime() < ae.getTime();
}

// Two same-day time slots overlap?
// End times that wrap past midnight (e.g. 23:30 → 01:00) are lifted by +24h so
// overnight reservation turns still conflict correctly with evening bookings.
function normalizeInterval(fromHHMM, toHHMM) {
  const from = minutesOfDay(fromHHMM);
  const toRaw = minutesOfDay(toHHMM);
  if (from == null || toRaw == null) return null;
  const to = toRaw <= from ? toRaw + (24 * 60) : toRaw;
  return { from, to };
}

function timeSlotsOverlap(aFrom, aTo, bFrom, bTo) {
  const a = normalizeInterval(aFrom, aTo);
  const b = normalizeInterval(bFrom, bTo);
  if (!a || !b) return false;
  return a.from < b.to && b.from < a.to;
}

/**
 * Restaurant (vertical=reservation) availability: seats are shared across
 * overlapping turn windows on the same day — not the whole calendar day.
 * Mutates nothing; returns a normalized proposed window for callers.
 */
function normalizeReservationProposed(listing, proposed) {
  const start_time = proposed.start_time ?? null;
  const end_time = resolveReservationEndTime(
    start_time,
    proposed.end_time,
    reservationTurnMinutes(listing),
  );
  const quantity = resolveReservationQuantity(proposed);
  return { ...proposed, start_time, end_time, quantity };
}

function bookingEndTime(listing, booking) {
  if (booking.end_time && minutesOfDay(booking.end_time) != null) return booking.end_time;
  if (!isReservationListing(listing)) return booking.end_time ?? null;
  return resolveReservationEndTime(
    booking.start_time,
    booking.end_time,
    reservationTurnMinutes(listing),
  );
}

function listingAttributes(listing) {
  return listing?.attributes && typeof listing.attributes === 'object' && !Array.isArray(listing.attributes)
    ? listing.attributes
    : {};
}

/**
 * Max party size for a reservation listing. Requires an explicit host-configured
 * value (listing.capacity or attributes.max_guests) — no silent defaults.
 */
export function resolveReservationMaxParty(listing) {
  const attrs = listingAttributes(listing);
  const maxPartyRaw = listing?.capacity ?? attrs.max_guests;
  if (maxPartyRaw == null || maxPartyRaw === '') {
    return {
      ok: false,
      reason: 'Reservation party size capacity must be configured for this listing',
    };
  }
  const maxParty = Number(maxPartyRaw);
  if (!Number.isFinite(maxParty)) {
    return {
      ok: false,
      reason: 'Reservation party size capacity must be configured for this listing',
    };
  }
  if (maxParty <= 0) {
    return {
      ok: false,
      reason: 'Reservation party size capacity must be greater than 0',
    };
  }
  return { ok: true, maxParty };
}

function classifyProposedBooking(listing, proposed) {
  const unit = listing.price_unit || 'night';
  // Wedding multi-day packages: when end_date is after start_date, treat as an inclusive
  // date-range for conflict checks so setup/teardown days cannot be double-booked.
  // Billing uses inclusive event-days via computeUnits(..., { vertical: 'wedding' }).
  const startOnly = toDateOnly(proposed?.start_date);
  const endOnly = toDateOnly(proposed?.end_date);
  const multiDayWedding =
    listing?.vertical === 'wedding'
    && startOnly
    && endOnly
    && endOnly.getTime() > startOnly.getTime();
  const isDateRange = DATE_RANGE_UNITS.has(unit) || multiDayWedding;
  const isTimeSlot = TIME_SLOT_UNITS.has(unit);
  const isReservation = isReservationListing(listing)
    && proposed.start_time
    && minutesOfDay(proposed.start_time) != null;

  const normalized = isReservation
    ? normalizeReservationProposed(listing, proposed)
    : {
      ...proposed,
      quantity: normalizeQuantity(proposed.quantity ?? proposed.guests),
      // Availability uses half-open [start, end). Client sends inclusive end for wedding —
      // bump by one day only for the conflict check (booking row still stores inclusive end).
      ...(multiDayWedding ? { end_date: addDays(endOnly, 1) } : {}),
    };
  return { unit, isDateRange, isTimeSlot, isReservation, normalized };
}

function evaluateBlockedRows(listing, normalized, blocked, { isDateRange, isTimeSlot, isReservation }) {
  for (const row of blocked) {
    if (isDateRange && normalized.start_date && normalized.end_date) {
      // a single blocked date inside the requested span is a conflict
      if (row.date && dateRangesOverlap(normalized.start_date, normalized.end_date, row.date, addDays(row.date, 1))) {
        return { ok: false, reason: 'Host has blocked one or more of the selected dates' };
      }
    } else if ((isTimeSlot || isReservation) && normalized.start_date) {
      const blockFrom = row.time_from;
      const blockTo = row.time_to;
      // All-day block (no times) or overlapping time window.
      if (row.date && sameDay(row.date, normalized.start_date)) {
        if (!blockFrom && !blockTo) {
          return { ok: false, reason: 'Host has blocked the selected date' };
        }
        if (timeSlotsOverlap(normalized.start_time, normalized.end_time, blockFrom, blockTo)) {
          return { ok: false, reason: 'Host has blocked the selected time slot' };
        }
      }
    } else if (normalized.start_date && row.date && sameDay(row.date, normalized.start_date)) {
      // session / event / async — host calendar blocks apply to the event day.
      return { ok: false, reason: 'Host has blocked this date' };
    }
  }
  return { ok: true };
}

function evaluateReservationAvailability(listing, normalized, existing) {
  // listing.capacity is the host-facing "Party size" (max guests per booking),
  // NOT total dining-room seats. Concurrent inventory comes from attributes:
  //   tables           → concurrent parties (each booking counts as 1)
  //   seating_capacity → optional total seats across overlapping turn windows
  // When BOTH are set, both constraints apply (seating must not replace tables).
  // When NEITHER is set: default 1 concurrent party so a booked time is taken.
  const maxPartyResult = resolveReservationMaxParty(listing);
  if (!maxPartyResult.ok) return maxPartyResult;

  const { maxParty } = maxPartyResult;
  const want = normalized.quantity;
  if (want > maxParty) {
    return { ok: false, reason: `Maximum party size is ${maxParty}` };
  }

  const attrs = listingAttributes(listing);
  const overlapping = existing.filter((b) => {
    if (!b.start_date || !normalized.start_date || !sameDay(b.start_date, normalized.start_date)) return false;
    if (!b.start_time || minutesOfDay(b.start_time) == null) {
      // Legacy same-day booking without a time — treat as occupying the whole day.
      return true;
    }
    const bEnd = bookingEndTime(listing, b);
    return timeSlotsOverlap(normalized.start_time, normalized.end_time, b.start_time, bEnd);
  });

  const seatingCap = Number(attrs.seating_capacity);
  const hasSeats = Number.isFinite(seatingCap) && seatingCap > 0;
  const tablesCap = Number(attrs.tables);
  const hasTables = Number.isFinite(tablesCap) && tablesCap > 0;

  // Primary: concurrent parties via tables (reviewer Issue 1).
  if (hasTables) {
    const remainingTables = tablesCap - overlapping.length;
    if (remainingTables < 1) {
      return {
        ok: false,
        reason: remainingTables <= 0
          ? 'That time slot is fully booked'
          : `Only ${remainingTables} table${remainingTables === 1 ? '' : 's'} left for that time`,
      };
    }
  }

  // Optional: total seats across overlapping turns (additional constraint).
  if (hasSeats) {
    const usedSeats = overlapping.reduce((sum, b) => sum + partySizeFromBookingLike(b), 0);
    const remainingSeats = seatingCap - usedSeats;
    if (want > remainingSeats) {
      return {
        ok: false,
        reason: remainingSeats <= 0
          ? 'That time slot is fully booked'
          : `Only ${remainingSeats} seat${remainingSeats === 1 ? '' : 's'} left for that time`,
      };
    }
  }

  // Incomplete listing: neither tables nor seating → one concurrent party.
  if (!hasTables && !hasSeats && overlapping.length >= 1) {
    return { ok: false, reason: 'That time slot is fully booked' };
  }

  return { ok: true };
}

/**
 * In-memory availability check using pre-loaded blocked rows and active bookings.
 * Used by listReservationSlots() to avoid per-slot database round-trips.
 */
export function evaluateAvailability(listing, proposed, { blocked = [], existing = [] } = {}) {
  const { isDateRange, isTimeSlot, isReservation, normalized } = classifyProposedBooking(listing, proposed);

  const blockedResult = evaluateBlockedRows(listing, normalized, blocked, { isDateRange, isTimeSlot, isReservation });
  if (!blockedResult.ok) return blockedResult;

  if (isReservation) {
    return evaluateReservationAvailability(listing, normalized, existing);
  }

  if (isDateRange) {
    // capacity = number of identical units (e.g. rooms in a hotel, copies of an
    // equipment item). Default 1 → a single bookable unit, the old behaviour.
    // Sum the quantity of active bookings whose span overlaps the requested one
    // and make sure the requested quantity still fits.
    //
    // Single-unit verticals (a cottage, a car) are pinned to 1 regardless of the stored
    // value: their host forms wrote a PEOPLE count into this column, which read back as
    // "bookable this many times over". Keyed on the vertical rather than on the migrated
    // value so un-migrated rows are safe too. See utils/booking-capacity.js.
    const cap = isSingleUnitVertical(listing.vertical) ? 1 : (listing.capacity ?? 1);
    const want = normalizeQuantity(normalized.quantity);
    const used = existing
      .filter((b) => {
        let bEnd = b.end_date;
        // Wedding stores inclusive end_date; availability spans are half-open.
        if (listing.vertical === 'wedding') {
          const e = toDateOnly(b.end_date) || toDateOnly(b.start_date);
          if (e) bEnd = addDays(e, 1);
        }
        return dateRangesOverlap(normalized.start_date, normalized.end_date, b.start_date, bEnd);
      })
      .reduce((sum, b) => sum + normalizeQuantity(b.quantity), 0);
    const remaining = cap - used;
    if (want > remaining) {
      return {
        ok: false,
        reason: remaining <= 0
          ? 'Those dates are fully booked'
          : `Only ${remaining} unit${remaining === 1 ? '' : 's'} left for those dates`,
        remaining: Math.max(0, remaining),
      };
    }
    return { ok: true, remaining };
  } else if (isTimeSlot) {
    for (const b of existing) {
      if (b.start_date && normalized.start_date && sameDay(b.start_date, normalized.start_date) &&
          timeSlotsOverlap(normalized.start_time, normalized.end_time, b.start_time, b.end_time)) {
        return { ok: false, reason: 'That time slot is already booked' };
      }
    }
  } else {
    // session / event / async: sum quantities on the proposed date.
    // Single-unit verticals (venue “Max attendees”, etc.) pin capacity to 1 —
    // people counts live in attributes, not concurrent inventory. See booking-capacity.js.
    // Occupancy must use normalizeQuantity (same as demand) — partySizeFromBookingLike
    // is reservation-only and would falsely reject experience/artist/celebrity/décor.
    const cap = isSingleUnitVertical(listing.vertical) ? 1 : (listing.capacity ?? 1);
    const want = normalizeQuantity(normalized.quantity);
    const proposedDay = toDateOnly(normalized.start_date);
    // Appointment-style verticals only conflict on an actual time-window overlap,
    // not mere same-day presence — see APPOINTMENT_STYLE_VERTICALS above.
    const appointmentStyle = APPOINTMENT_STYLE_VERTICALS.has(listing.vertical);
    const proposedStart = normalized.start_time;
    const proposedHasTime = appointmentStyle && proposedStart != null && minutesOfDay(proposedStart) != null;
    const proposedEnd = proposedHasTime
      ? (normalized.end_time && minutesOfDay(normalized.end_time) != null
        ? normalized.end_time
        : addMinutesToTime(proposedStart, appointmentDurationMinutes(listing)))
      : null;
    const used = existing
      .filter((x) => {
        // Wedding bookings may store an inclusive end_date (setup → event). A one-day
        // request must still collide with any day inside that span.
        if (listing.vertical === 'wedding') {
          const s = toDateOnly(x.start_date);
          const e = toDateOnly(x.end_date) || s;
          if (proposedDay && s && e) {
            return proposedDay.getTime() >= s.getTime() && proposedDay.getTime() <= e.getTime();
          }
        }
        if (!sameDay(x.start_date, normalized.start_date)) return false;
        // Both sides need a real time to check overlap instead of blocking the
        // whole day; a legacy booking with no stored time still occupies the day.
        if (proposedHasTime && x.start_time && minutesOfDay(x.start_time) != null) {
          const existingEnd = x.end_time && minutesOfDay(x.end_time) != null
            ? x.end_time
            : addMinutesToTime(x.start_time, appointmentDurationMinutes(listing));
          return timeSlotsOverlap(proposedStart, proposedEnd, x.start_time, existingEnd);
        }
        return true;
      })
      .reduce((sum, x) => sum + normalizeQuantity(x.quantity), 0);
    const remaining = cap - used;
    if (want > remaining) {
      return {
        ok: false,
        reason: remaining <= 0
          ? 'This session is fully booked'
          : `Only ${remaining} spot${remaining === 1 ? '' : 's'} left`,
        remaining: Math.max(0, remaining),
      };
    }
    return { ok: true, remaining };
  }

  return { ok: true };
}

/** Load blocked rows and active bookings for a reservation date (2 queries). */
export async function loadReservationDayContext(db, listing, date) {
  const dateOnly = toDateOnly(date);
  // Use a half-open day range instead of exact equality so timezone/Date coercion
  // differences cannot make the slot grid disagree with booking validation.
  const dayStart = dateOnly;
  const dayEnd = dateOnly ? addDays(dateOnly, 1) : null;
  const dateFilter = dayStart && dayEnd
    ? { gte: dayStart, lt: dayEnd }
    : dateOnly;
  const [blocked, existing] = await Promise.all([
    db.availability.findMany({
      where: {
        booking_listing_id: listing.booking_listing_id,
        is_blocked: true,
        date: dateFilter,
      },
    }),
    db.booking.findMany({
      where: {
        booking_listing_id: listing.booking_listing_id,
        status: { in: ACTIVE_BOOKING_STATUSES },
        start_date: dateFilter,
      },
    }),
  ]);
  return { blocked, existing };
}

// Does a proposed booking conflict with an existing active booking, OR with a
// host-blocked availability row? Pass a Prisma client OR an open transaction.
// Optional 4th arg { blocked, existing } skips DB reads (for batched slot grids).
// Returns { ok: true } or { ok: false, reason }.
export async function checkAvailability(db, listing, proposed, preloaded) {
  const blocked = preloaded?.blocked ?? await db.availability.findMany({
    where: { booking_listing_id: listing.booking_listing_id, is_blocked: true },
  });
  const existing = preloaded?.existing ?? await db.booking.findMany({
    where: {
      booking_listing_id: listing.booking_listing_id,
      status: { in: ACTIVE_BOOKING_STATUSES },
    },
  });
  return evaluateAvailability(listing, proposed, { blocked, existing });
}

/** Default lunch + dinner grids (match Reservations.jsx). */
export const DEFAULT_RESERVATION_LUNCH_SLOTS = [
  '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30',
];
export const DEFAULT_RESERVATION_DINNER_SLOTS = [
  '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00',
];

export function formatReservationSlotLabel(hhmm) {
  const mins = minutesOfDay(hhmm);
  if (mins == null) return hhmm;
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const ap = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

/**
 * Candidate HH:MM slots for a reservation listing (from attributes.time_slots
 * or the default lunch/dinner grid).
 */
export function candidateReservationSlots(listing) {
  const attrs = listing?.attributes && typeof listing.attributes === 'object' ? listing.attributes : {};
  const custom = attrs.time_slots;
  if (Array.isArray(custom) && custom.length) {
    const out = [];
    for (const raw of custom) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      // Accept already-24h or convert common 12h labels.
      if (minutesOfDay(trimmed) != null) {
        out.push(trimmed);
        continue;
      }
      const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(trimmed);
      if (!m) continue;
      let h = parseInt(m[1], 10);
      const min = m[2];
      const ap = m[3].toUpperCase();
      if (ap === 'PM' && h !== 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      out.push(`${String(h).padStart(2, '0')}:${min}`);
    }
    if (out.length) return out;
  }
  return [...DEFAULT_RESERVATION_LUNCH_SLOTS, ...DEFAULT_RESERVATION_DINNER_SLOTS];
}

/**
 * Build the OpenTable-style slot grid for a listing on a date + party size.
 * Returns { slots: [{ time, label, available, reason? }], available, unavailable }.
 */
export async function listReservationSlots(db, listing, { date, party_size } = {}) {
  const party = normalizeQuantity(party_size);
  const candidates = candidateReservationSlots(listing);
  const slots = [];
  const available = [];
  const unavailable = [];

  // Two queries for the whole day; each candidate slot is evaluated in memory.
  const dayContext = await loadReservationDayContext(db, listing, date);

  for (const time of candidates) {
    const end_time = resolveReservationEndTime(time, null, reservationTurnMinutes(listing));
    const avail = evaluateAvailability(listing, {
      start_date: date,
      start_time: time,
      end_time,
      quantity: party,
      guests: party,
    }, dayContext);
    const label = formatReservationSlotLabel(time);
    const row = {
      time,
      label,
      available: avail.ok,
      reason: avail.ok ? null : (avail.reason || 'Unavailable'),
    };
    slots.push(row);
    if (avail.ok) available.push(label);
    else unavailable.push(label);
  }

  return { slots, available, unavailable, party_size: party, date };
}

/**
 * Count how many active bookings were *placed* today per listing (OpenTable-style
 * "Booked N times today" social proof). Uses created_at (not start_date) so a
 * reservation made today for tomorrow still counts. Excludes cancelled/declined.
 *
 * @param {import('@prisma/client').PrismaClient} db
 * @param {number[]} listingIds
 * @returns {Promise<Map<number, number>>}
 */
export async function countBookingsPlacedToday(db, listingIds) {
  const ids = [...new Set((listingIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const counts = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return counts;

  // "Today" in the business timezone (not raw UTC) so the count flips at local
  // midnight for the reservation region instead of mid-afternoon. DST-aware.
  const { start: dayStart, end: dayEnd } = dayRangeInTimeZone(new Date());

  const rows = await db.booking.groupBy({
    by: ['booking_listing_id'],
    where: {
      booking_listing_id: { in: ids },
      status: { in: ACTIVE_BOOKING_STATUSES },
      created_at: { gte: dayStart, lt: dayEnd },
    },
    _count: { _all: true },
  });

  for (const row of rows) {
    counts.set(row.booking_listing_id, row._count._all);
  }
  return counts;
}

/**
 * Merge computed booked_today into listing.attributes (does not persist).
 * Only applied for vertical=reservation; other verticals unchanged.
 */
export function withBookedToday(listing, count) {
  if (!listing || listing.vertical !== 'reservation') return listing;
  const n = Number(count) || 0;
  const attrs = listing.attributes && typeof listing.attributes === 'object' && !Array.isArray(listing.attributes)
    ? { ...listing.attributes }
    : {};
  attrs.booked_today = n;
  return { ...listing, attributes: attrs };
}

/**
 * Enrich a list of listings with attributes.booked_today for reservation verticals.
 */
export async function attachBookedTodayToListings(db, listings) {
  if (!Array.isArray(listings) || listings.length === 0) return listings || [];
  const reservationIds = listings
    .filter((l) => l?.vertical === 'reservation')
    .map((l) => l.booking_listing_id);
  if (!reservationIds.length) return listings;
  const counts = await countBookingsPlacedToday(db, reservationIds);
  return listings.map((l) => withBookedToday(l, counts.get(l.booking_listing_id) || 0));
}

function addDays(date, n) {
  const d = toDateOnly(date);
  return new Date(d.getTime() + n * MS_PER_DAY);
}
function sameDay(a, b) {
  const x = toDateOnly(a), y = toDateOnly(b);
  return Boolean(x && y && x.getTime() === y.getTime());
}

export { toDateOnly, addDays, sameDay };

/** Enumerate each night in [start, end). */
export function eachNight(startDate, endDate) {
  const nights = [];
  let cur = toDateOnly(startDate);
  const end = toDateOnly(endDate);
  if (!cur || !end) return nights;
  while (cur.getTime() < end.getTime()) {
    nights.push(new Date(cur));
    cur = new Date(cur.getTime() + MS_PER_DAY);
  }
  return nights;
}

/**
 * Hotel room-type availability + pricing across a stay.
 * Returns { ok, reason?, unitPrice, nights, remaining }
 * @param {{ start_date, end_date, quantity?: number, exclude_booking_id?: number }} proposed
 */
export async function checkHotelRoomAvailability(db, roomType, proposed) {
  const nights = eachNight(proposed.start_date, proposed.end_date);
  if (!nights.length) return { ok: false, reason: 'end_date must be after start_date' };

  const want = normalizeQuantity(proposed.quantity);
  const inventory = await db.hotel_room_inventory.findMany({
    where: {
      room_type_id: roomType.room_type_id,
      date: { gte: nights[0], lt: addDays(nights[nights.length - 1], 1) },
    },
  });
  const byDate = new Map(inventory.map((row) => [toDateOnly(row.date).getTime(), row]));

  const excludeId = proposed.exclude_booking_id != null ? Number(proposed.exclude_booking_id) : null;
  const existing = await db.booking.findMany({
    where: {
      room_type_id: roomType.room_type_id,
      status: { in: ACTIVE_BOOKING_STATUSES },
      ...(Number.isFinite(excludeId) ? { NOT: { booking_id: excludeId } } : {}),
    },
  });

  let minRemaining = roomType.quantity ?? 1;
  let priceSum = 0;

  for (const night of nights) {
    const key = night.getTime();
    const row = byDate.get(key);
    if (row?.is_blocked) {
      return { ok: false, reason: 'Host has blocked one or more of the selected dates' };
    }
    const nightCap = row?.available != null ? row.available : (roomType.quantity ?? 1);
    const used = existing
      .filter((b) => dateRangesOverlap(proposed.start_date, proposed.end_date, b.start_date, b.end_date)
        && dateRangesOverlap(night, addDays(night, 1), b.start_date, b.end_date))
      .reduce((sum, b) => sum + normalizeQuantity(b.quantity), 0);
    const remaining = nightCap - used;
    if (want > remaining) {
      return {
        ok: false,
        reason: remaining <= 0
          ? 'Those dates are fully booked for this room type'
          : `Only ${remaining} room${remaining === 1 ? '' : 's'} left for those dates`,
      };
    }
    minRemaining = Math.min(minRemaining, remaining);
    priceSum += Number(row?.price_override ?? roomType.nightly_price ?? 0);
  }

  const unitPrice = nights.length ? priceSum / nights.length : Number(roomType.nightly_price ?? 0);
  return { ok: true, unitPrice, nights: nights.length, remaining: minRemaining };
}

/**
 * Nights (YYYY-MM-DD) where a hotel room type has no remaining inventory.
 * Used by GET /listings/:id/availability?room_type_id= so guest calendars grey out
 * only truly sold-out nights (quantity-aware), not every overlapping booking.
 */
export function soldOutNightsForRoomType(roomType, bookings = [], inventoryRows = []) {
  const qtyCap = Math.max(1, Number(roomType?.quantity) || 1);
  const byDateInv = new Map(
    (inventoryRows || []).map((row) => [toDateOnly(row.date)?.getTime(), row]),
  );
  const nightUsage = new Map(); // epochMs -> used units

  for (const b of bookings || []) {
    const units = normalizeQuantity(b.quantity);
    for (const night of eachNight(b.start_date, b.end_date)) {
      const key = night.getTime();
      nightUsage.set(key, (nightUsage.get(key) || 0) + units);
    }
  }

  const soldOut = [];
  const toYmd = (d) => {
    const x = toDateOnly(d);
    if (!x) return null;
    return x.toISOString().slice(0, 10);
  };
  for (const [key, used] of nightUsage.entries()) {
    const row = byDateInv.get(key);
    if (row?.is_blocked) {
      soldOut.push(toYmd(new Date(key)));
      continue;
    }
    const nightCap = row?.available != null ? Number(row.available) : qtyCap;
    if (used >= nightCap) soldOut.push(toYmd(new Date(key)));
  }
  return soldOut.filter(Boolean).sort();
}

const HOST_VISIBLE_PAYMENT = new Set(['paid', 'refunded']);

export function bookingRequiresPayment(booking) {
  const total = Number(booking?.total ?? 0);
  return Number.isFinite(total) && total > 0;
}

/** Card checkout stamps payment_method=card; an intent id means Stripe already started. */
export function isPrepaidCardStay(booking) {
  const method = String(booking?.payment_method ?? '').toLowerCase();
  if (method === 'card') return true;
  return Boolean(booking?.payment_intent_id);
}

export function isHostVisibleBooking(booking) {
  if (!booking) return false;
  if (!isPrepaidCardStay(booking) || !bookingRequiresPayment(booking)) return true;
  return HOST_VISIBLE_PAYMENT.has(String(booking.payment_status || '').toLowerCase());
}

export function filterHostVisibleBookings(rows) {
  return (Array.isArray(rows) ? rows : []).filter(isHostVisibleBooking);
}

/** Accept / check-in require paid when the stay is a prepaid card hold. */
export function hostCanActOnPaidStay(booking) {
  if (!booking) return false;
  if (!isPrepaidCardStay(booking) || !bookingRequiresPayment(booking)) return true;
  return String(booking.payment_status || '').toLowerCase() === 'paid';
}

export function shouldNotifyHostOfNewBooking(booking) {
  return isHostVisibleBooking(booking);
}

export function shouldNotifyCounterpartyOfCancel(booking, wasPaid) {
  if (wasPaid) return true;
  return !isPrepaidCardStay(booking);
}
