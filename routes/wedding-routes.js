import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { notify } from '../services/notify.js';

const router = express.Router();

/** Present after `prisma generate` against schema with wedding_try_on; null on older clients. */
function weddingTryOnDelegate() {
  return prisma.wedding_try_on ?? null;
}

const WEDDING_PRODUCT_WHERE = {
  seller_id: { not: null },
  product_type: {
    product_type_name: { equals: 'Wedding', mode: 'insensitive' },
  },
};

/** Lenient "today" for try-on: allow yesterday UTC so client/server TZ edges near midnight don't false-reject. */
function minAllowedTryOnDateISO() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function recomputeVendorListingRating(bookingListingId) {
  if (!bookingListingId) return;
  const id = Number(bookingListingId);
  if (!Number.isFinite(id)) return;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(4243, ${id}::int4)`;
    // Prefer canonical booking_review rows (shared with booking engine); fall back to guest_rating events.
    const reviewAgg = await tx.booking_review.aggregate({
      where: { booking_listing_id: id },
      _avg: { rating: true },
      _count: { _all: true },
    });
    const listing = await tx.booking_listing.findUnique({
      where: { booking_listing_id: id },
      select: { attributes: true },
    });
    const attrs = listing?.attributes && typeof listing.attributes === 'object' && !Array.isArray(listing.attributes)
      ? { ...listing.attributes }
      : {};
    let avg_rating = 0;
    let review_count = 0;

    if ((reviewAgg._count._all || 0) > 0) {
      review_count = reviewAgg._count._all;
      avg_rating = reviewAgg._avg.rating != null
        ? Math.round(reviewAgg._avg.rating * 100) / 100
        : 0;
      attrs.rating = avg_rating;
      attrs.reviews = review_count;
      attrs.review_count = review_count;
    } else {
      const events = await tx.booking_event.findMany({
        where: {
          event_type: 'guest_rating',
          booking: { booking_listing_id: id, vertical: 'wedding' },
        },
        select: { metadata: true },
      });
      const scores = events
        .map((e) => Number(e.metadata && typeof e.metadata === 'object' ? e.metadata.rating : NaN))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
      if (scores.length === 0) {
        delete attrs.rating;
        delete attrs.reviews;
        delete attrs.review_count;
      } else {
        review_count = scores.length;
        avg_rating = Math.round((scores.reduce((s, n) => s + n, 0) / scores.length) * 100) / 100;
        attrs.rating = avg_rating;
        attrs.reviews = review_count;
        attrs.review_count = review_count;
      }
    }
    // Keep listing columns and attributes in sync (fixes dual rating surfaces).
    await tx.booking_listing.update({
      where: { booking_listing_id: id },
      data: { attributes: attrs, avg_rating, review_count },
    });
  });
}

function mapTryOnTableRow(row, buyerNameById = new Map()) {
  return {
    try_on_id: row.try_on_id,
    // Seller dashboard PATCH still uses notification_id — keep alias for compatibility.
    notification_id: row.seller_notification_id ?? row.try_on_id,
    listing_id: row.listing_id,
    product_name: row.product_name || null,
    buyer_id: row.buyer_id ?? null,
    buyer_name: buyerNameById.get(row.buyer_id) || null,
    preferred_date: row.preferred_date
      ? String(row.preferred_date).slice(0, 10)
      : null,
    status: row.status || 'pending',
    created_at: row.created_at,
    is_read: true,
    seller_id: row.seller_id ?? null,
  };
}

/* GET WEDDING VENDORS — deprecated; use shared booking listings */
router.get('/vendors', (_req, res) => {
  res.status(410).json({
    error: 'Deprecated. Use GET /booking/listings?vertical=wedding instead.',
  });
});

/* GET WEDDING VENDOR BY ID — deprecated */
router.get('/vendors/:id', (_req, res) => {
  res.status(410).json({
    error: 'Deprecated. Use GET /booking/listings/:id instead.',
  });
});

/* POST BOOK A WEDDING VENDOR — use the shared booking engine */
router.post('/vendor-bookings', authenticateToken, (_req, res) => {
  res.status(410).json({
    error: 'Deprecated. Create wedding vendor bookings via POST /booking/bookings with a wedding listing id.',
  });
});

/* GET WEDDING SHOP PRODUCTS — hide zero-stock when availability is set */
router.get('/products', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const where = {
      ...WEDDING_PRODUCT_WHERE,
      OR: [
        { availability: null },
        { availability: { gt: 0 } },
      ],
    };
    const [products, total] = await Promise.all([
      prisma.product_listing.findMany({
        where,
        orderBy: { listing_id: 'desc' },
        take: limit,
        skip: offset,
        include: {
          product_type: true,
          product_variation: true,
          seller: {
            select: {
              user_id: true,
              name: true,
              username: true,
              storeProfile: true,
            },
          },
        },
      }),
      prisma.product_listing.count({ where }),
    ]);
    res.json({ data: products, total, limit, offset });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch wedding products' });
  }
});

/* GET WEDDING PRODUCT BY ID — must be Wedding type */
router.get('/products/:id', async (req, res) => {
  try {
    const listing_id = Number(req.params.id);
    if (Number.isNaN(listing_id)) return res.status(400).json({ error: 'id must be a number' });
    const product = await prisma.product_listing.findFirst({
      where: { listing_id, ...WEDDING_PRODUCT_WHERE },
      include: { product_type: true, product_variation: true },
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

/* POST WEDDING SHOP ORDER — deprecated; use main product-order */
router.post('/orders', authenticateToken, (_req, res) => {
  res.status(410).json({
    error: 'Deprecated. Place wedding shop orders via the shared product-order checkout flow.',
  });
});

/* GET WEDDING ATTIRE — deprecated (unused by SPA; was empty without bridal cloth categories) */
router.get('/attire', (_req, res) => {
  res.status(410).json({
    error: 'Deprecated. Browse wedding shop products via GET /wedding/products instead.',
  });
});

function mapTryOnRow(n) {
  const d = n.data && typeof n.data === 'object' ? n.data : {};
  return {
    notification_id: n.notification_id,
    listing_id: d.listing_id ?? n.entity_id,
    product_name: d.product_name || null,
    buyer_id: d.buyer_id ?? null,
    buyer_name: d.buyer_name || null,
    preferred_date: d.preferred_date || null,
    status: d.status || 'pending',
    created_at: n.created_at,
    is_read: n.is_read,
    seller_id: d.seller_id ?? null,
  };
}

/* POST TRY-ON REQUEST — persist in wedding_try_on + notify seller/buyer */
router.post('/try-on', authenticateToken, async (req, res) => {
  try {
    const listing_id = Number(req.body.listing_id);
    const preferred_date = req.body.preferred_date ? String(req.body.preferred_date).slice(0, 10) : null;
    if (!Number.isFinite(listing_id)) {
      return res.status(400).json({ error: 'listing_id is required' });
    }
    if (!preferred_date || !/^\d{4}-\d{2}-\d{2}$/.test(preferred_date)) {
      return res.status(400).json({ error: 'preferred_date is required (YYYY-MM-DD)' });
    }
    if (preferred_date < minAllowedTryOnDateISO()) {
      return res.status(400).json({ error: 'preferred_date cannot be in the past' });
    }

    const product = await prisma.product_listing.findFirst({
      where: { listing_id, ...WEDDING_PRODUCT_WHERE },
      select: {
        listing_id: true,
        name: true,
        seller_id: true,
      },
    });
    if (!product?.seller_id) return res.status(404).json({ error: 'Wedding product not found' });
    if (product.seller_id === req.user.user_id) {
      return res.status(400).json({ error: 'You cannot request a try-on for your own listing' });
    }

    const preferredDateObj = new Date(`${preferred_date}T12:00:00.000Z`);
    const tryOnDb = weddingTryOnDelegate();

    // Cooldown: prefer first-class table; also check legacy notifications.
    if (tryOnDb) {
      const tableDup = await tryOnDb.findFirst({
        where: {
          listing_id,
          buyer_id: req.user.user_id,
          preferred_date: preferredDateObj,
          status: 'pending',
          created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });
      if (tableDup) {
        return res.status(409).json({ error: 'You already requested a try-on for this date' });
      }
    }

    const recent = await prisma.notification.findMany({
      where: {
        user_id: product.seller_id,
        type: 'wedding.try_on',
        entity_type: 'product_listing',
        entity_id: listing_id,
        created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      take: 200,
      orderBy: { created_at: 'desc' },
    });
    const dup = recent.find((n) => {
      const d = n.data && typeof n.data === 'object' ? n.data : {};
      return (
        Number(d.buyer_id) === req.user.user_id
        && String(d.preferred_date).slice(0, 10) === preferred_date
        && (d.status == null || d.status === 'pending')
      );
    });
    if (dup) {
      return res.status(409).json({ error: 'You already requested a try-on for this date' });
    }

    const productName = product.name || `Listing #${listing_id}`;
    const io = req.app.get('io');
    const tryOnData = {
      listing_id,
      product_name: productName,
      buyer_id: req.user.user_id,
      buyer_name: req.user.name || null,
      preferred_date,
      status: 'pending',
      seller_id: product.seller_id,
    };
    const sellerNotif = await notify(io, {
      userId: product.seller_id,
      vertical: 'ecommerce',
      type: 'wedding.try_on',
      title: 'Wedding try-on request',
      body: `${req.user.name || 'A customer'} requested a try-on for "${productName}" on ${preferred_date}.`,
      urgency: 'actionable',
      entityType: 'product_listing',
      entityId: listing_id,
      actionUrl: 'sd-wedding',
      data: tryOnData,
    });

    const buyerNotif = await notify(io, {
      userId: req.user.user_id,
      vertical: 'ecommerce',
      type: 'wedding.try_on_mine',
      title: 'Try-on request sent',
      body: `You requested a try-on for "${productName}" on ${preferred_date}.`,
      urgency: 'ambient',
      entityType: 'product_listing',
      entityId: listing_id,
      actionUrl: 'wedding',
      data: {
        ...tryOnData,
        seller_notification_id: sellerNotif?.notification_id ?? null,
      },
      push: false,
    });

    let persisted = null;
    if (tryOnDb) {
      try {
        persisted = await tryOnDb.create({
          data: {
            listing_id,
            seller_id: product.seller_id,
            buyer_id: req.user.user_id,
            product_name: productName,
            preferred_date: preferredDateObj,
            status: 'pending',
            seller_notification_id: sellerNotif?.notification_id ?? null,
            buyer_notification_id: buyerNotif?.notification_id ?? null,
          },
        });
      } catch (persistErr) {
        console.error('[wedding] try-on table persist failed; notifications still sent', persistErr?.message);
      }
    }

    // Stamp try_on_id onto seller notification payload for PATCH lookup by table id.
    if (sellerNotif?.notification_id && persisted?.try_on_id) {
      try {
        await prisma.notification.update({
          where: { notification_id: sellerNotif.notification_id },
          data: { data: { ...tryOnData, try_on_id: persisted.try_on_id } },
        });
      } catch { /* best-effort */ }
    }

    res.status(201).json({
      ok: true,
      listing_id,
      preferred_date,
      seller_id: product.seller_id,
      try_on_id: persisted?.try_on_id ?? null,
      notification_id: sellerNotif?.notification_id ?? null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to request try-on' });
  }
});

/* GET TRY-ON REQUESTS — seller inbox (table first, legacy notifications as fallback) */
router.get('/try-ons', authenticateToken, async (req, res) => {
  try {
    const tryOnDb = weddingTryOnDelegate();
    let fromTable = [];
    const knownSellerNotifIds = new Set();
    if (tryOnDb) {
      try {
        const tableRows = await tryOnDb.findMany({
          where: { seller_id: req.user.user_id },
          orderBy: { created_at: 'desc' },
          take: 200,
        });
        const buyerIds = [...new Set(tableRows.map((r) => r.buyer_id).filter((id) => Number.isFinite(id) && id > 0))];
        const buyers = buyerIds.length
          ? await prisma.user.findMany({
            where: { user_id: { in: buyerIds } },
            select: { user_id: true, name: true },
          })
          : [];
        const buyerNameById = new Map(buyers.map((u) => [u.user_id, u.name || null]));
        fromTable = tableRows.map((row) => mapTryOnTableRow(row, buyerNameById));
        for (const r of tableRows) {
          if (Number.isFinite(r.seller_notification_id) && r.seller_notification_id > 0) {
            knownSellerNotifIds.add(r.seller_notification_id);
          }
        }
      } catch (tableErr) {
        console.error('[wedding] try-on table read failed; using notifications', tableErr?.message);
      }
    }

    const notifRows = await prisma.notification.findMany({
      where: {
        user_id: req.user.user_id,
        type: 'wedding.try_on',
      },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    const legacy = notifRows
      .filter((n) => !knownSellerNotifIds.has(n.notification_id))
      .map(mapTryOnRow);

    res.json([...fromTable, ...legacy].slice(0, 200));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load try-on requests' });
  }
});

/* GET MY TRY-ONS — buyer status list */
router.get('/my-try-ons', authenticateToken, async (req, res) => {
  try {
    const tryOnDb = weddingTryOnDelegate();
    if (tryOnDb) {
      try {
        const tableRows = await tryOnDb.findMany({
          where: { buyer_id: req.user.user_id },
          orderBy: { created_at: 'desc' },
          take: 100,
        });
        if (tableRows.length > 0) {
          return res.json(tableRows.map((row) => ({
            try_on_id: row.try_on_id,
            notification_id: row.buyer_notification_id ?? row.try_on_id,
            listing_id: row.listing_id,
            product_name: row.product_name || null,
            preferred_date: row.preferred_date ? String(row.preferred_date).slice(0, 10) : null,
            status: row.status || 'pending',
            created_at: row.created_at,
            seller_id: row.seller_id ?? null,
          })));
        }
      } catch (tableErr) {
        console.error('[wedding] my-try-ons table read failed; using notifications', tableErr?.message);
      }
    }

    // Legacy fallback when no table rows exist yet.
    const mine = await prisma.notification.findMany({
      where: {
        user_id: req.user.user_id,
        type: { in: ['wedding.try_on_mine', 'wedding.try_on_response'] },
      },
      orderBy: { created_at: 'desc' },
      take: 100,
    });

    const sellerIds = mine
      .map((n) => {
        const d = n.data && typeof n.data === 'object' ? n.data : {};
        return Number(d.seller_notification_id);
      })
      .filter((id) => Number.isFinite(id) && id > 0);

    const sellerRows = sellerIds.length
      ? await prisma.notification.findMany({
        where: { notification_id: { in: sellerIds }, type: 'wedding.try_on' },
      })
      : [];
    const sellerById = new Map(sellerRows.map((r) => [r.notification_id, r]));

    const seen = new Set();
    const out = [];
    for (const n of mine) {
      const d = n.data && typeof n.data === 'object' ? n.data : {};
      const key = `${d.listing_id}|${d.preferred_date}|${d.seller_notification_id || n.notification_id}`;
      if (seen.has(key) && n.type === 'wedding.try_on_response') continue;
      seen.add(key);
      const sellerRow = d.seller_notification_id ? sellerById.get(Number(d.seller_notification_id)) : null;
      const sellerData = sellerRow?.data && typeof sellerRow.data === 'object' ? sellerRow.data : {};
      const status = sellerData.status || d.status || (n.type === 'wedding.try_on_response' ? d.status : 'pending') || 'pending';
      out.push({
        notification_id: n.notification_id,
        listing_id: d.listing_id ?? n.entity_id,
        product_name: d.product_name || null,
        preferred_date: d.preferred_date || null,
        status,
        created_at: n.created_at,
        seller_id: d.seller_id ?? null,
      });
    }
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load your try-on requests' });
  }
});

/* PATCH TRY-ON — seller accept / decline (by notification_id or try_on_id) */
router.patch('/try-ons/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = String(req.body.status || '').toLowerCase();
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'id must be a number' });
    }
    if (!['accepted', 'declined'].includes(status)) {
      return res.status(400).json({ error: 'status must be accepted or declined' });
    }

    const resolvedAt = new Date().toISOString();
    const tryOnDb = weddingTryOnDelegate();

    // Prefer first-class row (matched by try_on_id or seller_notification_id).
    let tableRow = null;
    if (tryOnDb) {
      try {
        tableRow = await tryOnDb.findFirst({
          where: {
            seller_id: req.user.user_id,
            OR: [
              { try_on_id: id },
              { seller_notification_id: id },
            ],
          },
        });
        if (tableRow) {
          if (tableRow.status && tableRow.status !== 'pending') {
            return res.status(409).json({ error: 'This try-on request was already handled' });
          }
          tableRow = await tryOnDb.update({
            where: { try_on_id: tableRow.try_on_id },
            data: { status, resolved_at: new Date(resolvedAt) },
          });
        }
      } catch (tableErr) {
        console.error('[wedding] try-on table patch failed; using notifications', tableErr?.message);
        tableRow = null;
      }
    }

    let notification_id = tableRow?.seller_notification_id ?? null;
    let row = null;
    if (notification_id) {
      row = await prisma.notification.findFirst({
        where: {
          notification_id,
          user_id: req.user.user_id,
          type: 'wedding.try_on',
        },
      });
    }
    if (!row) {
      row = await prisma.notification.findFirst({
        where: {
          notification_id: id,
          user_id: req.user.user_id,
          type: 'wedding.try_on',
        },
      });
      if (row) notification_id = row.notification_id;
    }

    if (!tableRow && !row) {
      return res.status(404).json({ error: 'Try-on request not found' });
    }

    const prev = row?.data && typeof row.data === 'object'
      ? { ...row.data }
      : {
          listing_id: tableRow?.listing_id,
          product_name: tableRow?.product_name,
          preferred_date: tableRow?.preferred_date
            ? String(tableRow.preferred_date).slice(0, 10)
            : null,
          buyer_id: tableRow?.buyer_id,
          seller_id: tableRow?.seller_id,
          status: tableRow?.status || 'pending',
        };

    if (!tableRow && prev.status && prev.status !== 'pending') {
      return res.status(409).json({ error: 'This try-on request was already handled' });
    }

    const nextData = { ...prev, status, resolved_at: resolvedAt, try_on_id: tableRow?.try_on_id ?? prev.try_on_id };
    let updated = row;
    if (row) {
      updated = await prisma.notification.update({
        where: { notification_id: row.notification_id },
        data: { data: nextData, is_read: true },
      });
      notification_id = updated.notification_id;
    }

    const buyerId = Number(prev.buyer_id ?? tableRow?.buyer_id);
    if (Number.isFinite(buyerId) && buyerId > 0) {
      const io = req.app.get('io');
      notify(io, {
        userId: buyerId,
        vertical: 'ecommerce',
        type: 'wedding.try_on_response',
        title: status === 'accepted' ? 'Try-on accepted' : 'Try-on declined',
        body: status === 'accepted'
          ? `Your try-on for "${prev.product_name || 'an item'}" on ${prev.preferred_date} was accepted.`
          : `Your try-on for "${prev.product_name || 'an item'}" on ${prev.preferred_date} was declined.`,
        urgency: 'ambient',
        entityType: 'product_listing',
        entityId: prev.listing_id ?? row?.entity_id ?? tableRow?.listing_id,
        actionUrl: 'wedding',
        data: {
          listing_id: prev.listing_id ?? tableRow?.listing_id,
          product_name: prev.product_name ?? tableRow?.product_name,
          preferred_date: prev.preferred_date,
          status,
          seller_id: req.user.user_id,
          seller_notification_id: notification_id,
          try_on_id: tableRow?.try_on_id ?? null,
        },
      });

      const listingEntityId = prev.listing_id ?? row?.entity_id ?? tableRow?.listing_id;
      const mineRows = await prisma.notification.findMany({
        where: {
          user_id: buyerId,
          type: 'wedding.try_on_mine',
          entity_type: 'product_listing',
          entity_id: listingEntityId,
        },
        take: 20,
        orderBy: { created_at: 'desc' },
      });
      for (const m of mineRows) {
        const md = m.data && typeof m.data === 'object' ? m.data : {};
        if (
          (notification_id && Number(md.seller_notification_id) === notification_id)
          || (tableRow && Number(md.try_on_id) === tableRow.try_on_id)
          || (String(md.preferred_date).slice(0, 10) === String(prev.preferred_date).slice(0, 10)
            && Number(md.listing_id) === Number(prev.listing_id ?? tableRow?.listing_id))
        ) {
          await prisma.notification.update({
            where: { notification_id: m.notification_id },
            data: {
              data: {
                ...md,
                status,
                resolved_at: resolvedAt,
                seller_notification_id: notification_id,
                try_on_id: tableRow?.try_on_id ?? md.try_on_id,
              },
            },
          });
        }
      }
    }

    res.json({
      ok: true,
      notification_id: notification_id ?? id,
      try_on_id: tableRow?.try_on_id ?? null,
      status,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update try-on request' });
  }
});

/* GET RATEABLE BOOKINGS — completed paid wedding bookings the guest hasn't rated */
router.get('/rateable-bookings', authenticateToken, async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: {
        vertical: 'wedding',
        guest_id: req.user.user_id,
        status: 'completed',
        payment_status: 'paid',
      },
      orderBy: { booking_id: 'desc' },
      take: 50,
      include: {
        booking_listing: { select: { booking_listing_id: true, title: true, images: true } },
        booking_event: {
          where: { event_type: 'guest_rating', actor_id: req.user.user_id },
          select: { booking_event_id: true },
        },
      },
    });
    res.json(
      bookings
        .filter((b) => !b.booking_event?.length)
        .map((b) => ({
          booking_id: b.booking_id,
          start_date: b.start_date,
          end_date: b.end_date,
          title: b.booking_listing?.title || `Booking #${b.booking_id}`,
          listing_id: b.booking_listing_id,
        })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load rateable bookings' });
  }
});

const CLOSED_BOOKING_STATUSES = new Set(['cancelled', 'declined']);

/* GET MY WEDDING BOOKINGS — guest history with rateable flag */
router.get('/my-bookings', authenticateToken, async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: {
        vertical: 'wedding',
        guest_id: req.user.user_id,
      },
      orderBy: { booking_id: 'desc' },
      take: 50,
      include: {
        booking_listing: { select: { booking_listing_id: true, title: true } },
        booking_event: {
          where: { event_type: 'guest_rating', actor_id: req.user.user_id },
          select: { booking_event_id: true },
        },
      },
    });
    res.json(bookings.map((b) => {
      const rated = Array.isArray(b.booking_event) && b.booking_event.length > 0;
      const rateable = b.status === 'completed' && b.payment_status === 'paid' && !rated;
      const closed = CLOSED_BOOKING_STATUSES.has(b.status);
      const awaitingHostCompletion =
        !rated
        && !rateable
        && !closed
        && b.payment_status === 'paid'
        && ['confirmed', 'in_progress', 'awaiting_host', 'requested'].includes(b.status);
      return {
        booking_id: b.booking_id,
        status: b.status,
        payment_status: b.payment_status,
        start_date: b.start_date,
        end_date: b.end_date,
        total: b.total,
        title: b.booking_listing?.title || `Booking #${b.booking_id}`,
        listing_id: b.booking_listing_id,
        rated,
        rateable,
        closed,
        awaiting_host_completion: awaitingHostCompletion,
      };
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load wedding bookings' });
  }
});

/* POST VENDOR RATING — guest rates a completed/paid wedding booking */
router.post('/vendor-ratings', authenticateToken, async (req, res) => {
  try {
    const booking_id = Number(req.body.booking_id);
    const rating = Number(req.body.rating);
    const comment = req.body.comment != null ? String(req.body.comment).slice(0, 2000) : null;

    if (!Number.isFinite(booking_id)) {
      return res.status(400).json({ error: 'booking_id is required' });
    }
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be 1–5' });
    }

    const booking = await prisma.booking.findFirst({
      where: {
        booking_id,
        vertical: 'wedding',
        guest_id: req.user.user_id,
        status: 'completed',
        payment_status: 'paid',
      },
    });
    if (!booking) {
      return res.status(404).json({ error: 'Completed paid wedding booking not found' });
    }

    const existing = await prisma.booking_event.findFirst({
      where: {
        booking_id,
        event_type: 'guest_rating',
        actor_id: req.user.user_id,
      },
    });
    if (existing) {
      return res.status(409).json({ error: 'You already rated this booking' });
    }

    const event = await prisma.booking_event.create({
      data: {
        booking_id,
        event_type: 'guest_rating',
        actor_id: req.user.user_id,
        metadata: { rating: Math.round(rating), comment },
      },
    });

    // Mirror into booking_review so avg_rating / review_count stay aligned with booking engine.
    try {
      await prisma.booking_review.create({
        data: {
          booking_id,
          booking_listing_id: booking.booking_listing_id,
          user_id: req.user.user_id,
          rating: Math.round(rating),
          review: comment,
        },
      });
    } catch (err) {
      if (err?.code !== 'P2002') throw err;
    }

    await recomputeVendorListingRating(booking.booking_listing_id);

    const io = req.app.get('io');
    notify(io, {
      userId: booking.host_id,
      vertical: 'booking',
      type: 'wedding.rating',
      title: 'New wedding vendor rating',
      body: `A guest rated your wedding booking ${Math.round(rating)}/5.`,
      urgency: 'ambient',
      entityType: 'booking',
      entityId: booking_id,
      actionUrl: 'sd-wedding',
      data: { booking_id, rating: Math.round(rating), comment },
    });

    res.status(201).json({ ok: true, event });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

/* GET VENDOR RATINGS for a host (seller Reviews tab) */
router.get('/vendor-ratings', authenticateToken, async (req, res) => {
  try {
    const events = await prisma.booking_event.findMany({
      where: {
        event_type: 'guest_rating',
        booking: {
          vertical: 'wedding',
          host_id: req.user.user_id,
        },
      },
      orderBy: { created_at: 'desc' },
      take: 100,
      include: {
        booking: {
          select: {
            booking_id: true,
            start_date: true,
            booking_listing: { select: { title: true } },
          },
        },
      },
    });

    res.json(events.map((e) => {
      const meta = e.metadata && typeof e.metadata === 'object' ? e.metadata : {};
      return {
        id: e.booking_event_id,
        booking_id: e.booking_id,
        rating: Number(meta.rating) || 0,
        comment: meta.comment || null,
        created_at: e.created_at,
        listing_title: e.booking?.booking_listing?.title || null,
        start_date: e.booking?.start_date || null,
      };
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load vendor ratings' });
  }
});

export default router;
