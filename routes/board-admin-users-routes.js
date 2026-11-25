// routes/board-admin-users-routes.js
//
// Read-only User Management data for the internal dashboards (strug-internal-
// dashboards). Gated by the board identity + the can_view_users capability
// (member-managers implicitly qualify) — see middleware/authenticate-board.js.
//
// Mounted at /board-admin/users. ALL endpoints are READ-ONLY: no suspend/ban/
// restrict here (the `user` model has no status columns; ban/shadow-ban live on
// social_profile and are handled by the existing admin_routes for app admins).
//
//   GET  /board-admin/users            list (paginate / search / filter)
//   GET  /board-admin/users/stats      counts, role breakdown, registration growth
//   GET  /board-admin/users/geo        counts by country + top cities
//   GET  /board-admin/users/:id        single user detail (+ profile + wallet summary)
//   GET  /board-admin/users/:id/wallet wallet overview + recent transactions
//   GET  /board-admin/users/:id/referrals  the user's referral code, referees, referrer
//
// Registration time: the `user` model has no created_at — `social_profile.created_at`
// is the registration proxy (users without a social profile are excluded from the
// growth series; noted in the response).

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import { decrypt } from '../utils/crypto.js';
import { syncUserAlerts } from '../services/user-alerts.js';
import { recordActivity } from '../services/activity-log.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('user-management', 'read'));

// Well-known account-status values (Tier C). 'restricted' is a soft flag (sign-in still
// allowed); 'suspended'/'banned' block sign-in (enforced in middleware/authentication.js).
const ACCOUNT_STATUSES = ['active', 'restricted', 'suspended', 'banned'];

// Decimal → Number for clean JSON (Prisma serializes Decimal as a string otherwise).
const num = (d) => (d == null ? 0 : Number(d));

// user.email is stored ENCRYPTED at rest (deterministic AES via encryptSearch). The DB
// returns ciphertext, so this board endpoint — which IS authorized to see emails
// (authenticateBoard + requireViewUsers) — must decrypt for display. Only attempt decrypt on
// hex-looking ciphertext, so any legacy/plaintext rows (e.g. seed data) pass through unchanged
// and a decrypt failure never blanks the field.
const looksEncrypted = (v) => typeof v === 'string' && v.length >= 32 && v.length % 2 === 0 && /^[0-9a-f]+$/i.test(v);
const decryptEmail = (v) => {
  if (!looksEncrypted(v)) return v;
  try { return decrypt(v); } catch { return v; }
};
// Decrypt an embedded { ...user, email } object in place-safe fashion.
const withEmail = (u) => (u ? { ...u, email: decryptEmail(u.email) } : u);

const PROFILE_SUMMARY = {
  profile_id: true,
  handle: true,
  display_name: true,
  profile_pic_url: true,
  is_verified: true,
  verification_type: true,
  is_banned: true,
  is_shadow_banned: true,
  created_at: true,
};

// ─── LIST ──────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const { search = '', role, verified, banned, seller, creator, provider, registeredDays,
            driver, delivery, professional, personal, status, forceLoggedOut, tag } = req.query;

    const AND = [];
    if (search) {
      // email is encrypted at rest, so a SQL `contains` can't match a plaintext fragment.
      // Resolve email matches in-app instead: decrypt every email and collect the matching
      // user_ids, then let the DB filter+paginate on `user_id IN (...)`. Cheap at this scale
      // (a few hundred id+email rows); revisit with a blind index if the user base grows large.
      const term = String(search).toLowerCase();
      const allEmails = await prisma.user.findMany({ select: { user_id: true, email: true } });
      const emailMatchIds = allEmails
        .filter((u) => decryptEmail(u.email)?.toLowerCase().includes(term))
        .map((u) => u.user_id);

      const or = [
        { username: { contains: search, mode: 'insensitive' } },
        // Partial + exact email match via the pre-resolved id set (covers encrypted rows);
        // the plaintext contains is a harmless fallback for any legacy unencrypted rows.
        { user_id: { in: emailMatchIds } },
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { ref_code: { contains: search, mode: 'insensitive' } },
        { social_profiles: { OR: [
          { handle: { contains: search, mode: 'insensitive' } },
          { display_name: { contains: search, mode: 'insensitive' } },
        ] } },
      ];
      const asId = parseInt(search);
      if (!Number.isNaN(asId) && String(asId) === String(search).trim()) {
        or.push({ user_id: asId });
      }
      AND.push({ OR: or });
    }
    if (role) AND.push({ role });
    if (verified === 'true' || verified === 'false') {
      // social_profiles is a to-ONE relation — filter its fields directly (no `some`/`every`).
      AND.push({ social_profiles: { is_verified: verified === 'true' } });
    }
    if (banned === 'true' || banned === 'false') {
      AND.push({ social_profiles: { is_banned: banned === 'true' } });
    }
    // Role-segment filters. `is_seller`/`is_creator` are the only role flags the
    // `user` model carries, so "Merchants" maps to is_seller. "Providers" is kept
    // DISTINCT (not a second is_seller view) by matching the service/vendor
    // relations instead — users who actually have a provider/vendor presence.
    if (seller === 'true' || seller === 'false') AND.push({ is_seller: seller === 'true' });
    if (creator === 'true' || creator === 'false') AND.push({ is_creator: creator === 'true' });
    if (provider === 'true') {
      AND.push({ OR: [
        { user_service_provider: { some: {} } },
        { appointment_service_providers: { some: {} } },
        { calm_providers: { some: {} } },
        { driver_profile: { some: { driver_courier_profile: { isNot: null } } } },
        { food_vendor: { some: {} } },
        { loan_provider: { some: {} } },
        { quote_providers: { some: {} } },
      ] });
    }
    // Role segments (USER ROLES & SEGMENTS). Each matches a distinct vertical relation,
    // mirroring the Providers approach (the user row carries no per-role flag for these).
    // driver_profile is now the shared identity for rideshare/delivery/courier, so "rideshare
    // driver" needs its own signal (vehicle/license/trip history) rather than mere row existence —
    // a delivery- or courier-only account also gets a driver_profile row post-unification.
    if (driver === 'true') AND.push({ driver_profile: { some: { OR: [
      { vehicle: { some: {} } },
      { license_number: { not: null } },
      { active_trip: { some: {} } },
    ] } } });
    if (delivery === 'true') AND.push({ OR: [
      { driver_profile: { some: { driver_courier_profile: { isNot: null } } } },
      { driver_profile: { some: { driver_delivery_profile: { isNot: null } } } },
    ] });
    if (professional === 'true') AND.push({ professional_profile: { some: {} } });
    // Personal user = a plain account: no seller/creator flag and no provider/vertical role.
    if (personal === 'true') AND.push({ role: 'USER', is_seller: false, is_creator: false });
    // Account-status segments (ACCOUNT STATUS & CONTROLS → Restrictions/Suspensions/Bans).
    if (status && ACCOUNT_STATUSES.includes(status)) AND.push({ account_status: status });
    // Force-logged-out population (sessions invalidated, but not necessarily suspended).
    if (forceLoggedOut === 'true') AND.push({ sessions_invalidated_at: { not: null } });
    // Tag-based segments (INTERNAL NOTES & TAGS → VIP / Watchlist / Priority / High Risk / custom).
    if (tag) AND.push({ user_tags: { some: { tag: String(tag) } } });
    // New Registrations — joined within the last N days (social_profile.created_at
    // is the registration proxy; users without a profile are excluded, same as /stats).
    const regDays = parseInt(registeredDays);
    if (!Number.isNaN(regDays) && regDays > 0) {
      const cutoff = new Date(Date.now() - regDays * 24 * 60 * 60 * 1000);
      AND.push({ social_profiles: { created_at: { gte: cutoff } } });
    }
    // Active / Inactive — by last recorded activity (user_activity_event). NOTE:
    // login events are newly instrumented, so today this mostly reflects signup
    // recency (backfilled) and becomes truer as logins accrue.
    const activeDays = parseInt(req.query.activeWithin);
    if (!Number.isNaN(activeDays) && activeDays > 0) {
      const cutoff = new Date(Date.now() - activeDays * 24 * 60 * 60 * 1000);
      AND.push({ user_activity_event: { some: { created_at: { gte: cutoff } } } });
    }
    const inactiveDays = parseInt(req.query.inactiveSince);
    if (!Number.isNaN(inactiveDays) && inactiveDays > 0) {
      const cutoff = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000);
      // No activity at all in the window (includes users with no events whatsoever).
      AND.push({ user_activity_event: { none: { created_at: { gte: cutoff } } } });
    }
    // Soft-delete: exclude deleted accounts by default; `deleted=true` shows only
    // them (Deleted Users), `deleted=all` includes both.
    const { deleted } = req.query;
    if (deleted === 'true') AND.push({ deleted_at: { not: null } });
    else if (deleted !== 'all') AND.push({ deleted_at: null });
    const where = AND.length ? { AND } : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { user_id: 'desc' },
        select: {
          user_id: true,
          name: true,
          email: true,
          username: true,
          role: true,
          country: true,
          city: true,
          is_seller: true,
          is_creator: true,
          ref_code: true,
          deleted_at: true,
          account_status: true,
          social_profiles: { select: PROFILE_SUMMARY },
          // Last recorded activity (for the Active/Inactive "Last active" column).
          user_activity_event: { take: 1, orderBy: { created_at: 'desc' }, select: { created_at: true, type: true } },
          // Tags for the directory tag chips (cheap — usually 0–few rows per user).
          user_tags: { select: { tag: true, color: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      users: users.map(withEmail),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[board-admin/users] list error:', err);
    res.status(500).json({ successful: false, message: 'Could not load users' });
  }
});

// ─── STATS (counts + role breakdown + registration growth) ──────────────────────
router.get('/stats', async (req, res) => {
  try {
    const days = Math.min(180, Math.max(7, parseInt(req.query.days) || 30));
    // Compute the cutoff in JS and bind it as a timestamp — avoids SQL interval
    // arithmetic (Prisma binds the number as bigint, which make_interval rejects).
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [total, sellers, creators, verified, banned, withProfile, byRoleRaw, registrations] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { is_seller: true } }),
      prisma.user.count({ where: { is_creator: true } }),
      prisma.user.count({ where: { social_profiles: { is_verified: true } } }),
      prisma.user.count({ where: { social_profiles: { is_banned: true } } }),
      prisma.user.count({ where: { social_profiles: { isNot: null } } }),
      prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
      // Registration growth — social_profile.created_at is the proxy (see header).
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', "created_at"), 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS count
        FROM "social_profile"
        WHERE "created_at" >= ${cutoff}
        GROUP BY 1
        ORDER BY 1
      `,
    ]);

    const byRole = byRoleRaw.map((r) => ({ role: r.role, count: r._count._all }));

    res.json({
      totalUsers: total,
      sellers,
      creators,
      verified,
      banned,
      withProfile, // users that have a social_profile (the registration-trackable base)
      byRole,
      registrations, // [{ date, count }] — proxy = social_profile.created_at
      registrationNote: 'Registration timeline uses social_profile.created_at; users without a social profile are excluded.',
    });
  } catch (err) {
    console.error('[board-admin/users] stats error:', err);
    res.status(500).json({ successful: false, message: 'Could not load user stats' });
  }
});

// ─── GEO (by country + top cities) ───────────────────────────────────────────────
// `user.country`/`user.city` are sparse legacy fields (almost always NULL). The
// real location is in `user_address` (entered at checkout/delivery). So we resolve
// ONE country/city per user — their default address, falling back to the user row —
// and report how many users have NO location at all, so the breakdown can't be
// mistaken for the whole user base.
router.get('/geo', async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT
        COALESCE(NULLIF(btrim(addr.country), ''), NULLIF(btrim(u.country), '')) AS country,
        COALESCE(NULLIF(btrim(addr.city), ''),    NULLIF(btrim(u.city), ''))    AS city
      FROM "user" u
      LEFT JOIN LATERAL (
        SELECT a.country, a.city
        FROM "user_address" a
        WHERE a.user_id = u.user_id
        ORDER BY a.is_default DESC, a.address_id ASC
        LIMIT 1
      ) addr ON true
    `;

    const totalUsers = rows.length;
    const countryCounts = new Map();
    const cityCounts = new Map();
    let unknownCountry = 0;

    for (const r of rows) {
      if (r.country) countryCounts.set(r.country, (countryCounts.get(r.country) || 0) + 1);
      else unknownCountry++;
      if (r.city) cityCounts.set(r.city, (cityCounts.get(r.city) || 0) + 1);
    }

    const toSorted = (m) =>
      [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

    res.json({
      totalUsers,
      unknownCountry,
      byCountry: toSorted(countryCounts),
      topCities: toSorted(cityCounts).slice(0, 15),
    });
  } catch (err) {
    console.error('[board-admin/users] geo error:', err);
    res.status(500).json({ successful: false, message: 'Could not load geo breakdown' });
  }
});

// ─── ACTIVITY FEED (Live Activity) ──────────────────────────────────────────────
// Recent user-activity events (signup / login / failed-login) from
// user_activity_event. Defined BEFORE '/:id' so '/activity' isn't captured as an id.
router.get('/activity', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const skip = (page - 1) * limit;
    const { type } = req.query;
    const userId = parseInt(req.query.user_id);

    const where = {};
    if (type) where.type = type;
    if (!Number.isNaN(userId)) where.user_id = userId;

    const [events, total, typeGroups] = await Promise.all([
      prisma.user_activity_event.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        select: {
          event_id: true,
          type: true,
          description: true,
          ip_address: true,
          source: true,
          created_at: true,
          user: { select: { user_id: true, name: true, username: true, email: true } },
        },
      }),
      prisma.user_activity_event.count({ where }),
      // Type breakdown (ignores the user filter so the legend is stable; honors `type`-less view).
      prisma.user_activity_event.groupBy({ by: ['type'], _count: { _all: true } }),
    ]);

    res.json({
      events: events.map((e) => ({ ...e, user: withEmail(e.user) })),
      byType: typeGroups.map((t) => ({ type: t.type, count: t._count._all })).sort((a, b) => b.count - a.count),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[board-admin/users] activity error:', err);
    res.status(500).json({ successful: false, message: 'Could not load activity feed' });
  }
});

// ─── ALERTS & WARNINGS ──────────────────────────────────────────────────────────
// Risk/attention alerts derived from existing signals (banned / shadow-banned /
// wallet). Reconciled on read so the view always reflects current conditions; a
// sync failure still returns the persisted alerts. Defined before '/:id'.
router.get('/alerts', async (req, res) => {
  try {
    let synced = false;
    try { await syncUserAlerts(); synced = true; }
    catch (e) { console.error('[board-admin/users] alert sync failed (serving persisted):', e?.message || e); }

    const { status, severity, type } = req.query;
    const where = {};
    if (status) where.status = status;
    if (severity) where.severity = severity;
    if (type) where.type = type;

    const [alerts, byStatus, bySeverity] = await Promise.all([
      prisma.user_alert.findMany({
        where,
        orderBy: [{ status: 'asc' }, { severity: 'asc' }, { updated_at: 'desc' }],
        take: 500,
        select: {
          alert_id: true, type: true, severity: true, message: true, status: true,
          created_at: true, updated_at: true,
          user: { select: { user_id: true, name: true, username: true, email: true } },
        },
      }),
      prisma.user_alert.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.user_alert.groupBy({ by: ['severity'], where: { status: { not: 'resolved' } }, _count: { _all: true } }),
    ]);

    res.json({
      synced,
      alerts: alerts.map((a) => ({ ...a, user: withEmail(a.user) })),
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      bySeverity: bySeverity.map((s) => ({ severity: s.severity, count: s._count._all })),
    });
  } catch (err) {
    console.error('[board-admin/users] alerts error:', err);
    res.status(500).json({ successful: false, message: 'Could not load alerts' });
  }
});

// Acknowledge / resolve / re-open an alert (manual triage).
router.patch('/alerts/:alertId', requireDashboard('user-management', 'write'), async (req, res) => {
  try {
    const alertId = parseInt(req.params.alertId);
    if (Number.isNaN(alertId)) return res.status(400).json({ successful: false, message: 'Invalid alert id' });
    const { status } = req.body || {};
    const ALLOWED = ['open', 'acknowledged', 'resolved'];
    if (!ALLOWED.includes(status)) {
      return res.status(400).json({ successful: false, message: `status must be one of ${ALLOWED.join(', ')}` });
    }
    const updated = await prisma.user_alert.update({
      where: { alert_id: alertId },
      data: { status },
      select: { alert_id: true, status: true },
    }).catch(() => null);
    if (!updated) return res.status(404).json({ successful: false, message: 'Alert not found' });
    res.json({ successful: true, alert: updated });
  } catch (err) {
    console.error('[board-admin/users] alert update error:', err);
    res.status(500).json({ successful: false, message: 'Could not update alert' });
  }
});

// ─── PASSWORD RESET REQUESTS (AUTH & ACCESS) ────────────────────────────────────
// password_reset_tokens has no Prisma relation to user (bare user_id), so join in-app.
router.get('/password-resets', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const skip = (page - 1) * limit;

    const [tokens, total] = await Promise.all([
      prisma.password_reset_tokens.findMany({ skip, take: limit, orderBy: { created_at: 'desc' } }),
      prisma.password_reset_tokens.count(),
    ]);
    const userIds = [...new Set(tokens.map((t) => t.user_id))];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { user_id: { in: userIds } }, select: { user_id: true, name: true, username: true, email: true } })
      : [];
    const byId = new Map(users.map((u) => [u.user_id, withEmail(u)]));

    const now = Date.now();
    res.json({
      requests: tokens.map((t) => ({
        id: t.id,
        user: byId.get(t.user_id) || { user_id: t.user_id },
        email: decryptEmail(t.email),
        created_at: t.created_at,
        expires_at: t.expires_at,
        status: t.used ? 'used' : (new Date(t.expires_at).getTime() < now ? 'expired' : 'pending'),
      })),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[board-admin/users] password-resets error:', err);
    res.status(500).json({ successful: false, message: 'Could not load password reset requests' });
  }
});

// ─── VERIFICATION TYPES (VERIFICATION VISIBILITY → Linked Verification Types) ────
router.get('/verification-types', async (_req, res) => {
  try {
    const [byType, verifiedTotal, profilesTotal] = await Promise.all([
      prisma.social_profile.groupBy({ by: ['verification_type'], _count: { _all: true } }),
      prisma.social_profile.count({ where: { is_verified: true } }),
      prisma.social_profile.count(),
    ]);
    res.json({
      verifiedTotal,
      profilesTotal,
      byType: byType
        .map((t) => ({ type: t.verification_type || 'NONE', count: t._count._all }))
        .sort((a, b) => b.count - a.count),
    });
  } catch (err) {
    console.error('[board-admin/users] verification-types error:', err);
    res.status(500).json({ successful: false, message: 'Could not load verification types' });
  }
});

// ─── REFERRAL SYSTEM (overview + paginated usage) ───────────────────────────────
router.get('/referrals/overview', async (_req, res) => {
  try {
    const [usageGroups, totalShares, usersWithCode] = await Promise.all([
      prisma.shared_ref_code.groupBy({ by: ['ref_code'], _count: { _all: true }, where: { ref_code: { not: null } } }),
      prisma.shared_ref_code.count(),
      prisma.user.count({ where: { ref_code: { not: null } } }),
    ]);
    // Resolve the top referrers' user rows for display.
    const top = [...usageGroups].sort((a, b) => b._count._all - a._count._all).slice(0, 15);
    const codes = top.map((g) => g.ref_code);
    const owners = codes.length
      ? await prisma.user.findMany({ where: { ref_code: { in: codes } }, select: { user_id: true, name: true, username: true, email: true, ref_code: true } })
      : [];
    const ownerByCode = new Map(owners.map((o) => [o.ref_code, withEmail(o)]));
    res.json({
      totalShares,
      usersWithCode,
      activeReferrers: usageGroups.length,
      topReferrers: top.map((g) => ({ ref_code: g.ref_code, referredCount: g._count._all, owner: ownerByCode.get(g.ref_code) || null })),
    });
  } catch (err) {
    console.error('[board-admin/users] referrals/overview error:', err);
    res.status(500).json({ successful: false, message: 'Could not load referral overview' });
  }
});

router.get('/referrals/list', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      prisma.shared_ref_code.findMany({
        skip, take: limit, orderBy: { share_id: 'desc' },
        select: {
          share_id: true, ref_code: true, shared_to: true,
          user_shared_ref_code_ref_codeTouser: { select: { user_id: true, name: true, username: true, email: true } },
          user_shared_ref_code_shared_toTouser: { select: { user_id: true, name: true, username: true, email: true } },
        },
      }),
      prisma.shared_ref_code.count(),
    ]);
    res.json({
      usage: rows.map((r) => ({
        share_id: r.share_id,
        ref_code: r.ref_code,
        referrer: withEmail(r.user_shared_ref_code_ref_codeTouser),
        referee: withEmail(r.user_shared_ref_code_shared_toTouser),
      })),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[board-admin/users] referrals/list error:', err);
    res.status(500).json({ successful: false, message: 'Could not load referral usage' });
  }
});

// ─── AUDIT LOG (social_audit_log — admin/compliance actions) ─────────────────────
router.get('/audit', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const skip = (page - 1) * limit;
    const [logs, total] = await Promise.all([
      prisma.social_audit_log.findMany({
        skip, take: limit, orderBy: { created_at: 'desc' },
        select: { log_id: true, admin_id: true, profile_id: true, action: true, description: true, ip_address: true, created_at: true },
      }),
      prisma.social_audit_log.count(),
    ]);
    res.json({
      logs,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      note: 'Audit entries come from social_audit_log (currently data-export + ads-manager actions). admin_id is not yet populated by the writers.',
    });
  } catch (err) {
    console.error('[board-admin/users] audit error:', err);
    res.status(500).json({ successful: false, message: 'Could not load audit log' });
  }
});

// ─── PROFILE HISTORY FEED (USER PROFILES → history sections) ────────────────────
router.get('/history', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const skip = (page - 1) * limit;
    const { field } = req.query;
    const where = {};
    // Username History groups handle+username; the others map 1:1.
    if (field === 'username') where.field = { in: ['handle', 'username'] };
    else if (field) where.field = field;

    const [rows, total, byField] = await Promise.all([
      prisma.user_profile_history.findMany({
        where, skip, take: limit, orderBy: { created_at: 'desc' },
        select: {
          history_id: true, field: true, old_value: true, new_value: true, changed_by: true, created_at: true,
          user: { select: { user_id: true, name: true, username: true, email: true } },
        },
      }),
      prisma.user_profile_history.count({ where }),
      prisma.user_profile_history.groupBy({ by: ['field'], _count: { _all: true } }),
    ]);
    res.json({
      history: rows.map((r) => ({ ...r, user: withEmail(r.user) })),
      byField: byField.map((f) => ({ field: f.field, count: f._count._all })),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[board-admin/users] history error:', err);
    res.status(500).json({ successful: false, message: 'Could not load profile history' });
  }
});

// ─── TAGS: summary + tagged-users directory + recent notes feed ─────────────────
router.get('/tags/summary', async (_req, res) => {
  try {
    const byTag = await prisma.user_tag.groupBy({ by: ['tag'], _count: { _all: true } });
    res.json({ byTag: byTag.map((t) => ({ tag: t.tag, count: t._count._all })).sort((a, b) => b.count - a.count) });
  } catch (err) {
    console.error('[board-admin/users] tags/summary error:', err);
    res.status(500).json({ successful: false, message: 'Could not load tag summary' });
  }
});

router.get('/notes', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const skip = (page - 1) * limit;
    const [notes, total] = await Promise.all([
      prisma.user_note.findMany({
        skip, take: limit, orderBy: [{ pinned: 'desc' }, { created_at: 'desc' }],
        select: {
          note_id: true, body: true, pinned: true, author_name: true, created_at: true, updated_at: true,
          user: { select: { user_id: true, name: true, username: true, email: true } },
        },
      }),
      prisma.user_note.count(),
    ]);
    res.json({
      notes: notes.map((n) => ({ ...n, user: withEmail(n.user) })),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[board-admin/users] notes feed error:', err);
    res.status(500).json({ successful: false, message: 'Could not load notes' });
  }
});

// ─── DETAIL ──────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (Number.isNaN(userId)) return res.status(400).json({ successful: false, message: 'Invalid user id' });

    const user = await prisma.user.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        name: true,
        email: true,
        username: true,
        role: true,
        currency: true,
        country: true,
        city: true,
        ref_code: true,
        language: true,
        is_seller: true,
        is_creator: true,
        has_seen_welcome: true,
        account_status: true,
        status_reason: true,
        status_changed_at: true,
        sessions_invalidated_at: true,
        social_profiles: {
          select: { ...PROFILE_SUMMARY, bio: true, banner_url: true, is_private: true, updated_at: true },
        },
        strug_wallet: { select: { balance: true, currency: true, status: true, updated_at: true } },
      },
    });

    if (!user) return res.status(404).json({ successful: false, message: 'User not found' });

    const wallet = user.strug_wallet
      ? { ...user.strug_wallet, balance: num(user.strug_wallet.balance) }
      : null;

    res.json({ ...user, email: decryptEmail(user.email), strug_wallet: wallet });
  } catch (err) {
    console.error('[board-admin/users] detail error:', err);
    res.status(500).json({ successful: false, message: 'Could not load user' });
  }
});

// ─── WALLET + TRANSACTIONS ────────────────────────────────────────────────────────
router.get('/:id/wallet', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (Number.isNaN(userId)) return res.status(400).json({ successful: false, message: 'Invalid user id' });

    const [wallet, transactions] = await Promise.all([
      prisma.strug_wallet.findUnique({ where: { user_id: userId } }),
      prisma.wallet_transaction.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        take: 50,
      }),
    ]);

    res.json({
      wallet: wallet ? { ...wallet, balance: num(wallet.balance) } : null,
      transactions: transactions.map((t) => ({ ...t, amount: num(t.amount) })),
    });
  } catch (err) {
    console.error('[board-admin/users] wallet error:', err);
    res.status(500).json({ successful: false, message: 'Could not load wallet' });
  }
});

// ─── REFERRALS ─────────────────────────────────────────────────────────────────────
router.get('/:id/referrals', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (Number.isNaN(userId)) return res.status(400).json({ successful: false, message: 'Invalid user id' });

    const user = await prisma.user.findUnique({
      where: { user_id: userId },
      select: { user_id: true, ref_code: true },
    });
    if (!user) return res.status(404).json({ successful: false, message: 'User not found' });

    // People who used THIS user's referral code (referees), and who referred this user.
    const [referees, referredByRow] = await Promise.all([
      user.ref_code
        ? prisma.shared_ref_code.findMany({
            where: { ref_code: user.ref_code },
            select: {
              share_id: true,
              shared_to: true,
              user_shared_ref_code_shared_toTouser: {
                select: { user_id: true, name: true, username: true, email: true },
              },
            },
          })
        : Promise.resolve([]),
      prisma.shared_ref_code.findFirst({
        where: { shared_to: userId },
        select: {
          ref_code: true,
          user_shared_ref_code_ref_codeTouser: {
            select: { user_id: true, name: true, username: true, email: true },
          },
        },
      }),
    ]);

    res.json({
      ref_code: user.ref_code,
      referredCount: referees.length,
      referees: referees.map((r) => ({ share_id: r.share_id, user: withEmail(r.user_shared_ref_code_shared_toTouser) })),
      referredBy: withEmail(referredByRow?.user_shared_ref_code_ref_codeTouser || null),
    });
  } catch (err) {
    console.error('[board-admin/users] referrals error:', err);
    res.status(500).json({ successful: false, message: 'Could not load referrals' });
  }
});

// ─── PER-USER: PROFILE HISTORY ───────────────────────────────────────────────────
router.get('/:id/history', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (Number.isNaN(userId)) return res.status(400).json({ successful: false, message: 'Invalid user id' });
    const history = await prisma.user_profile_history.findMany({
      where: { user_id: userId }, orderBy: { created_at: 'desc' }, take: 200,
      select: { history_id: true, field: true, old_value: true, new_value: true, changed_by: true, created_at: true },
    });
    res.json({ history });
  } catch (err) {
    console.error('[board-admin/users] user history error:', err);
    res.status(500).json({ successful: false, message: 'Could not load history' });
  }
});

// ─── PER-USER: INTERNAL NOTES (read / add / delete) ──────────────────────────────
router.get('/:id/notes', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (Number.isNaN(userId)) return res.status(400).json({ successful: false, message: 'Invalid user id' });
    const notes = await prisma.user_note.findMany({
      where: { user_id: userId }, orderBy: [{ pinned: 'desc' }, { created_at: 'desc' }],
    });
    res.json({ notes });
  } catch (err) {
    console.error('[board-admin/users] notes error:', err);
    res.status(500).json({ successful: false, message: 'Could not load notes' });
  }
});

router.post('/:id/notes', requireDashboard('user-management', 'write'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (Number.isNaN(userId)) return res.status(400).json({ successful: false, message: 'Invalid user id' });
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ successful: false, message: 'Note body is required' });
    const exists = await prisma.user.findUnique({ where: { user_id: userId }, select: { user_id: true } });
    if (!exists) return res.status(404).json({ successful: false, message: 'User not found' });
    const note = await prisma.user_note.create({
      data: {
        user_id: userId,
        body: body.slice(0, 5000),
        pinned: Boolean(req.body?.pinned),
        author_member_id: req.member?.member_id ?? null,
        author_name: req.member?.name ?? null,
      },
    });
    res.status(201).json({ successful: true, note });
  } catch (err) {
    console.error('[board-admin/users] add note error:', err);
    res.status(500).json({ successful: false, message: 'Could not add note' });
  }
});

router.delete('/notes/:noteId', requireDashboard('user-management', 'write'), async (req, res) => {
  try {
    const noteId = parseInt(req.params.noteId);
    if (Number.isNaN(noteId)) return res.status(400).json({ successful: false, message: 'Invalid note id' });
    const deleted = await prisma.user_note.delete({ where: { note_id: noteId } }).catch(() => null);
    if (!deleted) return res.status(404).json({ successful: false, message: 'Note not found' });
    res.json({ successful: true });
  } catch (err) {
    console.error('[board-admin/users] delete note error:', err);
    res.status(500).json({ successful: false, message: 'Could not delete note' });
  }
});

// ─── PER-USER: TAGS (read / add / delete) ────────────────────────────────────────
router.get('/:id/tags', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (Number.isNaN(userId)) return res.status(400).json({ successful: false, message: 'Invalid user id' });
    const tags = await prisma.user_tag.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' } });
    res.json({ tags });
  } catch (err) {
    console.error('[board-admin/users] tags error:', err);
    res.status(500).json({ successful: false, message: 'Could not load tags' });
  }
});

router.post('/:id/tags', requireDashboard('user-management', 'write'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (Number.isNaN(userId)) return res.status(400).json({ successful: false, message: 'Invalid user id' });
    const tag = String(req.body?.tag || '').trim().slice(0, 64);
    if (!tag) return res.status(400).json({ successful: false, message: 'Tag is required' });
    const exists = await prisma.user.findUnique({ where: { user_id: userId }, select: { user_id: true } });
    if (!exists) return res.status(404).json({ successful: false, message: 'User not found' });
    // Idempotent: (user_id, tag) is unique → upsert so re-tagging never 409s.
    const row = await prisma.user_tag.upsert({
      where: { user_id_tag: { user_id: userId, tag } },
      update: { color: req.body?.color ? String(req.body.color).slice(0, 16) : undefined },
      create: {
        user_id: userId, tag,
        color: req.body?.color ? String(req.body.color).slice(0, 16) : null,
        created_by_member_id: req.member?.member_id ?? null,
        created_by_name: req.member?.name ?? null,
      },
    });
    res.status(201).json({ successful: true, tag: row });
  } catch (err) {
    console.error('[board-admin/users] add tag error:', err);
    res.status(500).json({ successful: false, message: 'Could not add tag' });
  }
});

router.delete('/tags/:tagId', requireDashboard('user-management', 'write'), async (req, res) => {
  try {
    const tagId = parseInt(req.params.tagId);
    if (Number.isNaN(tagId)) return res.status(400).json({ successful: false, message: 'Invalid tag id' });
    const deleted = await prisma.user_tag.delete({ where: { tag_id: tagId } }).catch(() => null);
    if (!deleted) return res.status(404).json({ successful: false, message: 'Tag not found' });
    res.json({ successful: true });
  } catch (err) {
    console.error('[board-admin/users] delete tag error:', err);
    res.status(500).json({ successful: false, message: 'Could not delete tag' });
  }
});

// ─── PER-USER: ACCOUNT STATUS (Tier C — suspend / ban / restrict / reactivate) ───
// Gated on can_manage_members (the admin tier) — stronger than the read-only
// can_view_users that the rest of the router requires.
router.post('/:id/status', requireDashboard('user-management', 'write'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (Number.isNaN(userId)) return res.status(400).json({ successful: false, message: 'Invalid user id' });
    const status = String(req.body?.status || '');
    if (!ACCOUNT_STATUSES.includes(status)) {
      return res.status(400).json({ successful: false, message: `status must be one of ${ACCOUNT_STATUSES.join(', ')}` });
    }
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 1000) : null;
    const exists = await prisma.user.findUnique({ where: { user_id: userId }, select: { user_id: true, account_status: true } });
    if (!exists) return res.status(404).json({ successful: false, message: 'User not found' });

    const updated = await prisma.user.update({
      where: { user_id: userId },
      data: {
        account_status: status,
        status_reason: reason,
        status_changed_at: new Date(),
        status_changed_by: req.member?.member_id ?? null,
        // Suspending/banning also force-logs-out existing sessions immediately.
        ...((status === 'suspended' || status === 'banned') ? { sessions_invalidated_at: new Date() } : {}),
      },
      select: { user_id: true, account_status: true, status_reason: true, status_changed_at: true, sessions_invalidated_at: true },
    });

    // Audit into the activity stream (so it shows in Live Activity / the user timeline).
    recordActivity(userId, 'account.status_changed', {
      description: `Status → ${status}${reason ? ` (${reason})` : ''} by ${req.member?.name || 'board member'}`,
      metadata: { status, from: exists.account_status, member_id: req.member?.member_id ?? null },
    });

    res.json({ successful: true, user: updated });
  } catch (err) {
    console.error('[board-admin/users] status error:', err);
    res.status(500).json({ successful: false, message: 'Could not update account status' });
  }
});

// Force logout: invalidate all existing access tokens without changing account status.
router.post('/:id/force-logout', requireDashboard('user-management', 'write'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (Number.isNaN(userId)) return res.status(400).json({ successful: false, message: 'Invalid user id' });
    const exists = await prisma.user.findUnique({ where: { user_id: userId }, select: { user_id: true } });
    if (!exists) return res.status(404).json({ successful: false, message: 'User not found' });
    const updated = await prisma.user.update({
      where: { user_id: userId },
      data: { sessions_invalidated_at: new Date() },
      select: { user_id: true, sessions_invalidated_at: true },
    });
    recordActivity(userId, 'account.force_logout', {
      description: `Sessions invalidated by ${req.member?.name || 'board member'}`,
      metadata: { member_id: req.member?.member_id ?? null },
    });
    res.json({ successful: true, user: updated });
  } catch (err) {
    console.error('[board-admin/users] force-logout error:', err);
    res.status(500).json({ successful: false, message: 'Could not force logout' });
  }
});

export default router;
