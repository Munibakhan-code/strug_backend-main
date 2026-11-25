import express from 'express';
import crypto from 'crypto';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { sendEmail } from '../utils/mailer.js';
import { isMailConfigured } from '../services/email-service.js';
import { notify } from '../services/notify.js';
import prisma from '../utils/prisma-client.js';
import { encryptSearch } from '../utils/crypto.js';
import { mapWeddingVendorToNeed, pickNeedForWeddingVendor } from '../utils/wedding-concierge-bridge.js';
import { linkOrderToPlan, pickNeedForCategory, resolveTimelineStatus } from '../utils/event-plan-link.js';
import { buildEventPaymentPlan } from '../utils/event-payment-plan.js';

const SHARE_CATEGORIES = ['venue', 'catering', 'floral'];

const router = express.Router();

const PLAN_STATUSES = new Set(['planning', 'active', 'completed', 'cancelled']);
const NEED_STATUSES = new Set(['todo', 'sourcing', 'booked', 'done', 'skipped']);
const GUEST_STATUSES = new Set(['pending', 'invited', 'accepted', 'declined', 'maybe']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function token() {
  return crypto.randomBytes(24).toString('hex');
}

/** #1296: event share / invite capability URLs (90 days). Legacy null expires_at still accepted. */
const EVENT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function eventTokenExpiresAt(from = new Date()) {
  return new Date(from.getTime() + EVENT_TOKEN_TTL_MS);
}

function isEventTokenExpired(expiresAt) {
  if (!expiresAt) return false;
  return Date.now() > new Date(expiresAt).getTime();
}

/** Global Prisma omit strips share/invite tokens; opt back in for owner + public token flows. */
const WITH_SHARE_TOKEN = { omit: { share_token: false } };
const WITH_INVITE_TOKEN = { omit: { invite_token: false } };
const GUEST_LIST_WITH_TOKEN = {
  omit: { invite_token: false },
  orderBy: { created_at: 'asc' },
};

function ownerPlanInclude(registryInclude) {
  return {
    needs: { orderBy: { sort_order: 'asc' } },
    guest_list: GUEST_LIST_WITH_TOKEN,
    registry_items: {
      where: { status: { not: 'removed' } },
      include: registryInclude,
      orderBy: { created_at: 'desc' },
    },
  };
}

function money(n) {
  return Math.round((parseFloat(n ?? 0) + Number.EPSILON) * 100) / 100;
}

async function creditWallet(tx, userId, amount, { source, description }) {
  const walletCredit = await tx.strug_wallet.updateMany({
    where: { user_id: userId },
    data: { balance: { increment: amount } },
  });
  if (walletCredit.count === 0) {
    await tx.strug_wallet.create({
      data: { user_id: userId, balance: amount, currency: 'CAD' },
    });
  }
  await tx.wallet_transaction.create({
    data: {
      user_id: userId,
      amount,
      type: 'credit',
      source,
      description,
      status: 'completed',
    },
  });
}

function parseId(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Prefer date-only as noon UTC to avoid timezone off-by-one in display. */
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

function asBool(v) {
  if (v === true || v === false) return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0' || v === '' || v == null) return false;
  return Boolean(v);
}

function publicAppOrigin() {
  const raw = process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || process.env.APP_ORIGIN || 'https://strug.ca';
  return String(raw).replace(/\/$/, '');
}

/** Default checklist by occasion — wedding-style personal planner. */
const NEED_PRESETS = {
  wedding: [
    { category: 'venue', title: 'Venue', linked_nav: 'venues' },
    { category: 'cake', title: 'Cake', linked_nav: 'catering' },
    { category: 'flowers', title: 'Flowers', linked_nav: 'floral' },
    { category: 'dress', title: 'Dress / attire', linked_nav: 'wedding' },
    { category: 'rental', title: 'Rentals', linked_nav: 'equipment' },
    { category: 'staff', title: 'Staff', linked_nav: 'ondemand' },
    { category: 'photographer', title: 'Photographer', linked_nav: 'ondemand' },
    { category: 'videographer', title: 'Videographer', linked_nav: 'ondemand' },
    { category: 'catering', title: 'Catering', linked_nav: 'catering' },
    { category: 'decor', title: 'Décor', linked_nav: 'decor' },
    // linked_nav "registry" is handled in the planner UI (opens contribution registry)
    { category: 'gifts', title: 'Gift registry', linked_nav: 'registry' },
  ],
  birthday: [
    { category: 'venue', title: 'Venue', linked_nav: 'venues' },
    { category: 'cake', title: 'Cake', linked_nav: 'catering' },
    { category: 'decor', title: 'Décor', linked_nav: 'decor' },
    { category: 'catering', title: 'Catering', linked_nav: 'catering' },
    { category: 'gifts', title: 'Gift registry', linked_nav: 'registry' },
  ],
  corporate: [
    { category: 'venue', title: 'Venue', linked_nav: 'venues' },
    { category: 'catering', title: 'Catering', linked_nav: 'catering' },
    { category: 'staff', title: 'Staff', linked_nav: 'ondemand' },
    { category: 'decor', title: 'Décor', linked_nav: 'decor' },
  ],
  baby: [
    { category: 'venue', title: 'Venue', linked_nav: 'venues' },
    { category: 'cake', title: 'Cake', linked_nav: 'catering' },
    { category: 'decor', title: 'Décor', linked_nav: 'decor' },
    { category: 'gifts', title: 'Gift registry', linked_nav: 'registry' },
  ],
  dinner: [
    { category: 'venue', title: 'Venue', linked_nav: 'venues' },
    { category: 'catering', title: 'Catering', linked_nav: 'catering' },
    { category: 'flowers', title: 'Floral', linked_nav: 'floral' },
  ],
  other: [
    { category: 'venue', title: 'Venue', linked_nav: 'venues' },
    { category: 'catering', title: 'Catering', linked_nav: 'catering' },
    { category: 'decor', title: 'Décor', linked_nav: 'decor' },
    { category: 'gifts', title: 'Gift registry', linked_nav: 'registry' },
  ],
};

/** Starter contribution wishlist items (guests pitch in like Strug wishlist). */
const REGISTRY_SEEDS = {
  wedding: [
    { title: 'Honeymoon / cash gifts', description: 'Pitch in toward our celebration', price: 500 },
    { title: 'Home starter fund', description: 'Help us furnish our first home', price: 300 },
  ],
  birthday: [
    { title: 'Group gift fund', description: 'Chip in toward a shared birthday gift', price: 150 },
  ],
  baby: [
    { title: 'Baby essentials fund', description: 'Contribute toward baby gear & gifts', price: 200 },
  ],
  other: [
    { title: 'Gift / contribution fund', description: 'Pitch in if you would like to contribute', price: 100 },
  ],
};

function shapeRegistryItem(item, { publicView = false } = {}) {
  const contributions = (item.contributions || []).filter((c) => c.status === 'completed');
  const total_contributed = contributions.reduce((s, c) => s + money(c.amount), 0);
  const price = money(item.price);
  return {
    registry_item_id: item.registry_item_id,
    event_plan_id: item.event_plan_id,
    title: item.title,
    description: item.description,
    image_url: item.image_url,
    price,
    currency: item.currency,
    item_type: item.item_type,
    item_ref_id: item.item_ref_id,
    status: item.status,
    created_at: item.created_at,
    total_contributed,
    progress_pct: price > 0 ? Math.min(100, Math.round((total_contributed / price) * 100)) : 0,
    contributor_count: contributions.length,
    recent_contributors: contributions.slice(-5).map((c) => ({
      ...(publicView ? {} : { contributor_id: c.contributor_id }),
      amount: money(c.amount),
      note: c.note,
      created_at: c.created_at,
      profile: publicView
        ? (c.contributor?.social_profiles
          ? {
              display_name: c.contributor.social_profiles.display_name || 'Guest',
              profile_pic_url: c.contributor.social_profiles.profile_pic_url || null,
            }
          : { display_name: 'Guest', profile_pic_url: null })
        : (c.contributor?.social_profiles ?? null),
    })),
  };
}

function shapePlan(plan, { includeLists = false } = {}) {
  const base = {
    event_plan_id: plan.event_plan_id,
    owner_id: plan.owner_id,
    title: plan.title,
    occasion: plan.occasion,
    event_date: plan.event_date,
    rsvp_deadline: plan.rsvp_deadline,
    guests: plan.guests,
    budget: plan.budget != null ? money(plan.budget) : null,
    city: plan.city,
    vibe: plan.vibe,
    notes: plan.notes,
    invite_theme: plan.invite_theme,
    invite_message: plan.invite_message,
    cover_color: plan.cover_color,
    share_token: plan.share_token,
    status: plan.status,
    allow_late_rsvp: plan.allow_late_rsvp !== false,
    collaborators: Array.isArray(plan.collaborators) ? plan.collaborators : [],
    package_json: plan.package_json,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
  };
  if (!includeLists) {
    base.need_count = plan._count?.needs ?? plan.needs?.length ?? 0;
    base.guest_count = plan._count?.guest_list ?? plan.guest_list?.length ?? 0;
    base.registry_count = plan._count?.registry_items ?? plan.registry_items?.length ?? 0;
    return base;
  }
  base.needs = (plan.needs || []).map((n) => ({
    ...n,
    target_budget: n.target_budget != null ? money(n.target_budget) : null,
  }));
  base.guest_list = plan.guest_list || [];
  base.registry_items = (plan.registry_items || []).map((i) => shapeRegistryItem(i));
  base.rsvp_summary = {
    pending: base.guest_list.filter((g) => g.status === 'pending' || g.status === 'invited').length,
    accepted: base.guest_list.filter((g) => g.status === 'accepted').length,
    declined: base.guest_list.filter((g) => g.status === 'declined').length,
    maybe: base.guest_list.filter((g) => g.status === 'maybe').length,
  };
  return base;
}

/** Owner or listed collaborator may manage the plan. */
async function assertOwnsPlan(eventPlanId, userId, { allowCancelled = false } = {}) {
  const id = parseId(eventPlanId);
  if (!id) return { error: 400, message: 'Invalid event id' };
  const plan = await prisma.event_plan.findUnique({
    where: { event_plan_id: id },
    select: {
      owner_id: true,
      event_plan_id: true,
      status: true,
      share_token: true,
      collaborators: true,
      title: true,
    },
  });
  if (!plan) return { error: 404, message: 'Event not found' };
  const collabs = Array.isArray(plan.collaborators) ? plan.collaborators.map(Number) : [];
  const isCollab = collabs.includes(Number(userId));
  if (plan.owner_id !== userId && !isCollab) return { error: 403, message: 'Forbidden' };
  if (!allowCancelled && plan.status === 'cancelled') {
    return { error: 400, message: 'Event is cancelled' };
  }
  return { plan, isOwner: plan.owner_id === userId, isCollaborator: isCollab };
}

async function assertContributeAccess(plan, userId, { share_token, invite_token } = {}) {
  if (plan.owner_id === userId) return { ok: true };
  const collabs = Array.isArray(plan.collaborators) ? plan.collaborators.map(Number) : [];
  if (collabs.includes(Number(userId))) return { ok: true };
  if (share_token && String(share_token) === plan.share_token) return { ok: true };
  if (invite_token) {
    const guest = await prisma.event_guest.findFirst({
      where: { event_plan_id: plan.event_plan_id, invite_token: String(invite_token) },
      select: { event_guest_id: true },
    });
    if (guest) return { ok: true };
  }
  return { ok: false };
}

function packageNeedExtras(package_json, category) {
  const items = package_json?.items;
  if (!Array.isArray(items)) return {};
  const match = items.find((it) => {
    if (!it?.key) return false;
    if (it.key === category) return true;
    if (category === 'flowers' && it.key === 'floral') return true;
    if (category === 'floral' && it.key === 'flowers') return true;
    if (category === 'cake' && it.key === 'catering') return true;
    if (category === 'catering' && it.key === 'catering') return true;
    if (category === 'decor' && it.key === 'decor') return true;
    return false;
  });
  if (!match) return {};
  const listingId = match.listing_id != null ? parseInt(match.listing_id, 10) : NaN;
  const line = match.lineTotal != null ? Number(match.lineTotal) : (match.price != null ? Number(match.price) : NaN);
  return {
    linked_listing_id: Number.isFinite(listingId) ? listingId : null,
    linked_listing_title: match.name ? String(match.name).slice(0, 300) : null,
    ...(Number.isFinite(line) && line > 0 ? { target_budget: money(line) } : {}),
  };
}

const registryInclude = {
  contributions: {
    select: {
      contribution_id: true,
      contributor_id: true,
      amount: true,
      note: true,
      status: true,
      created_at: true,
      contributor: {
        select: {
          social_profiles: {
            select: { display_name: true, profile_pic_url: true, handle: true },
          },
        },
      },
    },
    orderBy: { created_at: 'asc' },
  },
};

// ── List my events ──────────────────────────────────────────────────────────
router.get('/plans', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user.user_id);
    const listInclude = {
      _count: { select: { needs: true, guest_list: true, registry_items: true } },
    };

    let plans;
    try {
      plans = await prisma.event_plan.findMany({
        where: {
          status: { not: 'cancelled' },
          OR: [
            { owner_id: userId },
            { collaborators: { array_contains: [userId] } },
          ],
        },
        include: listInclude,
        orderBy: { created_at: 'desc' },
        ...WITH_SHARE_TOKEN,
      });
    } catch (filterErr) {
      // Stale Prisma client / engine without collaborators filter support.
      console.warn('event-concierge list collab filter failed, falling back to owner + raw SQL', filterErr?.message || filterErr);
      const owned = await prisma.event_plan.findMany({
        where: { status: { not: 'cancelled' }, owner_id: userId },
        include: listInclude,
        orderBy: { created_at: 'desc' },
        ...WITH_SHARE_TOKEN,
      });
      let collab = [];
      try {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT event_plan_id FROM event_plan
           WHERE status IS DISTINCT FROM 'cancelled'
             AND owner_id <> $1
             AND collaborators IS NOT NULL
             AND collaborators @> $2::jsonb`,
          userId,
          JSON.stringify([userId]),
        );
        const ids = (rows || []).map((r) => Number(r.event_plan_id)).filter((n) => Number.isFinite(n));
        if (ids.length) {
          collab = await prisma.event_plan.findMany({
            where: { event_plan_id: { in: ids } },
            include: listInclude,
            orderBy: { created_at: 'desc' },
            ...WITH_SHARE_TOKEN,
          });
        }
      } catch (rawErr) {
        console.warn('event-concierge collab raw list skipped', rawErr?.message || rawErr);
      }
      const seen = new Set();
      plans = [...owned, ...collab].filter((p) => {
        if (seen.has(p.event_plan_id)) return false;
        seen.add(p.event_plan_id);
        return true;
      }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    res.json(plans.map((p) => {
      const shaped = shapePlan(p);
      shaped.is_owner = p.owner_id === userId;
      return shaped;
    }));
  } catch (err) {
    console.error('event-concierge list error', err);
    res.status(500).json({ error: 'Failed to list events' });
  }
});

// ── Create event (+ seed needs checklist) ───────────────────────────────────
router.post('/plans', authenticateToken, async (req, res) => {
  try {
    const {
      title, occasion, event_date, guests, budget, city, vibe, notes,
      invite_theme, invite_message, package_json, seed_needs = true,
      rsvp_deadline, allow_late_rsvp,
    } = req.body;

    if (!title?.trim() || !occasion) {
      return res.status(400).json({ error: 'title and occasion are required' });
    }

    const doSeed = asBool(seed_needs);
    const presets = NEED_PRESETS[occasion] || NEED_PRESETS.other;
    const registrySeeds = doSeed ? (REGISTRY_SEEDS[occasion] || (presets.some((p) => p.category === 'gifts') ? REGISTRY_SEEDS.other : [])) : [];
    const guestsN = guests != null ? parseInt(guests, 10) : null;
    const budgetN = budget != null && budget !== '' ? parseFloat(budget) : null;
    const parsedDate = event_date ? parseEventDate(event_date) : null;
    if (event_date && !parsedDate) {
      return res.status(400).json({ error: 'Invalid event_date' });
    }
    let parsedDeadline = null;
    if (rsvp_deadline != null && rsvp_deadline !== '') {
      parsedDeadline = parseEventDate(rsvp_deadline);
      if (!parsedDeadline) return res.status(400).json({ error: 'Invalid rsvp_deadline' });
    }

    const plan = await prisma.event_plan.create({
      data: {
        owner_id: req.user.user_id,
        title: String(title).slice(0, 200),
        occasion: String(occasion).slice(0, 40),
        event_date: parsedDate,
        rsvp_deadline: parsedDeadline,
        allow_late_rsvp: allow_late_rsvp === undefined ? true : asBool(allow_late_rsvp),
        guests: Number.isFinite(guestsN) ? guestsN : null,
        budget: Number.isFinite(budgetN) ? money(budgetN) : null,
        city: city ? String(city).slice(0, 100) : null,
        vibe: vibe ? String(vibe).slice(0, 40) : null,
        notes: notes != null ? String(notes).slice(0, 5000) : null,
        invite_theme: invite_theme || 'elegant',
        invite_message: invite_message != null ? String(invite_message).slice(0, 2000) : null,
        share_token: token(),
        share_token_expires_at: eventTokenExpiresAt(),
        package_json: package_json ?? null,
        needs: doSeed
          ? {
              create: presets.map((n, i) => ({
                category: n.category,
                title: n.title,
                linked_nav: n.linked_nav,
                sort_order: i,
                status: 'todo',
                ...packageNeedExtras(package_json, n.category),
              })),
            }
          : undefined,
        registry_items: registrySeeds.length
          ? {
              create: registrySeeds.map((r) => ({
                title: r.title,
                description: r.description,
                price: r.price,
                item_type: 'custom',
                status: 'active',
              })),
            }
          : undefined,
      },
      include: {
        needs: { orderBy: { sort_order: 'asc' } },
        guest_list: GUEST_LIST_WITH_TOKEN,
        registry_items: { include: registryInclude },
      },
      ...WITH_SHARE_TOKEN,
    });

    res.status(201).json(shapePlan(plan, { includeLists: true }));
  } catch (err) {
    console.error('event-concierge create error', err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// ── Get one event (owner) ───────────────────────────────────────────────────
router.get('/plans/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertOwnsPlan(id, req.user.user_id, { allowCancelled: true });
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const plan = await prisma.event_plan.findUnique({
      where: { event_plan_id: id },
      include: ownerPlanInclude(registryInclude),
      ...WITH_SHARE_TOKEN,
    });
    const shaped = shapePlan(plan, { includeLists: true });
    shaped.is_owner = plan.owner_id === req.user.user_id;
    shaped.viewer_id = req.user.user_id;
    const collabIds = Array.isArray(shaped.collaborators) ? shaped.collaborators.map(Number).filter(Boolean) : [];
    if (collabIds.length) {
      const users = await prisma.user.findMany({
        where: { user_id: { in: collabIds } },
        select: { user_id: true, username: true },
      });
      const byId = new Map(users.map((u) => [u.user_id, u]));
      shaped.collaborator_details = collabIds.map((uid) => ({
        user_id: uid,
        label: byId.get(uid)?.username || `User #${uid}`,
      }));
    } else {
      shaped.collaborator_details = [];
    }
    res.json(shaped);
  } catch (err) {
    console.error('event-concierge get error', err);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// ── Update event ────────────────────────────────────────────────────────────
router.patch('/plans/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertOwnsPlan(id, req.user.user_id, { allowCancelled: true });
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    // Cancelled plans stay locked (soft-delete is final from owner UI)
    if (gate.plan.status === 'cancelled') {
      return res.status(400).json({ error: 'Event is cancelled and cannot be edited' });
    }

    const data = {};
    if (req.body.title !== undefined) data.title = String(req.body.title).slice(0, 200);
    if (req.body.occasion !== undefined) data.occasion = String(req.body.occasion).slice(0, 40);
    if (req.body.event_date !== undefined) {
      if (req.body.event_date == null || req.body.event_date === '') data.event_date = null;
      else {
        data.event_date = parseEventDate(req.body.event_date);
        if (!data.event_date) return res.status(400).json({ error: 'Invalid event_date' });
      }
    }
    if (req.body.rsvp_deadline !== undefined) {
      if (req.body.rsvp_deadline == null || req.body.rsvp_deadline === '') {
        data.rsvp_deadline = null;
      } else {
        data.rsvp_deadline = parseEventDate(req.body.rsvp_deadline);
        if (!data.rsvp_deadline) {
          return res.status(400).json({ error: 'Invalid rsvp_deadline' });
        }
      }
    }
    if (req.body.allow_late_rsvp !== undefined) {
      data.allow_late_rsvp = asBool(req.body.allow_late_rsvp);
    }
    if (req.body.guests !== undefined) {
      const g = req.body.guests != null ? parseInt(req.body.guests, 10) : null;
      data.guests = g == null || Number.isFinite(g) ? g : null;
      if (g != null && !Number.isFinite(g)) return res.status(400).json({ error: 'Invalid guests' });
    }
    if (req.body.budget !== undefined) {
      if (req.body.budget == null || req.body.budget === '') data.budget = null;
      else {
        const b = parseFloat(req.body.budget);
        if (!Number.isFinite(b)) return res.status(400).json({ error: 'Invalid budget' });
        data.budget = money(b);
      }
    }
    if (req.body.city !== undefined) data.city = req.body.city != null ? String(req.body.city).slice(0, 100) : null;
    if (req.body.vibe !== undefined) data.vibe = req.body.vibe != null ? String(req.body.vibe).slice(0, 40) : null;
    if (req.body.notes !== undefined) data.notes = req.body.notes != null ? String(req.body.notes).slice(0, 5000) : null;
    if (req.body.invite_theme !== undefined) data.invite_theme = String(req.body.invite_theme).slice(0, 40);
    if (req.body.invite_message !== undefined) {
      data.invite_message = req.body.invite_message != null ? String(req.body.invite_message).slice(0, 2000) : null;
    }
    if (req.body.cover_color !== undefined) {
      data.cover_color = req.body.cover_color != null ? String(req.body.cover_color).slice(0, 20) : null;
    }
    if (req.body.package_json !== undefined) data.package_json = req.body.package_json;
    if (req.body.status !== undefined) {
      const st = String(req.body.status);
      if (!PLAN_STATUSES.has(st) || st === 'cancelled') {
        return res.status(400).json({ error: 'Invalid status (use DELETE to cancel)' });
      }
      data.status = st;
    }

    const plan = await prisma.event_plan.update({
      where: { event_plan_id: id },
      data,
      include: ownerPlanInclude(registryInclude),
      ...WITH_SHARE_TOKEN,
    });
    res.json(shapePlan(plan, { includeLists: true }));
  } catch (err) {
    console.error('event-concierge patch error', err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

/** Owner-only: add co-planner by email (must be an existing Strug user). */
router.post('/plans/:id/collaborators', authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertOwnsPlan(id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    if (!gate.isOwner) return res.status(403).json({ error: 'Only the event owner can add co-planners' });

    const email = String(req.body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email required' });

    const encryptedEmail = encryptSearch(email);
    const user = await prisma.user.findFirst({
      where: { email: encryptedEmail },
      select: { user_id: true, name: true, email: true },
    });
    if (!user) return res.status(404).json({ error: 'No Strug account with that email' });
    if (user.user_id === gate.plan.owner_id) {
      return res.status(400).json({ error: 'Owner is already on the plan' });
    }

    const current = Array.isArray(gate.plan.collaborators) ? gate.plan.collaborators.map(Number) : [];
    if (current.includes(user.user_id)) {
      return res.status(400).json({ error: 'Already a co-planner' });
    }
    const next = [...current, user.user_id];
    const plan = await prisma.event_plan.update({
      where: { event_plan_id: id },
      data: { collaborators: next },
      include: ownerPlanInclude(registryInclude),
      ...WITH_SHARE_TOKEN,
    });

    try {
      const io = req.app.get('io');
      notify(io, {
        userId: user.user_id,
        vertical: 'booking',
        type: 'event.coplanner',
        title: `You're a co-planner`,
        body: `You can help plan “${plan.title}” in Event Concierge`,
        urgency: 'ambient',
        entityType: 'event_plan',
        entityId: id,
        actionUrl: 'concierge',
        data: { event_plan_id: id },
      });
    } catch { /* ignore */ }

    res.json(shapePlan(plan, { includeLists: true }));
  } catch (err) {
    console.error('event-concierge add collaborator error', err);
    res.status(500).json({ error: 'Failed to add co-planner' });
  }
});

router.delete('/plans/:id/collaborators/:userId', authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const uid = parseId(req.params.userId);
    if (!id || !uid) return res.status(400).json({ error: 'Invalid id' });
    const gate = await assertOwnsPlan(id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    if (!gate.isOwner) return res.status(403).json({ error: 'Only the event owner can remove co-planners' });

    const current = Array.isArray(gate.plan.collaborators) ? gate.plan.collaborators.map(Number) : [];
    const next = current.filter((x) => x !== uid);
    const plan = await prisma.event_plan.update({
      where: { event_plan_id: id },
      data: { collaborators: next },
      include: ownerPlanInclude(registryInclude),
      ...WITH_SHARE_TOKEN,
    });
    res.json(shapePlan(plan, { includeLists: true }));
  } catch (err) {
    console.error('event-concierge remove collaborator error', err);
    res.status(500).json({ error: 'Failed to remove co-planner' });
  }
});

// ── Soft-delete / cancel ────────────────────────────────────────────────────
router.delete('/plans/:id', authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertOwnsPlan(id, req.user.user_id, { allowCancelled: true });
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    if (!gate.isOwner) {
      return res.status(403).json({ error: 'Only the event owner can cancel this event' });
    }
    await prisma.event_plan.update({
      where: { event_plan_id: id },
      data: { status: 'cancelled' },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('event-concierge delete error', err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// ── Needs checklist ─────────────────────────────────────────────────────────
router.post('/plans/:id/needs', authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertOwnsPlan(id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const { category, title, target_budget, notes, linked_nav } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'title required' });

    let tb = null;
    if (target_budget != null && target_budget !== '') {
      const b = parseFloat(target_budget);
      if (!Number.isFinite(b) || b < 0) return res.status(400).json({ error: 'Invalid target_budget' });
      tb = money(b);
    }

    const maxSort = await prisma.event_need.aggregate({
      where: { event_plan_id: id },
      _max: { sort_order: true },
    });

    const need = await prisma.event_need.create({
      data: {
        event_plan_id: id,
        category: String(category || 'custom').slice(0, 40),
        title: String(title).slice(0, 200),
        target_budget: tb,
        notes: notes || null,
        linked_nav: linked_nav || null,
        status: 'todo',
        sort_order: (maxSort._max.sort_order ?? -1) + 1,
      },
    });
    res.status(201).json({
      ...need,
      target_budget: need.target_budget != null ? money(need.target_budget) : null,
    });
  } catch (err) {
    console.error('event-concierge add need error', err);
    res.status(500).json({ error: 'Failed to add need' });
  }
});

router.patch('/needs/:needId', authenticateToken, async (req, res) => {
  try {
    const needId = parseId(req.params.needId);
    if (!needId) return res.status(400).json({ error: 'Invalid need id' });
    const need = await prisma.event_need.findUnique({ where: { event_need_id: needId } });
    if (!need) return res.status(404).json({ error: 'Not found' });
    const gate = await assertOwnsPlan(need.event_plan_id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const data = {};
    if (req.body.title !== undefined) data.title = String(req.body.title).slice(0, 200);
    if (req.body.category !== undefined) data.category = String(req.body.category).slice(0, 40);
    if (req.body.notes !== undefined) data.notes = req.body.notes != null ? String(req.body.notes).slice(0, 5000) : null;
    if (req.body.linked_nav !== undefined) {
      data.linked_nav = req.body.linked_nav != null ? String(req.body.linked_nav).slice(0, 40) : null;
    }
    if (req.body.linked_listing_title !== undefined) {
      data.linked_listing_title = req.body.linked_listing_title != null
        ? String(req.body.linked_listing_title).slice(0, 300) : null;
    }
    if (req.body.sort_order !== undefined) {
      const so = parseInt(req.body.sort_order, 10);
      if (!Number.isFinite(so)) return res.status(400).json({ error: 'Invalid sort_order' });
      data.sort_order = so;
    }
    if (req.body.status !== undefined) {
      const st = String(req.body.status);
      if (!NEED_STATUSES.has(st)) return res.status(400).json({ error: 'Invalid need status' });
      data.status = st;
    }
    if (req.body.target_budget !== undefined) {
      if (req.body.target_budget == null || req.body.target_budget === '') data.target_budget = null;
      else {
        const b = parseFloat(req.body.target_budget);
        if (!Number.isFinite(b)) return res.status(400).json({ error: 'Invalid target_budget' });
        data.target_budget = money(b);
      }
    }
    if (req.body.linked_listing_id !== undefined) {
      if (req.body.linked_listing_id == null || req.body.linked_listing_id === '') {
        data.linked_listing_id = null;
      } else {
        const n = parseInt(req.body.linked_listing_id, 10);
        if (!Number.isFinite(n)) return res.status(400).json({ error: 'Invalid linked_listing_id' });
        const listing = await prisma.booking_listing.findUnique({
          where: { booking_listing_id: n },
          select: { booking_listing_id: true, title: true, is_active: true },
        });
        if (!listing || listing.is_active === false) {
          return res.status(400).json({ error: 'Listing not found' });
        }
        data.linked_listing_id = n;
        if (data.linked_listing_title === undefined) data.linked_listing_title = listing.title?.slice(0, 300) || null;
      }
    }
    if (req.body.booking_id !== undefined) {
      if (req.body.booking_id == null || req.body.booking_id === '') {
        data.booking_id = null;
      } else {
        const n = parseInt(req.body.booking_id, 10);
        if (!Number.isFinite(n)) return res.status(400).json({ error: 'Invalid booking_id' });
        const booking = await prisma.booking.findUnique({
          where: { booking_id: n },
          select: { booking_id: true, guest_id: true, booking_listing_id: true, booking_listing: { select: { title: true } } },
        });
        if (!booking) return res.status(400).json({ error: 'Booking not found' });
        if (booking.guest_id !== req.user.user_id) {
          return res.status(403).json({ error: 'Booking does not belong to you' });
        }
        data.booking_id = n;
        if (data.linked_listing_id === undefined && booking.booking_listing_id) {
          data.linked_listing_id = booking.booking_listing_id;
        }
        if (data.linked_listing_title === undefined && booking.booking_listing?.title) {
          data.linked_listing_title = booking.booking_listing.title.slice(0, 300);
        }
      }
    }
    // Convenience: marking booked without an explicit status still flips status
    if (req.body.mark_booked === true && data.status === undefined) {
      data.status = 'booked';
    }

    const updated = await prisma.event_need.update({
      where: { event_need_id: needId },
      data,
    });
    res.json({
      ...updated,
      target_budget: updated.target_budget != null ? money(updated.target_budget) : null,
    });
  } catch (err) {
    console.error('event-concierge patch need error', err);
    res.status(500).json({ error: 'Failed to update need' });
  }
});

router.delete('/needs/:needId', authenticateToken, async (req, res) => {
  try {
    const needId = parseId(req.params.needId);
    if (!needId) return res.status(400).json({ error: 'Invalid need id' });
    const need = await prisma.event_need.findUnique({ where: { event_need_id: needId } });
    if (!need) return res.status(404).json({ error: 'Not found' });
    const gate = await assertOwnsPlan(need.event_plan_id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    await prisma.event_need.delete({ where: { event_need_id: needId } });
    res.json({ success: true });
  } catch (err) {
    console.error('event-concierge delete need error', err);
    res.status(500).json({ error: 'Failed to delete need' });
  }
});

// ── Guests / invitations ────────────────────────────────────────────────────
router.post('/plans/:id/guests', authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertOwnsPlan(id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const { name, email, phone } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    if (email && !EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    const guest = await prisma.event_guest.create({
      data: {
        event_plan_id: id,
        name: String(name).slice(0, 200),
        email: email ? String(email).trim().slice(0, 200) : null,
        phone: phone ? String(phone).slice(0, 40) : null,
        invite_token: token(),
        invite_token_expires_at: eventTokenExpiresAt(),
        status: 'pending',
      },
      ...WITH_INVITE_TOKEN,
    });
    res.status(201).json(guest);
  } catch (err) {
    console.error('event-concierge add guest error', err);
    res.status(500).json({ error: 'Failed to add guest' });
  }
});

router.post('/plans/:id/guests/bulk', authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertOwnsPlan(id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    // Accept either legacy `names: string[]` or richer `guests: [{ name, email?, phone? }]`
    let rows = [];
    if (Array.isArray(req.body.guests) && req.body.guests.length) {
      rows = req.body.guests.map((g) => ({
        name: String(g?.name || '').trim(),
        email: g?.email ? String(g.email).trim().toLowerCase() : null,
        phone: g?.phone ? String(g.phone).trim() : null,
      }));
    } else {
      const names = Array.isArray(req.body.names) ? req.body.names : [];
      rows = names.map((n) => ({ name: String(n || '').trim(), email: null, phone: null }));
    }

    const existing = await prisma.event_guest.findMany({
      where: { event_plan_id: id },
      select: { email: true, name: true },
    });
    const existingEmails = new Set(existing.map((g) => (g.email || '').toLowerCase()).filter(Boolean));
    const existingNames = new Set(existing.map((g) => (g.name || '').trim().toLowerCase()).filter(Boolean));

    const cleaned = [];
    let skipped = 0;
    const seenEmail = new Set();
    const seenName = new Set();
    for (const row of rows.slice(0, 100)) {
      if (!row.name) continue;
      if (row.email && !EMAIL_RE.test(row.email)) {
        return res.status(400).json({ error: `Invalid email for ${row.name}` });
      }
      const nameKey = row.name.toLowerCase();
      if (row.email && (existingEmails.has(row.email) || seenEmail.has(row.email))) {
        skipped += 1;
        continue;
      }
      if (!row.email && (existingNames.has(nameKey) || seenName.has(nameKey))) {
        skipped += 1;
        continue;
      }
      if (row.email) seenEmail.add(row.email);
      seenName.add(nameKey);
      cleaned.push({
        event_plan_id: id,
        name: row.name.slice(0, 200),
        email: row.email ? row.email.slice(0, 200) : null,
        phone: row.phone ? row.phone.slice(0, 40) : null,
        invite_token: token(),
        invite_token_expires_at: eventTokenExpiresAt(),
        status: 'pending',
      });
    }
    if (!cleaned.length) {
      return res.status(400).json({ error: skipped ? 'All guests were duplicates' : 'names or guests required' });
    }

    await prisma.event_guest.createMany({ data: cleaned });

    const guest_list = await prisma.event_guest.findMany({
      where: { event_plan_id: id },
      ...GUEST_LIST_WITH_TOKEN,
    });
    res.status(201).json({ guest_list, added: cleaned.length, skipped });
  } catch (err) {
    console.error('event-concierge bulk guests error', err);
    res.status(500).json({ error: 'Failed to add guests' });
  }
});

router.patch('/guests/:guestId', authenticateToken, async (req, res) => {
  try {
    const guestId = parseId(req.params.guestId);
    if (!guestId) return res.status(400).json({ error: 'Invalid guest id' });
    const guest = await prisma.event_guest.findUnique({ where: { event_guest_id: guestId } });
    if (!guest) return res.status(404).json({ error: 'Not found' });
    const gate = await assertOwnsPlan(guest.event_plan_id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const data = {};
    if (req.body.name !== undefined) data.name = String(req.body.name).slice(0, 200);
    if (req.body.email !== undefined) {
      if (req.body.email == null || req.body.email === '') data.email = null;
      else {
        const em = String(req.body.email).trim().slice(0, 200);
        if (!EMAIL_RE.test(em)) return res.status(400).json({ error: 'Invalid email' });
        data.email = em;
      }
    }
    if (req.body.phone !== undefined) {
      data.phone = req.body.phone != null ? String(req.body.phone).slice(0, 40) : null;
    }
    if (req.body.rsvp_note !== undefined) {
      data.rsvp_note = req.body.rsvp_note != null ? String(req.body.rsvp_note).slice(0, 500) : null;
    }
    if (req.body.plus_ones !== undefined) {
      const p = parseInt(req.body.plus_ones, 10);
      if (!Number.isFinite(p)) return res.status(400).json({ error: 'Invalid plus_ones' });
      data.plus_ones = Math.max(0, Math.min(10, p));
    }
    if (req.body.status !== undefined) {
      const st = String(req.body.status);
      if (!GUEST_STATUSES.has(st)) return res.status(400).json({ error: 'Invalid guest status' });
      data.status = st;
    }
    if (asBool(req.body.mark_invited)) {
      data.status = (data.status || guest.status) === 'pending' ? 'invited' : (data.status || guest.status);
      data.invited_at = new Date();
    }

    const updated = await prisma.event_guest.update({
      where: { event_guest_id: guestId },
      data,
      ...WITH_INVITE_TOKEN,
    });
    res.json(updated);
  } catch (err) {
    console.error('event-concierge patch guest error', err);
    res.status(500).json({ error: 'Failed to update guest' });
  }
});

router.delete('/guests/:guestId', authenticateToken, async (req, res) => {
  try {
    const guestId = parseInt(req.params.guestId, 10);
    const guest = await prisma.event_guest.findUnique({ where: { event_guest_id: guestId } });
    if (!guest) return res.status(404).json({ error: 'Not found' });
    const gate = await assertOwnsPlan(guest.event_plan_id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    await prisma.event_guest.delete({ where: { event_guest_id: guestId } });
    res.json({ success: true });
  } catch (err) {
    console.error('event-concierge delete guest error', err);
    res.status(500).json({ error: 'Failed to delete guest' });
  }
});

/** Send invite email via Resend (falls back to mailto client-side if unavailable). */
router.post('/guests/:guestId/send-invite', authenticateToken, async (req, res) => {
  try {
    const guestId = parseInt(req.params.guestId, 10);
    const guest = await prisma.event_guest.findUnique({
      where: { event_guest_id: guestId },
      include: { event_plan: true },
      ...WITH_INVITE_TOKEN,
    });
    if (!guest) return res.status(404).json({ error: 'Not found' });
    const gate = await assertOwnsPlan(guest.event_plan_id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    if (!guest.email?.trim()) {
      return res.status(400).json({ error: 'Guest has no email address' });
    }

    const plan = guest.event_plan;
    const link = `${publicAppOrigin()}/invite/${guest.invite_token}`;
    const title = plan.title || 'an event';
    const when = plan.event_date
      ? new Date(plan.event_date).toLocaleDateString('en-CA', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
      : 'Date TBD';

    if (!EMAIL_RE.test(guest.email.trim())) {
      return res.status(400).json({ error: 'Invalid guest email' });
    }

    if (!isMailConfigured()) {
      return res.status(503).json({
        error: 'Email service unavailable - use Email invite (mailto) instead',
        mailto_fallback: true,
      });
    }

    try {
      await sendEmail(
        'event-invite',
        {
          guest_name: guest.name || 'there',
          event_title: title,
          event_when: when,
          event_city: plan.city || '',
          invite_message: plan.invite_message || '',
          rsvp_url: link,
        },
        guest.email.trim(),
        'emails.event_invite.subject',
        'en',
      );
    } catch (mailErr) {
      console.error('event-concierge invite email failed', mailErr?.message || mailErr);
      return res.status(503).json({
        error: 'Email service unavailable - use Email invite (mailto) instead',
        mailto_fallback: true,
      });
    }

    const updated = await prisma.event_guest.update({
      where: { event_guest_id: guestId },
      data: {
        status: guest.status === 'pending' ? 'invited' : guest.status,
        invited_at: new Date(),
      },
      ...WITH_INVITE_TOKEN,
    });
    res.json({ success: true, guest: updated });
  } catch (err) {
    console.error('event-concierge send invite error', err);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// Mark all pending guests as invited (host shared invites)
router.post('/plans/:id/guests/mark-invited', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const gate = await assertOwnsPlan(id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    await prisma.event_guest.updateMany({
      where: { event_plan_id: id, status: 'pending' },
      data: { status: 'invited', invited_at: new Date() },
    });
    const guest_list = await prisma.event_guest.findMany({
      where: { event_plan_id: id },
      ...GUEST_LIST_WITH_TOKEN,
    });
    res.json(guest_list);
  } catch (err) {
    console.error('event-concierge mark invited error', err);
    res.status(500).json({ error: 'Failed to mark invited' });
  }
});

// ── Public invite + RSVP ────────────────────────────────────────────────────
router.get('/invite/:token', optionalAuth, async (req, res) => {
  try {
    const guest = await prisma.event_guest.findUnique({
      where: { invite_token: req.params.token },
      include: {
        event_plan: {
          include: {
            registry_items: {
              where: { status: { in: ['active', 'funded'] } },
              include: registryInclude,
              orderBy: { created_at: 'desc' },
            },
            owner: {
              select: {
                user_id: true,
                name: true,
                social_profiles: {
                  select: { display_name: true, profile_pic_url: true },
                },
              },
            },
          },
        },
      },
      ...WITH_INVITE_TOKEN,
    });
    if (!guest || guest.event_plan.status === 'cancelled' || isEventTokenExpired(guest.invite_token_expires_at)) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const plan = guest.event_plan;
    res.json({
      guest: {
        event_guest_id: guest.event_guest_id,
        name: guest.name,
        status: guest.status,
        plus_ones: guest.plus_ones,
        rsvp_note: guest.rsvp_note,
        invite_token: guest.invite_token,
      },
      event: {
        event_plan_id: plan.event_plan_id,
        title: plan.title,
        occasion: plan.occasion,
        event_date: plan.event_date,
        rsvp_deadline: plan.rsvp_deadline,
        city: plan.city,
        vibe: plan.vibe,
        invite_theme: plan.invite_theme,
        invite_message: plan.invite_message,
        cover_color: plan.cover_color,
        guests: plan.guests,
        host_name: plan.owner?.social_profiles?.display_name || plan.owner?.name || 'Host',
        allow_late_rsvp: plan.allow_late_rsvp !== false,
        notes: plan.notes,
      },
      registry_items: plan.registry_items.map((i) => shapeRegistryItem(i, { publicView: true })),
    });
  } catch (err) {
    console.error('event-concierge invite get error', err);
    res.status(500).json({ error: 'Failed to load invitation' });
  }
});

router.post('/invite/:token/rsvp', async (req, res) => {
  try {
    const { status, plus_ones, rsvp_note, name } = req.body;
    const allowed = ['accepted', 'declined', 'maybe'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'status must be accepted, declined, or maybe' });
    }

    const guest = await prisma.event_guest.findUnique({
      where: { invite_token: req.params.token },
      include: {
        event_plan: {
          select: {
            event_plan_id: true,
            owner_id: true,
            title: true,
            status: true,
            rsvp_deadline: true,
            allow_late_rsvp: true,
          },
        },
      },
      ...WITH_INVITE_TOKEN,
    });
    if (!guest || guest.event_plan.status === 'cancelled' || isEventTokenExpired(guest.invite_token_expires_at)) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const plan = guest.event_plan;
    if (plan.rsvp_deadline) {
      const end = new Date(plan.rsvp_deadline);
      end.setUTCHours(23, 59, 59, 999);
      if (Date.now() > end.getTime() && plan.allow_late_rsvp === false) {
        return res.status(400).json({ error: 'RSVP deadline has passed' });
      }
    }

    const updated = await prisma.event_guest.update({
      where: { event_guest_id: guest.event_guest_id },
      data: {
        status,
        plus_ones: Math.max(0, Math.min(10, parseInt(plus_ones ?? guest.plus_ones, 10) || 0)),
        rsvp_note: rsvp_note != null ? String(rsvp_note).slice(0, 500) : guest.rsvp_note,
        name: name?.trim() ? String(name).slice(0, 200) : guest.name,
        responded_at: new Date(),
      },
      ...WITH_INVITE_TOKEN,
    });

    // Host notification (best-effort)
    try {
      const io = req.app.get('io');
      notify(io, {
        userId: plan.owner_id,
        vertical: 'booking',
        type: 'event.rsvp',
        title: `${updated.name} RSVP’d ${status}`,
        body: `${updated.name} responded ${status} for “${plan.title}”`,
        urgency: 'ambient',
        entityType: 'event_plan',
        entityId: plan.event_plan_id,
        actionUrl: 'concierge',
        data: { event_plan_id: plan.event_plan_id, status },
      });
    } catch (nErr) {
      console.error('event-concierge rsvp notify', nErr?.message || nErr);
    }

    res.json({
      event_guest_id: updated.event_guest_id,
      name: updated.name,
      status: updated.status,
      plus_ones: updated.plus_ones,
      rsvp_note: updated.rsvp_note,
      invite_token: updated.invite_token,
      responded_at: updated.responded_at,
    });
  } catch (err) {
    console.error('event-concierge rsvp error', err);
    res.status(500).json({ error: 'Failed to save RSVP' });
  }
});

// ── Public share page (registry + event info) ───────────────────────────────
router.get('/share/:shareToken', optionalAuth, async (req, res) => {
  try {
    const plan = await prisma.event_plan.findUnique({
      where: { share_token: req.params.shareToken },
      include: {
        registry_items: {
          where: { status: { in: ['active', 'funded'] } },
          include: registryInclude,
          orderBy: { created_at: 'desc' },
        },
        owner: {
          select: {
            name: true,
            social_profiles: {
              select: { display_name: true, profile_pic_url: true },
            },
          },
        },
      },
      ...WITH_SHARE_TOKEN,
    });
    if (!plan || plan.status === 'cancelled' || isEventTokenExpired(plan.share_token_expires_at)) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json({
      event: {
        event_plan_id: plan.event_plan_id,
        title: plan.title,
        occasion: plan.occasion,
        event_date: plan.event_date,
        rsvp_deadline: plan.rsvp_deadline,
        city: plan.city,
        vibe: plan.vibe,
        invite_theme: plan.invite_theme,
        invite_message: plan.invite_message,
        cover_color: plan.cover_color,
        host_name: plan.owner?.social_profiles?.display_name || plan.owner?.name || 'Host',
        share_token: plan.share_token,
        notes: plan.notes,
        guests: plan.guests,
        allow_late_rsvp: plan.allow_late_rsvp !== false,
      },
      registry_items: plan.registry_items.map((i) => shapeRegistryItem(i, { publicView: true })),
    });
  } catch (err) {
    console.error('event-concierge share error', err);
    res.status(500).json({ error: 'Failed to load event' });
  }
});

// ── Contribution registry (wishlist-style pitch-in) ─────────────────────────
router.post('/plans/:id/registry', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const gate = await assertOwnsPlan(id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const { title, description, image_url, price, item_type, item_ref_id } = req.body;
    if (!title || !price || parseFloat(price) <= 0) {
      return res.status(400).json({ error: 'title and price are required' });
    }

    const count = await prisma.event_registry_item.count({
      where: { event_plan_id: id, status: { in: ['active', 'funded'] } },
    });
    if (count >= 40) return res.status(400).json({ error: 'Registry limit reached (40 items)' });

    const item = await prisma.event_registry_item.create({
      data: {
        event_plan_id: id,
        title: String(title).slice(0, 500),
        description: description != null ? String(description).slice(0, 2000) : null,
        image_url: image_url || null,
        price: money(price),
        item_type: item_type || 'custom',
        item_ref_id: (() => {
          if (item_ref_id == null || item_ref_id === '') return null;
          const n = parseInt(item_ref_id, 10);
          return Number.isFinite(n) ? n : null;
        })(),
        status: 'active',
      },
    });
    res.status(201).json({
      ...item,
      price: money(item.price),
      total_contributed: 0,
      progress_pct: 0,
      contributor_count: 0,
      recent_contributors: [],
    });
  } catch (err) {
    console.error('event-concierge add registry error', err);
    res.status(500).json({ error: 'Failed to add registry item' });
  }
});

router.delete('/registry/:itemId', authenticateToken, async (req, res) => {
  try {
    const itemId = parseId(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: 'Invalid item id' });
    const item = await prisma.event_registry_item.findUnique({
      where: { registry_item_id: itemId },
      select: { event_plan_id: true, status: true, title: true },
    });
    if (!item) return res.status(404).json({ error: 'Not found' });
    const gate = await assertOwnsPlan(item.event_plan_id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    let gifted_total = 0;
    await prisma.$transaction(async (tx) => {
      const guard = await tx.event_registry_item.updateMany({
        where: {
          registry_item_id: itemId,
          status: { notIn: ['removed', 'claimed'] },
        },
        data: { status: 'removed' },
      });
      if (guard.count === 0) throw Object.assign(new Error('not_removable'), { code: 'not_removable' });

      const agg = await tx.event_registry_contribution.aggregate({
        where: { registry_item_id: itemId, status: 'completed' },
        _sum: { amount: true },
      });
      gifted_total = money(agg._sum.amount);

      if (gifted_total > 0) {
        await creditWallet(tx, gate.plan.owner_id, gifted_total, {
          source: 'event_registry_gift_received',
          description: `Event gifts received: ${item.title}`,
        });
      }
    }, { timeout: 15000 });

    res.json({ success: true, gifted_total });
  } catch (err) {
    if (err.code === 'not_removable') return res.status(400).json({ error: 'Item already removed or claimed' });
    console.error('event-concierge remove registry error', err);
    res.status(500).json({ error: 'Failed to remove registry item' });
  }
});

router.post('/registry/:itemId/contribute', authenticateToken, async (req, res) => {
  try {
    const itemId = parseId(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: 'Invalid item id' });
    const requested_amount = money(req.body.amount);
    const note = req.body.note != null ? String(req.body.note).slice(0, 500) : null;

    if (!Number.isFinite(requested_amount) || requested_amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const item = await prisma.event_registry_item.findUnique({
      where: { registry_item_id: itemId },
      select: { status: true, price: true, title: true, event_plan_id: true },
    });
    if (!item || item.status === 'removed') return res.status(404).json({ error: 'Item not found' });
    if (item.status === 'claimed') return res.status(400).json({ error: 'This item has already been claimed' });

    const plan = await prisma.event_plan.findUnique({
      where: { event_plan_id: item.event_plan_id },
      select: { event_plan_id: true, owner_id: true, share_token: true, status: true, collaborators: true },
    });
    if (!plan || plan.status === 'cancelled') return res.status(404).json({ error: 'Event not found' });

    const access = await assertContributeAccess(plan, req.user.user_id, {
      share_token: req.body.share_token,
      invite_token: req.body.invite_token,
    });
    if (!access.ok) {
      return res.status(403).json({ error: 'Share or invite link required to contribute' });
    }

    const price = money(item.price);
    let final_amount;
    let new_total;
    let fully_funded;

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM event_registry_item WHERE registry_item_id = ${itemId} FOR UPDATE`;

      const locked = await tx.event_registry_item.findUnique({
        where: { registry_item_id: itemId },
        select: { status: true },
      });
      if (locked.status !== 'active') {
        throw Object.assign(new Error('not_active'), { code: 'not_active' });
      }

      const agg = await tx.event_registry_contribution.aggregate({
        where: { registry_item_id: itemId, status: 'completed' },
        _sum: { amount: true },
      });
      const total_so_far = money(agg._sum.amount);
      const remaining = money(price - total_so_far);
      if (remaining <= 0) {
        throw Object.assign(new Error('already_funded'), { code: 'already_funded' });
      }

      final_amount = money(Math.min(requested_amount, remaining));

      const walletDebit = await tx.strug_wallet.updateMany({
        where: {
          user_id: req.user.user_id,
          balance: { gte: final_amount },
          status: 'active',
        },
        data: { balance: { decrement: final_amount } },
      });
      if (walletDebit.count === 0) {
        throw Object.assign(new Error('insufficient_balance'), { code: 'insufficient_balance' });
      }

      await tx.wallet_transaction.create({
        data: {
          user_id: req.user.user_id,
          amount: -final_amount,
          type: 'debit',
          source: 'event_registry_contribution',
          description: `Contribution for event: ${item.title}`,
          status: 'completed',
        },
      });
      await tx.event_registry_contribution.create({
        data: {
          registry_item_id: itemId,
          contributor_id: req.user.user_id,
          amount: final_amount,
          payment_method: 'wallet',
          note,
          status: 'completed',
        },
      });

      new_total = money(total_so_far + final_amount);
      fully_funded = new_total >= price;
      if (fully_funded) {
        await tx.event_registry_item.update({
          where: { registry_item_id: itemId },
          data: { status: 'funded' },
        });
      }
    }, { timeout: 10000 });

    try {
      const io = req.app.get('io');
      notify(io, {
        userId: plan.owner_id,
        vertical: 'booking',
        type: 'event.registry_contribution',
        title: `Contribution toward ${item.title}`,
        body: `Someone contributed $${final_amount.toFixed(2)} to “${item.title}”`,
        urgency: 'ambient',
        entityType: 'event_plan',
        entityId: plan.event_plan_id,
        actionUrl: 'concierge',
        data: { event_plan_id: plan.event_plan_id, registry_item_id: itemId, amount: final_amount },
      });
    } catch (nErr) {
      console.error('event-concierge contribute notify', nErr?.message || nErr);
    }

    res.json({
      success: true,
      contrib_amount: final_amount,
      fully_funded,
      progress_pct: Math.min(100, Math.round((new_total / price) * 100)),
      total_contributed: new_total,
    });
  } catch (err) {
    if (err.code === 'insufficient_balance') return res.status(400).json({ error: 'Insufficient wallet balance' });
    if (err.code === 'already_funded' || err.code === 'not_active') {
      return res.status(400).json({ error: 'This item is no longer accepting contributions' });
    }
    console.error('event-concierge contribute error', err);
    res.status(500).json({ error: 'Failed to contribute' });
  }
});

router.post('/registry/:itemId/claim', authenticateToken, async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId, 10);
    const item = await prisma.event_registry_item.findUnique({
      where: { registry_item_id: itemId },
      select: { event_plan_id: true, status: true, title: true },
    });
    if (!item) return res.status(404).json({ error: 'Not found' });
    const gate = await assertOwnsPlan(item.event_plan_id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });
    if (!gate.isOwner) {
      return res.status(403).json({ error: 'Only the event owner can claim registry funds' });
    }
    if (item.status !== 'funded') {
      return res.status(400).json({ error: 'Item must be fully funded before claiming' });
    }

    let claimed_total = 0;
    await prisma.$transaction(async (tx) => {
      const guard = await tx.event_registry_item.updateMany({
        where: { registry_item_id: itemId, status: 'funded' },
        data: { status: 'claimed' },
      });
      if (guard.count === 0) throw Object.assign(new Error('not_claimable'), { code: 'not_claimable' });

      const agg = await tx.event_registry_contribution.aggregate({
        where: { registry_item_id: itemId, status: 'completed' },
        _sum: { amount: true },
      });
      claimed_total = money(agg._sum.amount);

      if (claimed_total > 0) {
        await creditWallet(tx, gate.plan.owner_id, claimed_total, {
          source: 'event_registry_claim',
          description: `Claimed event registry: ${item.title}`,
        });
      }
    }, { timeout: 15000 });

    res.json({ success: true, claimed_total });
  } catch (err) {
    if (err.code === 'not_claimable') return res.status(400).json({ error: 'Item cannot be claimed' });
    console.error('event-concierge claim error', err);
    res.status(500).json({ error: 'Failed to claim item' });
  }
});

// ── Wedding booking → Event Concierge plan bridge ───────────────────────────
// After a guest pays for a wedding vendor booking, attach it to a wedding plan
// checklist need (create the plan if they don't have one yet).
router.post('/plans/from-wedding-booking', authenticateToken, async (req, res) => {
  try {
    const bookingId = parseId(req.body?.booking_id);
    if (!bookingId) return res.status(400).json({ error: 'booking_id is required' });

    const booking = await prisma.booking.findUnique({
      where: { booking_id: bookingId },
      include: {
        booking_listing: {
          select: {
            booking_listing_id: true,
            title: true,
            vertical: true,
            city: true,
            attributes: true,
            is_active: true,
          },
        },
      },
    });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.guest_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Booking does not belong to you' });
    }
    if (String(booking.vertical || '').toLowerCase() !== 'wedding'
      && String(booking.booking_listing?.vertical || '').toLowerCase() !== 'wedding') {
      return res.status(400).json({ error: 'Only wedding bookings can be added to a wedding plan' });
    }
    if (['cancelled', 'declined'].includes(String(booking.status || '').toLowerCase())) {
      return res.status(400).json({ error: 'Cancelled bookings cannot be added to a plan' });
    }

    // Idempotent: booking already linked to a need the user can access.
    const existingNeed = await prisma.event_need.findFirst({
      where: { booking_id: bookingId },
      include: {
        event_plan: {
          include: {
            needs: { orderBy: { sort_order: 'asc' } },
            guest_list: true,
            registry_items: {
              where: { status: { not: 'removed' } },
              include: registryInclude,
              orderBy: { created_at: 'desc' },
            },
          },
        },
      },
    });
    if (existingNeed?.event_plan) {
      const plan = existingNeed.event_plan;
      const collabs = Array.isArray(plan.collaborators) ? plan.collaborators.map(Number) : [];
      if (plan.owner_id === req.user.user_id || collabs.includes(Number(req.user.user_id))) {
        const shaped = shapePlan(plan, { includeLists: true });
        shaped.is_owner = plan.owner_id === req.user.user_id;
        shaped.attached_need_id = existingNeed.event_need_id;
        shaped.created_plan = false;
        shaped.already_linked = true;
        return res.json(shaped);
      }
    }

    const attrs = booking.booking_listing?.attributes && typeof booking.booking_listing.attributes === 'object'
      ? booking.booking_listing.attributes
      : {};
    const vendorType = attrs.vendor_type || attrs.vendorType || null;
    const needMeta = mapWeddingVendorToNeed(vendorType, {
      listingTitle: booking.booking_listing?.title || null,
    });

    let createdPlan = false;
    let planId = parseId(req.body?.plan_id);
    if (planId) {
      const gate = await assertOwnsPlan(planId, req.user.user_id);
      if (gate.error) return res.status(gate.error).json({ error: gate.message });
    } else {
      const existingPlan = await prisma.event_plan.findFirst({
        where: {
          owner_id: req.user.user_id,
          occasion: 'wedding',
          status: { not: 'cancelled' },
        },
        orderBy: { created_at: 'desc' },
        select: { event_plan_id: true },
      });
      if (existingPlan) {
        planId = existingPlan.event_plan_id;
      } else {
        const eventDate = booking.start_date
          ? parseEventDate(booking.start_date.toISOString().slice(0, 10))
          : null;
        const guestsN = booking.guests != null ? parseInt(booking.guests, 10) : null;
        const city = booking.booking_listing?.city
          ? String(booking.booking_listing.city).slice(0, 100)
          : null;
        const presets = NEED_PRESETS.wedding;
        const registrySeeds = REGISTRY_SEEDS.wedding || [];
        const created = await prisma.event_plan.create({
          data: {
            owner_id: req.user.user_id,
            title: 'My Wedding',
            occasion: 'wedding',
            event_date: eventDate,
            guests: Number.isFinite(guestsN) ? guestsN : null,
            city,
            share_token: token(),
            share_token_expires_at: eventTokenExpiresAt(),
            needs: {
              create: presets.map((n, i) => ({
                category: n.category,
                title: n.title,
                linked_nav: n.linked_nav,
                sort_order: i,
                status: 'todo',
              })),
            },
            registry_items: registrySeeds.length
              ? {
                  create: registrySeeds.map((r) => ({
                    title: r.title,
                    description: r.description,
                    price: r.price,
                    item_type: 'custom',
                    status: 'active',
                  })),
                }
              : undefined,
          },
          select: { event_plan_id: true },
        });
        planId = created.event_plan_id;
        createdPlan = true;
      }
    }

    const planNeeds = await prisma.event_need.findMany({
      where: { event_plan_id: planId },
      orderBy: { sort_order: 'asc' },
    });
    let targetNeed = pickNeedForWeddingVendor(planNeeds, needMeta.category);

    const noteBits = [
      `Linked from Wedding booking #${bookingId}`,
      booking.start_date ? `Event date ${booking.start_date.toISOString().slice(0, 10)}` : null,
    ].filter(Boolean);
    const linkNote = noteBits.join(' · ').slice(0, 5000);

    if (targetNeed) {
      await prisma.event_need.update({
        where: { event_need_id: targetNeed.event_need_id },
        data: {
          booking_id: bookingId,
          linked_listing_id: booking.booking_listing_id,
          linked_listing_title: (booking.booking_listing?.title || needMeta.title).slice(0, 300),
          linked_nav: targetNeed.linked_nav || needMeta.linked_nav,
          status: 'booked',
          notes: targetNeed.notes
            ? `${String(targetNeed.notes).slice(0, 4500)}\n${linkNote}`.slice(0, 5000)
            : linkNote,
          ...(booking.total != null && Number.isFinite(Number(booking.total)) && targetNeed.target_budget == null
            ? { target_budget: money(booking.total) }
            : {}),
        },
      });
    } else {
      const maxSort = await prisma.event_need.aggregate({
        where: { event_plan_id: planId },
        _max: { sort_order: true },
      });
      targetNeed = await prisma.event_need.create({
        data: {
          event_plan_id: planId,
          category: needMeta.category.slice(0, 40),
          title: needMeta.title.slice(0, 200),
          linked_nav: needMeta.linked_nav,
          linked_listing_id: booking.booking_listing_id,
          linked_listing_title: (booking.booking_listing?.title || needMeta.title).slice(0, 300),
          booking_id: bookingId,
          status: 'booked',
          notes: linkNote,
          sort_order: (maxSort._max.sort_order ?? -1) + 1,
          ...(booking.total != null && Number.isFinite(Number(booking.total))
            ? { target_budget: money(booking.total) }
            : {}),
        },
      });
    }

    // Fill empty plan fields from the booking when helpful.
    const planPatch = {};
    const planRow = await prisma.event_plan.findUnique({
      where: { event_plan_id: planId },
      select: { event_date: true, guests: true, city: true, occasion: true },
    });
    if (planRow) {
      if (!planRow.event_date && booking.start_date) {
        planPatch.event_date = parseEventDate(booking.start_date.toISOString().slice(0, 10));
      }
      if (planRow.guests == null && booking.guests != null) {
        const g = parseInt(booking.guests, 10);
        if (Number.isFinite(g)) planPatch.guests = g;
      }
      if (!planRow.city && booking.booking_listing?.city) {
        planPatch.city = String(booking.booking_listing.city).slice(0, 100);
      }
      if (Object.keys(planPatch).length) {
        await prisma.event_plan.update({
          where: { event_plan_id: planId },
          data: planPatch,
        });
      }
    }

    const plan = await prisma.event_plan.findUnique({
      where: { event_plan_id: planId },
      include: ownerPlanInclude(registryInclude),
      ...WITH_SHARE_TOKEN,
    });
    const shaped = shapePlan(plan, { includeLists: true });
    shaped.is_owner = plan.owner_id === req.user.user_id;
    shaped.attached_need_id = targetNeed.event_need_id;
    shaped.created_plan = createdPlan;
    shaped.already_linked = false;
    res.status(createdPlan ? 201 : 200).json(shaped);
  } catch (err) {
    console.error('event-concierge from-wedding-booking error', err);
    res.status(500).json({ error: 'Failed to add booking to wedding plan' });
  }
});

// ── Shared Event (v1): one date/guests/city, one cart, one checkout, one timeline ──
// Built on the same event_plan / event_need tables; invites/registry are just not
// surfaced by the Shared Event UI.

/**
 * Load the saved Shared Event cart + the buyer's country/currency and build the
 * ordered list of card charges (each under the market's per-transaction limit).
 * The plan has no country column, so we take it from the owner's profile.
 */
async function resolveEventPaymentPlan(planId, ownerId, cartOverride) {
  const [plan, owner] = await Promise.all([
    cartOverride !== undefined
      ? Promise.resolve(null)
      : prisma.event_plan.findUnique({
        where: { event_plan_id: planId },
        select: { package_json: true },
      }),
    prisma.user.findUnique({
      where: { user_id: ownerId },
      select: { country: true, currency: true },
    }),
  ]);
  const cart = cartOverride !== undefined
    ? cartOverride
    : (plan?.package_json && typeof plan.package_json === 'object' && !Array.isArray(plan.package_json)
      ? plan.package_json.cart
      : null);
  return buildEventPaymentPlan({
    cart: cart || {},
    country: owner?.country || null,
    currency: owner?.currency || 'CAD',
  });
}

/** Persist the Shared Event cart (venue / catering / floral selections) on the plan. */
router.patch('/plans/:id/cart', authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertOwnsPlan(id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const incoming = req.body && typeof req.body === 'object' ? req.body : {};
    const cart = {};
    for (const key of SHARE_CATEGORIES) {
      const line = incoming[key];
      if (line == null) continue;
      if (typeof line !== 'object') return res.status(400).json({ error: `Invalid ${key} line` });
      // Store only what the checkout needs to re-create the order — keep it small + bounded.
      cart[key] = {
        listing_id: line.listing_id != null ? parseInt(line.listing_id, 10) || null : null,
        vendor_id: line.vendor_id != null ? parseInt(line.vendor_id, 10) || null : null,
        seller_id: line.seller_id != null ? parseInt(line.seller_id, 10) || null : null,
        title: line.title != null ? String(line.title).slice(0, 300) : null,
        line_total: Number.isFinite(Number(line.line_total)) ? Number(line.line_total) : null,
        items: Array.isArray(line.items) ? line.items.slice(0, 100) : undefined,
      };
    }

    const plan = await prisma.event_plan.findUnique({
      where: { event_plan_id: id },
      select: { package_json: true },
    });
    const pkg = plan?.package_json && typeof plan.package_json === 'object' && !Array.isArray(plan.package_json)
      ? { ...plan.package_json }
      : {};
    pkg.cart = cart;

    const updated = await prisma.event_plan.update({
      where: { event_plan_id: id },
      data: { package_json: pkg },
      select: { package_json: true },
    });
    const savedCart = updated.package_json?.cart ?? {};
    // Return the payment plan alongside the cart so the checkout knows up front
    // whether this total has to be taken as several card charges (Canada caps a
    // single online card transaction at CA$1,500, etc.).
    const payment_plan = await resolveEventPaymentPlan(id, req.user.user_id, savedCart);
    res.json({ cart: savedCart, payment_plan });
  } catch (err) {
    console.error('event-concierge cart error', err);
    res.status(500).json({ error: 'Failed to save event cart' });
  }
});

/**
 * The Shared Event "one checkout" as an ordered list of card charges. Each segment
 * stays under the buyer market's per-transaction online-card limit; a single piece
 * over the cap (a whole venue, say) is split into equal installments. The frontend
 * runs create-intent → confirm for each segment in order, then links the resulting
 * orders with POST /plans/:id/link-order.
 */
router.get('/plans/:id/payment-plan', authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertOwnsPlan(id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const payment_plan = await resolveEventPaymentPlan(id, req.user.user_id);
    if (!payment_plan.segments.length) {
      return res.status(400).json({ error: 'No saved event cart to pay for', payment_plan });
    }
    res.json(payment_plan);
  } catch (err) {
    console.error('event-concierge payment-plan error', err);
    res.status(500).json({ error: 'Failed to build event payment plan' });
  }
});

/**
 * Link a just-paid order to its Shared Event need and flip it to "booked".
 * Body: { category: 'venue'|'catering'|'floral', kind: 'booking'|'food_order', ref_id }
 */
router.post('/plans/:id/link-order', authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertOwnsPlan(id, req.user.user_id);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const result = await linkOrderToPlan({
      db: prisma,
      planId: id,
      ownerId: req.user.user_id,
      category: req.body?.category,
      kind: req.body?.kind,
      refId: req.body?.ref_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({
      ...result.need,
      target_budget: result.need.target_budget != null ? money(result.need.target_budget) : null,
    });
  } catch (err) {
    console.error('event-concierge link-order error', err);
    res.status(500).json({ error: 'Failed to link order to event' });
  }
});

/**
 * Customer-facing "host timeline": the venue / catering / floral pieces with each
 * one's live status (booked | pending | unpaid | cancelled | unlinked).
 */
router.get('/plans/:id/timeline', authenticateToken, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const gate = await assertOwnsPlan(id, req.user.user_id, { allowCancelled: true });
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const plan = await prisma.event_plan.findUnique({
      where: { event_plan_id: id },
      select: {
        event_plan_id: true, title: true, occasion: true, event_date: true,
        guests: true, city: true, status: true,
        needs: { orderBy: { sort_order: 'asc' } },
      },
    });

    const bookingIds = [];
    const orderIds = [];
    for (const n of plan.needs) {
      if (n.linked_order_kind === 'booking' && n.linked_order_id) bookingIds.push(n.linked_order_id);
      else if (n.linked_order_kind === 'food_order' && n.linked_order_id) orderIds.push(n.linked_order_id);
      else if (n.booking_id) bookingIds.push(n.booking_id);
    }
    const [bookings, orders] = await Promise.all([
      bookingIds.length
        ? prisma.booking.findMany({
          where: { booking_id: { in: bookingIds } },
          select: {
            booking_id: true, status: true, payment_status: true, payment_intent_id: true,
            total: true, start_date: true, guests: true,
            booking_listing: { select: { title: true } },
          },
        })
        : [],
      orderIds.length
        ? prisma.food_order.findMany({
          where: { food_order_id: { in: orderIds } },
          select: {
            food_order_id: true, order_status: true, ispaid: true, payment_intent_id: true,
            total_amount: true,
          },
        })
        : [],
    ]);
    const bookingById = new Map(bookings.map((b) => [b.booking_id, b]));
    const orderById = new Map(orders.map((o) => [o.food_order_id, o]));

    const pieces = SHARE_CATEGORIES.map((category) => {
      const need = pickNeedForCategory(plan.needs, category);
      if (!need) return { category, status: 'unlinked', need_id: null, title: null, nav: category === 'venue' ? 'venues' : category };
      const kind = need.linked_order_kind || (need.booking_id ? 'booking' : null);
      const refId = need.linked_order_id || need.booking_id || null;
      const booking = kind === 'booking' ? bookingById.get(refId) : null;
      const foodOrder = kind === 'food_order' ? orderById.get(refId) : null;
      const status = refId ? resolveTimelineStatus({ kind, booking, foodOrder }) : 'unlinked';
      return {
        category,
        need_id: need.event_need_id,
        title: need.linked_listing_title || need.title,
        nav: need.linked_nav || (category === 'venue' ? 'venues' : category),
        kind,
        ref_id: refId,
        status,
        total: booking?.total ?? foodOrder?.total_amount ?? need.target_budget ?? null,
      };
    });

    const hangingFrom = pieces.some((p) => p.status === 'cancelled')
      && pieces.some((p) => p.status === 'booked' || p.status === 'pending');

    res.json({
      event_plan_id: plan.event_plan_id,
      title: plan.title,
      occasion: plan.occasion,
      event_date: plan.event_date,
      guests: plan.guests,
      city: plan.city,
      status: plan.status,
      hanging: hangingFrom,
      pieces,
    });
  } catch (err) {
    console.error('event-concierge timeline error', err);
    res.status(500).json({ error: 'Failed to load event timeline' });
  }
});

export default router;
