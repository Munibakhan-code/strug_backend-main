import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { findMatchingProviders, previewMatchingProviders, broadcastQuoteRequest, providerMatchesRequest, QUOTE_REQUEST_TTL_MS } from '../utils/quote-dispatch.js';
import { openDirectChannel, createChatMessage } from '../services/chat-service.js';
import { notifyQuote, quoteActionUrl } from '../utils/quote-notify.js';
import { validateQuoteForm } from '../utils/quote-form-validate.js';

const router = express.Router();

const PROVIDER_WITH_MATCH = {
  quote_provider_city: true,
  quote_provider_category: { select: { quote_category_id: true } },
};

// Resolve the caller's provider record for a vertical (with city/category includes),
// or null if they aren't registered for that vertical.
async function callerProvider(userId, vertical) {
  const where = { user_id: Number(userId) };
  if (vertical) where.vertical = String(vertical);
  return prisma.quote_provider.findFirst({ where, include: PROVIDER_WITH_MATCH });
}

/** Prefer the provider profile matching the request's vertical. */
async function callerProviderForRequest(userId, request) {
  if (request?.vertical) {
    const byVertical = await callerProvider(userId, request.vertical);
    if (byVertical) return byVertical;
  }
  // Fallback: any of the user's provider profiles that match this request.
  const all = await prisma.quote_provider.findMany({
    where: { user_id: Number(userId) },
    include: PROVIDER_WITH_MATCH,
  });
  return all.find((p) => providerMatchesRequest(p, request)) || null;
}

// POST /quote-requests — create a request and broadcast it to matching providers.
router.post('/', authenticateToken, async (req, res) => {
  try {
    const b = req.body || {};
    const city = (b.city || '').trim();
    const country = (b.country || '').trim();
    if (!city) return res.status(400).json({ message: 'city is required' });
    if (!country) return res.status(400).json({ message: 'country is required' });

    const category = await prisma.quote_category.findUnique({ where: { quote_category_id: Number(b.category_id) } });
    if (!category || category.parent_id == null) {
      return res.status(400).json({ message: 'category_id must be a valid sub-type (leaf category)' });
    }

    // Keep form_data entity-encoded at rest (global sanitizeInput/xss encodes </>).
    // FE decodes on read for display/prefill — decoding again on write would store raw
    // HTML (e.g. <script>) with no encryptedFields coverage for email/PDF sinks.
    const form_data =
      b.form_data && typeof b.form_data === 'object' && !Array.isArray(b.form_data)
        ? b.form_data
        : {};
    const check = validateQuoteForm(category, form_data);
    if (!check.ok) {
      return res.status(400).json({
        message: check.message || 'Invalid form data',
        missing: check.missing || [],
        errors: check.errors || [],
      });
    }

    const now = new Date();
    const request = await prisma.quote_request.create({
      data: {
        requester_id: req.user.user_id,
        category_id: category.quote_category_id,
        vertical: category.vertical || null,
        title: (b.title || category.name).slice(0, 200),
        city,
        country,
        form_data,
        credit_number: b.credit_number ? String(b.credit_number).slice(0, 40) : null,
        notes: b.notes || null,
        status: 'open', // always set — status is String?; NULL would hide from both list queries below
        expires_at: new Date(now.getTime() + QUOTE_REQUEST_TTL_MS),
        created_at: now,
      },
    });

    const providers = await findMatchingProviders({ categoryId: category.quote_category_id, city, country });
    await broadcastQuoteRequest(req.app.get('io'), request, providers);

    res.status(201).json({
      ...request,
      matched_provider_count: providers.length,
      ...(providers.length === 0 && { warning: 'no_providers_in_area' }),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to create quote request' });
  }
});

// GET /quote-requests — my open/active requests with quote counts.
// No form_schema here — renew/re-request only runs from history/detail.
// status is String? — Prisma `notIn` excludes NULL, so treat null as active
// (create always writes 'open'; this is defense-in-depth for legacy/manual rows).
router.get('/', authenticateToken, async (req, res) => {
  try {
    const requests = await prisma.quote_request.findMany({
      where: {
        requester_id: req.user.user_id,
        OR: [
          { status: { notIn: ['expired', 'cancelled', 'deal_closed'] } },
          { status: null },
        ],
      },
      orderBy: { created_at: 'desc' },
      include: {
        quote_category: { select: { quote_category_id: true, name: true, slug: true, vertical: true } },
        _count: { select: { quote: true } },
      },
    });
    res.json(requests.map((r) => ({ ...r, quote_count: r._count.quote })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch requests' });
  }
});

// GET /quote-requests/history — closed/expired/cancelled. (Before /:id so it isn't shadowed.)
// Includes form_schema so the client can one-click re-request / renew without another round-trip.
// NULL status is treated as active on GET /, not listed here.
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const requests = await prisma.quote_request.findMany({
      where: { requester_id: req.user.user_id, status: { in: ['expired', 'cancelled', 'deal_closed'] } },
      orderBy: { created_at: 'desc' },
      include: {
        quote_category: { select: { quote_category_id: true, name: true, slug: true, vertical: true, form_schema: true } },
        _count: { select: { quote: true } },
      },
    });
    res.json(requests.map((r) => ({ ...r, quote_count: r._count.quote })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch history' });
  }
});

// GET /quote-requests/match-preview?category_id=&city=&country= — providers that WOULD
// match a request for this leaf category + city, WITHOUT creating a request or notifying
// anyone. Powers the requester's live "providers in your area" preview. Public fields
// only (no user_id). (Before /:id so the literal path isn't captured by the :id param.)
router.get('/match-preview', authenticateToken, async (req, res) => {
  try {
    const categoryId = Number(req.query.category_id);
    const city = (req.query.city || '').trim();
    const country = (req.query.country || '').trim() || null;
    if (!categoryId || !city) return res.json([]);
    const providers = await previewMatchingProviders({ categoryId, city, country });
    res.json(providers);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to preview providers' });
  }
});

// GET /quote-requests/:id — full detail with quotes (owner only in this milestone).
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });
    const request = await prisma.quote_request.findUnique({
      where: { quote_request_id: id },
      include: {
        quote_category: { select: { quote_category_id: true, name: true, slug: true, vertical: true, form_schema: true } },
        quote: { orderBy: { created_at: 'desc' }, include: { quote_provider: { select: { quote_provider_id: true, business_name: true, provider_type: true, rating: true, license_no: true, bio: true } } } },
        quote_appointment: { orderBy: { quote_appointment_id: 'asc' } },
        quote_review: {
          where: { reviewer_id: req.user.user_id },
          take: 1,
          select: { quote_review_id: true, rating: true, comment: true, created_at: true, provider_id: true },
        },
      },
    });
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.requester_id !== req.user.user_id) return res.status(403).json({ message: 'Not your request' });
    const { quote_review, ...rest } = request;
    res.json({ ...rest, my_review: quote_review?.[0] || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch request' });
  }
});

// PATCH /quote-requests/:id/cancel — requester withdraws the request.
router.patch('/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const request = await prisma.quote_request.findUnique({ where: { quote_request_id: id } });
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.requester_id !== req.user.user_id) return res.status(403).json({ message: 'Not your request' });
    if (['cancelled', 'expired', 'deal_closed'].includes(request.status)) {
      return res.status(409).json({ message: `Request is already ${request.status}` });
    }
    const updated = await prisma.quote_request.update({
      where: { quote_request_id: id },
      data: { status: 'cancelled', updated_at: new Date() },
    });
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to cancel request' });
  }
});

// ── Provider actions ────────────────────────────────────────────────────────

// POST /quote-requests/:id/quotes — provider sends a quote (or a revision of their own
// previous one). { amount, note, details, valid_until }.
router.post('/:id/quotes', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const request = await prisma.quote_request.findUnique({ where: { quote_request_id: id } });
    if (!request) return res.status(404).json({ message: 'Request not found' });
    const provider = await callerProviderForRequest(req.user.user_id, request);
    if (!provider) return res.status(403).json({ message: 'Become a provider first' });
    if (!['open', 'quoted'].includes(request.status)) {
      return res.status(409).json({ message: `Request is ${request.status}; cannot quote` });
    }
    if (!providerMatchesRequest(provider, request)) {
      return res.status(403).json({ message: 'This request is not in your area/categories' });
    }
    if (b.amount != null && (Number.isNaN(Number(b.amount)) || Number(b.amount) < 0)) {
      return res.status(400).json({ message: 'amount must be a non-negative number' });
    }

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      // Supersede the provider's existing active quote (this is a revision).
      const prior = await tx.quote.findFirst({
        where: { quote_request_id: id, provider_id: provider.quote_provider_id, status: 'active' },
      });
      if (prior) {
        await tx.quote.update({ where: { quote_id: prior.quote_id }, data: { status: 'revised', updated_at: now } });
      }
      const quote = await tx.quote.create({
        data: {
          quote_request_id: id,
          provider_id: provider.quote_provider_id,
          amount: b.amount != null ? Number(b.amount) : null,
          currency: b.currency || 'CAD',
          note: b.note || null,
          details: b.details ?? null,
          valid_until: b.valid_until ? new Date(b.valid_until) : null,
          status: 'active',
          revised_from_id: prior ? prior.quote_id : null,
          created_at: now,
        },
      });
      if (request.status === 'open') {
        await tx.quote_request.update({ where: { quote_request_id: id }, data: { status: 'quoted', updated_at: now } });
      }
      return quote;
    });

    // Notify the requester a quote arrived (live event + persisted bell).
    const io = req.app.get('io');
    if (request.requester_id) {
      io?.to(`user-${request.requester_id}`).emit(`quote-new-${id}`, { quote_request_id: id, quote_id: result.quote_id });
      await notifyQuote(io, request.requester_id, 'new_quote', {
        quote_request_id: id,
        title: 'New quote received',
        body: `${provider.business_name || 'A provider'} sent a quote${result.amount != null ? ` of ${result.currency || 'CAD'} ${result.amount}` : ''}.`,
        // Recipient is the REQUESTER → the public per-vertical page, not the provider dashboard.
        unified: { actionUrl: quoteActionUrl(request.vertical) },
      });
    }
    res.status(201).json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to send quote' });
  }
});

// PATCH /quote-requests/quotes/:quoteId/withdraw — provider withdraws their own quote.
router.patch('/quotes/:quoteId/withdraw', authenticateToken, async (req, res) => {
  try {
    const quote = await prisma.quote.findUnique({ where: { quote_id: Number(req.params.quoteId) } });
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    const provider = await prisma.quote_provider.findFirst({
      where: { user_id: req.user.user_id, quote_provider_id: quote.provider_id },
    });
    if (!provider) return res.status(404).json({ message: 'Quote not found' });
    if (quote.status !== 'active') return res.status(409).json({ message: `Quote is ${quote.status}` });
    const updated = await prisma.quote.update({ where: { quote_id: quote.quote_id }, data: { status: 'withdrawn', updated_at: new Date() } });
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to withdraw quote' });
  }
});

// POST /quote-requests/:id/contact — "request more info": open a DM between requester
// and provider (reuses the existing chat system) and optionally post a first message.
// Both sides may initiate:
//   - Requester: only on their own request; must name a provider via provider_id / quote_id
//     (or fall back to the selected quote). Provider must be associated with this request.
//   - Provider: only on requests they are matched to; opens a DM with the requester.
router.post('/:id/contact', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const userId = req.user.user_id;
    const request = await prisma.quote_request.findUnique({ where: { quote_request_id: id } });
    if (!request) return res.status(404).json({ message: 'Request not found' });

    let targetUserId = null;

    if (request.requester_id === userId) {
      // Requester → provider on this request
      const providerId = req.body?.provider_id != null ? Number(req.body.provider_id) : null;
      const quoteId = req.body?.quote_id != null ? Number(req.body.quote_id) : null;
      let providerRow = null;

      if (quoteId) {
        const quote = await prisma.quote.findUnique({
          where: { quote_id: quoteId },
          include: { quote_provider: { select: { quote_provider_id: true, user_id: true } } },
        });
        if (!quote || quote.quote_request_id !== id) {
          return res.status(400).json({ message: 'Quote does not belong to this request' });
        }
        providerRow = quote.quote_provider;
      } else if (providerId) {
        const quote = await prisma.quote.findFirst({
          where: { quote_request_id: id, provider_id: providerId },
          include: { quote_provider: { select: { quote_provider_id: true, user_id: true } } },
        });
        if (!quote) {
          return res.status(403).json({ message: 'Provider is not associated with this request' });
        }
        providerRow = quote.quote_provider;
      } else if (request.selected_quote_id) {
        const quote = await prisma.quote.findUnique({
          where: { quote_id: request.selected_quote_id },
          include: { quote_provider: { select: { quote_provider_id: true, user_id: true } } },
        });
        providerRow = quote?.quote_provider || null;
      } else {
        return res.status(400).json({ message: 'provider_id or quote_id is required' });
      }

      if (!providerRow?.user_id) return res.status(400).json({ message: 'Provider not found' });
      targetUserId = providerRow.user_id;
    } else {
      // Provider → requester on a matched request
      const provider = await callerProviderForRequest(userId, request);
      if (!provider) return res.status(403).json({ message: 'Not authorized to contact on this request' });
      if (!providerMatchesRequest(provider, request)) {
        return res.status(403).json({ message: 'This request is not in your area/categories' });
      }
      if (!request.requester_id) return res.status(400).json({ message: 'Request has no requester' });
      targetUserId = request.requester_id;
    }

    const channel = await openDirectChannel({ userId, targetUserId });
    const message = (req.body?.message || '').trim();
    if (message) {
      await createChatMessage({ channelId: channel.channel_id, senderId: userId, content: message });
    }
    res.status(channel.created ? 201 : 200).json(channel);
  } catch (e) {
    console.error(e);
    const status = e.statusCode || 500;
    res.status(status).json({ message: e.message || 'Failed to open conversation' });
  }
});

// ── Selection, appointment & deal close (M5) ────────────────────────────────

// The current (latest non-cancelled) appointment for a request, if any.
async function currentAppointment(requestId) {
  return prisma.quote_appointment.findFirst({
    where: { quote_request_id: Number(requestId), status: { not: 'cancelled' } },
    orderBy: { quote_appointment_id: 'desc' },
  });
}

// Whether the caller may act on this request as requester or as the selected provider.
async function callerRoleForRequest(userId, request) {
  if (request.requester_id === userId) return 'requester';
  if (request.selected_quote_id) {
    const sel = await prisma.quote.findUnique({ where: { quote_id: request.selected_quote_id }, include: { quote_provider: { select: { user_id: true } } } });
    if (sel?.quote_provider?.user_id === userId) return 'provider';
  }
  return null;
}

// The user on the opposite side of an appointment from the actor (for notifications).
async function otherPartyUserId(role, request, appt) {
  if (role === 'requester') {
    const prov = await prisma.quote_provider.findUnique({ where: { quote_provider_id: appt.provider_id }, select: { user_id: true } });
    return prov?.user_id || null;
  }
  return request.requester_id || null;
}

// GET /quote-requests/:id/availability?quote_id= — open future slots for a quote's provider.
router.get('/:id/availability', authenticateToken, async (req, res) => {
  try {
    const quote = await prisma.quote.findUnique({ where: { quote_id: Number(req.query.quote_id) } });
    if (!quote || quote.quote_request_id !== Number(req.params.id)) return res.status(400).json({ message: 'Valid quote_id for this request is required' });
    const slots = await prisma.quote_provider_availability.findMany({
      where: { quote_provider_id: quote.provider_id, is_booked: false, slot_start: { gte: new Date() } },
      orderBy: { slot_start: 'asc' },
    });
    res.json(slots);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch availability' });
  }
});

// POST /quote-requests/:id/appointment — requester selects a quote and books a time.
// Selecting does NOT close the other quotes (that happens only at deal close).
router.post('/:id/appointment', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const request = await prisma.quote_request.findUnique({ where: { quote_request_id: id } });
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.requester_id !== req.user.user_id) return res.status(403).json({ message: 'Not your request' });
    if (!['quoted', 'appointment_set'].includes(request.status)) return res.status(409).json({ message: `Request is ${request.status}` });

    const quote = await prisma.quote.findUnique({ where: { quote_id: Number(b.quote_id) } });
    if (!quote || quote.quote_request_id !== id) return res.status(400).json({ message: 'Valid quote_id for this request is required' });
    if (!['active', 'selected'].includes(quote.status)) return res.status(409).json({ message: `Quote is ${quote.status}` });

    const existing = await currentAppointment(id);
    if (existing) return res.status(409).json({ message: 'An appointment already exists; cancel it before rebooking' });

    // Resolve the time from a calendar slot or a proposed datetime.
    let scheduledAt = null;
    let slot = null;
    if (b.availability_id) {
      slot = await prisma.quote_provider_availability.findUnique({ where: { quote_provider_availability_id: Number(b.availability_id) } });
      if (!slot || slot.quote_provider_id !== quote.provider_id) return res.status(400).json({ message: 'Slot not found for this provider' });
      if (slot.is_booked) return res.status(409).json({ message: 'Slot is already booked' });
      if (slot.slot_start < new Date()) return res.status(409).json({ message: 'Slot is in the past' });
      scheduledAt = slot.slot_start;
    } else if (b.scheduled_at) {
      scheduledAt = new Date(b.scheduled_at);
      if (Number.isNaN(scheduledAt.getTime())) return res.status(400).json({ message: 'Invalid scheduled_at' });
    } else {
      return res.status(400).json({ message: 'Provide availability_id or scheduled_at' });
    }

    const now = new Date();
    const appt = await prisma.$transaction(async (tx) => {
      await tx.quote.update({ where: { quote_id: quote.quote_id }, data: { status: 'selected', updated_at: now } });
      await tx.quote_request.update({ where: { quote_request_id: id }, data: { selected_quote_id: quote.quote_id, status: 'appointment_set', updated_at: now } });
      if (slot) await tx.quote_provider_availability.update({ where: { quote_provider_availability_id: slot.quote_provider_availability_id }, data: { is_booked: true } });
      return tx.quote_appointment.create({
        data: {
          quote_request_id: id,
          quote_id: quote.quote_id,
          provider_id: quote.provider_id,
          requester_id: req.user.user_id,
          availability_id: slot ? slot.quote_provider_availability_id : null,
          scheduled_at: scheduledAt,
          duration_minutes: b.duration_minutes ? Number(b.duration_minutes) : 30,
          meeting_type: b.meeting_type || null,
          location: b.location || null,
          notes: b.notes || null,
          status: 'proposed',
          created_at: now,
        },
      });
    });

    const io = req.app.get('io');
    const provider = await prisma.quote_provider.findUnique({ where: { quote_provider_id: quote.provider_id }, select: { user_id: true } });
    if (provider?.user_id) {
      io?.to(`user-${provider.user_id}`).emit(`quote-appointment-${id}`, { quote_request_id: id, quote_appointment_id: appt.quote_appointment_id });
      await notifyQuote(io, provider.user_id, 'appointment_booked', { quote_request_id: id, title: 'Appointment booked', body: 'A client booked an appointment for your quote.' });
    }
    res.status(201).json(appt);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to book appointment' });
  }
});

// PATCH /quote-requests/:id/appointment/confirm — requester or provider confirms the time.
router.patch('/:id/appointment/confirm', authenticateToken, async (req, res) => {
  try {
    const request = await prisma.quote_request.findUnique({ where: { quote_request_id: Number(req.params.id) } });
    if (!request) return res.status(404).json({ message: 'Request not found' });
    const role = await callerRoleForRequest(req.user.user_id, request);
    if (!role) return res.status(403).json({ message: 'Not a party to this request' });
    const appt = await currentAppointment(request.quote_request_id);
    if (!appt) return res.status(404).json({ message: 'No appointment to confirm' });
    if (appt.status !== 'proposed') return res.status(409).json({ message: `Appointment is ${appt.status}` });
    const updated = await prisma.quote_appointment.update({ where: { quote_appointment_id: appt.quote_appointment_id }, data: { status: 'confirmed', updated_at: new Date() } });
    const otherId = await otherPartyUserId(role, request, appt);
    await notifyQuote(req.app.get('io'), otherId, 'appointment_confirmed', { quote_request_id: request.quote_request_id, title: 'Appointment confirmed', body: 'The appointment time was confirmed.' });
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to confirm appointment' });
  }
});

// PATCH /quote-requests/:id/appointment/cancel — requester or provider cancels; frees the
// slot and reopens the request for re-selection.
router.patch('/:id/appointment/cancel', authenticateToken, async (req, res) => {
  try {
    const request = await prisma.quote_request.findUnique({ where: { quote_request_id: Number(req.params.id) } });
    if (!request) return res.status(404).json({ message: 'Request not found' });
    const role = await callerRoleForRequest(req.user.user_id, request);
    if (!role) return res.status(403).json({ message: 'Not a party to this request' });
    const appt = await currentAppointment(request.quote_request_id);
    if (!appt) return res.status(404).json({ message: 'No appointment to cancel' });
    const otherId = await otherPartyUserId(role, request, appt);

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.quote_appointment.update({ where: { quote_appointment_id: appt.quote_appointment_id }, data: { status: 'cancelled', updated_at: now } });
      if (appt.availability_id) await tx.quote_provider_availability.update({ where: { quote_provider_availability_id: appt.availability_id }, data: { is_booked: false } }).catch(() => {});
      if (request.selected_quote_id) await tx.quote.update({ where: { quote_id: request.selected_quote_id }, data: { status: 'active', updated_at: now } });
      await tx.quote_request.update({ where: { quote_request_id: request.quote_request_id }, data: { selected_quote_id: null, status: 'quoted', updated_at: now } });
    });
    await notifyQuote(req.app.get('io'), otherId, 'appointment_cancelled', { quote_request_id: request.quote_request_id, title: 'Appointment cancelled', body: 'The appointment was cancelled.' });
    res.json({ cancelled: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to cancel appointment' });
  }
});

// POST /quote-requests/:id/close-deal — requester confirms, or the selected provider marks
// the deal done. Only NOW do the other quotes close.
router.post('/:id/close-deal', authenticateToken, async (req, res) => {
  try {
    const request = await prisma.quote_request.findUnique({ where: { quote_request_id: Number(req.params.id) } });
    if (!request) return res.status(404).json({ message: 'Request not found' });
    const role = await callerRoleForRequest(req.user.user_id, request);
    if (!role) return res.status(403).json({ message: 'Not a party to this request' });
    if (!request.selected_quote_id) return res.status(409).json({ message: 'No quote selected yet' });
    if (request.status === 'deal_closed') return res.status(409).json({ message: 'Deal already closed' });

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.quote_request.update({ where: { quote_request_id: request.quote_request_id }, data: { status: 'deal_closed', updated_at: now } });
      // Close the losing quotes; the selected one stays 'selected'.
      await tx.quote.updateMany({
        where: { quote_request_id: request.quote_request_id, status: 'active', quote_id: { not: request.selected_quote_id } },
        data: { status: 'closed', updated_at: now },
      });
      const appt = await tx.quote_appointment.findFirst({ where: { quote_request_id: request.quote_request_id, status: { not: 'cancelled' } }, orderBy: { quote_appointment_id: 'desc' } });
      if (appt) await tx.quote_appointment.update({ where: { quote_appointment_id: appt.quote_appointment_id }, data: { status: 'completed', updated_at: now } });
    });

    // Notify the other party.
    const io = req.app.get('io');
    const sel = await prisma.quote.findUnique({ where: { quote_id: request.selected_quote_id }, include: { quote_provider: { select: { user_id: true } } } });
    const otherUserId = role === 'requester' ? sel?.quote_provider?.user_id : request.requester_id;
    if (otherUserId) {
      io?.to(`user-${otherUserId}`).emit(`quote-deal-closed-${request.quote_request_id}`, { quote_request_id: request.quote_request_id, closed_by: role });
      await notifyQuote(io, otherUserId, 'deal_closed', { quote_request_id: request.quote_request_id, title: 'Deal closed', body: `The deal was marked closed by the ${role}.` });
    }
    res.json({ deal_closed: true, closed_by: role });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to close deal' });
  }
});

// POST /quote-requests/:id/review — requester rates the selected provider after deal_closed.
// Body: { rating: 1-5, comment? }. One review per request. Updates quote_provider.rating avg.
router.post('/:id/review', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rating = Number(req.body?.rating);
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ message: 'rating must be between 1 and 5' });

    const request = await prisma.quote_request.findUnique({ where: { quote_request_id: id } });
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.requester_id !== req.user.user_id) return res.status(403).json({ message: 'Not your request' });
    if (request.status !== 'deal_closed') return res.status(409).json({ message: 'Deal must be closed before reviewing' });
    if (!request.selected_quote_id) return res.status(409).json({ message: 'No selected quote to review' });

    const selected = await prisma.quote.findUnique({
      where: { quote_id: request.selected_quote_id },
      select: { quote_id: true, provider_id: true },
    });
    if (!selected?.provider_id) return res.status(409).json({ message: 'Selected provider not found' });

    const existing = await prisma.quote_review.findFirst({
      where: { quote_request_id: id, reviewer_id: req.user.user_id },
    });
    if (existing) return res.status(409).json({ message: 'You already reviewed this deal' });

    const comment = req.body?.comment ? String(req.body.comment).slice(0, 2000) : null;
    const review = await prisma.quote_review.create({
      data: {
        quote_request_id: id,
        quote_id: selected.quote_id,
        provider_id: selected.provider_id,
        reviewer_id: req.user.user_id,
        rating,
        comment,
      },
    });

    const agg = await prisma.quote_review.aggregate({
      where: { provider_id: selected.provider_id },
      _avg: { rating: true },
    });
    await prisma.quote_provider.update({
      where: { quote_provider_id: selected.provider_id },
      data: { rating: agg._avg.rating, updated_at: new Date() },
    }).catch((err) => {
      // Review was saved; a failed recompute only leaves the cached average stale.
      console.error(`Failed to recompute rating for quote_provider ${selected.provider_id}:`, err);
    });

    res.status(201).json(review);
  } catch (e) {
    // Concurrent double-submit: the findFirst pre-check raced with another create and
    // hit @@unique([quote_request_id, reviewer_id]).
    if (e?.code === 'P2002') return res.status(409).json({ message: 'You already reviewed this deal' });
    console.error(e);
    res.status(500).json({ message: 'Failed to submit review' });
  }
});

export default router;
