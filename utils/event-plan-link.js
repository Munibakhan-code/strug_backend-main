// Shared Event (v1): attach a paid order (venue booking or catering/floral food_order)
// to the matching event_plan need, flip it to "booked", and back-fill empty plan
// date/guests/city from a venue booking. Extracted so both the Shared Event checkout
// (POST /event-concierge/plans/:id/link-order) and the wedding-booking bridge can reuse it.

function money(n) {
  return Math.round((parseFloat(n ?? 0) + Number.EPSILON) * 100) / 100;
}

/** date-only string -> noon UTC Date (matches parseEventDate in the routes file). */
function parseEventDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T12:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// category on the need row -> the nav a re-book CTA should open, and the aliases that
// still count as "the same piece" when we look for an existing seeded need.
const CATEGORY_META = {
  venue: { nav: 'venues', aliases: ['venue'] },
  catering: { nav: 'catering', aliases: ['catering', 'cake', 'food'] },
  floral: { nav: 'floral', aliases: ['floral', 'flowers'] },
};

export function normalizeShareCategory(raw) {
  const c = String(raw || '').toLowerCase();
  if (c === 'flowers') return 'floral';
  if (c === 'venues') return 'venue';
  return c;
}

/** Pick the seeded need for a Shared Event piece (venue/catering/floral), or null. */
export function pickNeedForCategory(needs, category) {
  const cat = normalizeShareCategory(category);
  const meta = CATEGORY_META[cat];
  const aliases = new Set([cat, ...(meta?.aliases || [])]);
  const nav = meta?.nav;
  return (
    needs.find((n) => aliases.has(String(n.category || '').toLowerCase()))
    || (nav ? needs.find((n) => String(n.linked_nav || '').toLowerCase() === nav) : null)
    || null
  );
}

/**
 * @param {object} args
 * @param {import('@prisma/client').PrismaClient} args.db  prisma client or tx
 * @param {number} args.planId
 * @param {number} args.ownerId       user making the request (must own the order)
 * @param {'venue'|'catering'|'floral'} args.category
 * @param {'booking'|'food_order'} args.kind
 * @param {number} args.refId         booking_id or food_order_id
 * @returns {Promise<{ ok: true, need } | { ok: false, status: number, error: string }>}
 */
export async function linkOrderToPlan({ db, planId, ownerId, category, kind, refId }) {
  const cat = normalizeShareCategory(category);
  if (!CATEGORY_META[cat]) return { ok: false, status: 400, error: 'Unknown event category' };
  if (kind !== 'booking' && kind !== 'food_order') {
    return { ok: false, status: 400, error: 'kind must be booking or food_order' };
  }
  const ref = parseInt(refId, 10);
  if (!Number.isFinite(ref) || ref <= 0) return { ok: false, status: 400, error: 'Invalid ref_id' };

  const plan = await db.event_plan.findUnique({
    where: { event_plan_id: planId },
    select: { event_plan_id: true, event_date: true, guests: true, city: true },
  });
  if (!plan) return { ok: false, status: 404, error: 'Event not found' };

  // ── Load + authorize the order ────────────────────────────────────────────
  let orderTotal = null;
  let listingId = null;
  let listingTitle = null;
  let bookingId = null;
  const planPatch = {};

  if (kind === 'booking') {
    const booking = await db.booking.findUnique({
      where: { booking_id: ref },
      select: {
        booking_id: true, guest_id: true, total: true, guests: true, start_date: true,
        status: true, booking_listing_id: true,
        booking_listing: { select: { title: true } },
      },
    });
    if (!booking) return { ok: false, status: 404, error: 'Booking not found' };
    if (booking.guest_id !== ownerId) return { ok: false, status: 403, error: 'Booking does not belong to you' };
    orderTotal = booking.total;
    bookingId = booking.booking_id;
    listingId = booking.booking_listing_id ?? null;
    listingTitle = booking.booking_listing?.title ?? null;
    // Back-fill the plan from a venue booking when the host never set these.
    // (city isn't taken from the listing — booking_listing.location is a free-text
    // address, and the Shared Event checkout sets plan.city explicitly before paying.)
    if (!plan.event_date && booking.start_date) {
      planPatch.event_date = parseEventDate(booking.start_date.toISOString().slice(0, 10));
    }
    if (plan.guests == null && booking.guests != null) {
      const g = parseInt(booking.guests, 10);
      if (Number.isFinite(g)) planPatch.guests = g;
    }
  } else {
    const order = await db.food_order.findUnique({
      where: { food_order_id: ref },
      select: { food_order_id: true, user_id: true, total_amount: true, vendor_id: true },
    });
    if (!order) return { ok: false, status: 404, error: 'Order not found' };
    if (order.user_id !== ownerId) return { ok: false, status: 403, error: 'Order does not belong to you' };
    orderTotal = order.total_amount;
    const vendor = order.vendor_id
      ? await db.food_vendor.findUnique({
        where: { vendor_id: order.vendor_id },
        select: { vendor_name: true },
      })
      : null;
    listingTitle = vendor?.vendor_name ?? null;
  }

  // ── Find or create the matching need ──────────────────────────────────────
  const needs = await db.event_need.findMany({
    where: { event_plan_id: planId },
    orderBy: { sort_order: 'asc' },
  });
  let need = pickNeedForCategory(needs, cat);

  const linkData = {
    linked_order_id: ref,
    linked_order_kind: kind,
    status: 'booked',
    ...(bookingId != null ? { booking_id: bookingId } : {}),
    ...(listingId != null ? { linked_listing_id: listingId } : {}),
    ...(listingTitle ? { linked_listing_title: String(listingTitle).slice(0, 300) } : {}),
    linked_nav: CATEGORY_META[cat].nav,
  };
  if (orderTotal != null && Number.isFinite(Number(orderTotal))) {
    linkData.target_budget = money(orderTotal);
  }

  if (need) {
    need = await db.event_need.update({
      where: { event_need_id: need.event_need_id },
      data: linkData,
    });
  } else {
    const maxSort = await db.event_need.aggregate({
      where: { event_plan_id: planId },
      _max: { sort_order: true },
    });
    const titleByCat = { venue: 'Venue', catering: 'Catering', floral: 'Floral' };
    need = await db.event_need.create({
      data: {
        event_plan_id: planId,
        category: cat,
        title: titleByCat[cat],
        sort_order: (maxSort._max.sort_order ?? -1) + 1,
        ...linkData,
      },
    });
  }

  if (Object.keys(planPatch).length) {
    await db.event_plan.update({ where: { event_plan_id: planId }, data: planPatch });
  }

  return { ok: true, need };
}

/**
 * Resolve a need's live status for the customer-facing timeline.
 * @returns {'booked'|'pending'|'unpaid'|'cancelled'|'unlinked'}
 */
export function resolveTimelineStatus({ kind, booking, foodOrder }) {
  if (kind === 'booking' && booking) {
    const st = String(booking.status || '').toLowerCase();
    const pay = String(booking.payment_status || '').toLowerCase();
    if (st === 'cancelled' || st === 'declined') return 'cancelled';
    const needsPay = Number(booking.total ?? 0) > 0;
    if (needsPay && pay !== 'paid' && pay !== 'refunded' && !booking.payment_intent_id) return 'unpaid';
    if (st === 'requested' || st === 'awaiting_host') return 'pending';
    return 'booked';
  }
  if (kind === 'food_order' && foodOrder) {
    const st = String(foodOrder.order_status || '').toLowerCase();
    if (st === 'cancelled' || st === 'rejected' || st === 'declined') return 'cancelled';
    const needsPay = Number(foodOrder.total_amount ?? 0) > 0;
    if (needsPay && foodOrder.ispaid !== true && !foodOrder.payment_intent_id) return 'unpaid';
    if (st === 'pending' || st === '' || st == null) return 'pending';
    return 'booked';
  }
  return 'unlinked';
}
