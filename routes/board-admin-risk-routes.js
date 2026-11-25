// routes/board-admin-risk-routes.js
//
// Read-only Risk & Fraud signals for the internal dashboards (strug-internal-dashboards
// → Payments & Risks dashboard). Gated by the board identity + can_manage_members
// (the admin tier — these views expose user identity + emails), matching Finance /
// Operations / … / Content Moderation. Mounted at /board-admin/risk. ALL READ-ONLY.
//
// Payments & Risks is Finance's risk-side sibling. Most of its PAYMENTS views compose
// FE-side from the Finance + Users board endpoints already shipped (transactions,
// wallets, payouts, revenue, referrals, alerts, activity). This router adds the ONE
// thing no existing endpoint provides: a CROSS-SIGNAL risk rollup that stitches the
// separate money + account signals into a single risk picture:
//   GET /overview  combined risk rollup (alerts + wallet risk + failed logins +
//                  enforcement + payout/refund/referral exposure + trends)
//   GET /signals   a unified risk-signal feed (user_alert + failed-login +
//                  account-status-change activity, newest first)
//   GET /exposure  money-at-risk breakdown (pending payouts, negative balances,
//                  refunds, referral liability, frozen-wallet balances)
//
// What genuinely does NOT exist (→ honest N/A in the dashboard): a risk-scoring / ML
// fraud-model store, a KYC / verification-document store, AML / sanctions screening,
// a chargeback / dispute workflow (Stripe-side), payment-instrument / gateway config
// (Stripe-side), transaction-monitoring rules, watchlists.

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import { decrypt } from '../utils/crypto.js';
import { syncUserAlerts } from '../services/user-alerts.js';
import { getStripe } from '../services/live-payout.js';
import bcrypt from 'bcrypt';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('payments-risks', 'read'));

const num = (d) => (d == null ? 0 : Number(d));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const mapGroup = (rows, key) =>
  rows.map((r) => ({ name: r[key] == null ? '(none)' : String(r[key]), count: num(r._count?._all) }))
    .sort((a, b) => b.count - a.count);

const looksEncrypted = (v) => typeof v === 'string' && v.length >= 32 && v.length % 2 === 0 && /^[0-9a-f]+$/i.test(v);
const decryptEmail = (v) => {
  if (!looksEncrypted(v)) return v;
  try { return decrypt(v); } catch { return v; }
};
async function userSummaries(ids) {
  const unique = [...new Set(ids.filter((x) => x != null))];
  if (!unique.length) return {};
  const users = await prisma.user.findMany({
    where: { user_id: { in: unique } },
    select: { user_id: true, name: true, username: true, email: true },
  });
  const map = {};
  for (const u of users) map[u.user_id] = { user_id: u.user_id, name: u.name, username: u.username, email: decryptEmail(u.email) };
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /overview — the combined risk rollup.
//   ?days=N (window for failed-logins / refunds / large-txn, default 30)
//   ?largeAmount=N (large-transaction threshold, default 500)
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const largeAmount = clampNum(req.query.largeAmount, 1, 1e9, 500);
    const cutoff = daysAgo(days);

    // Refresh the derived alert set (best-effort — serve persisted on failure).
    let synced = false;
    try { await syncUserAlerts(); synced = true; }
    catch (e) { console.error('[board-admin/risk] alert sync failed (serving persisted):', e?.message || e); }

    const [
      alertsByStatus, alertsBySeverity, alertsOpen, alertsTotal,
      negativeWallets, frozenWallets, negativeSum,
      failedLogins, enforcedSuspended, enforcedBanned, enforcedRestricted,
      payoutPending, refundAgg, largeTxns, referralAgg,
    ] = await Promise.all([
      prisma.user_alert.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.user_alert.groupBy({ by: ['severity'], where: { status: { not: 'resolved' } }, _count: { _all: true } }),
      prisma.user_alert.count({ where: { status: 'open' } }),
      prisma.user_alert.count(),
      prisma.strug_wallet.count({ where: { balance: { lt: 0 } } }),
      prisma.strug_wallet.count({ where: { status: { not: 'active' } } }),
      prisma.strug_wallet.aggregate({ _sum: { balance: true }, where: { balance: { lt: 0 } } }),
      prisma.user_activity_event.count({ where: { type: 'auth.login_failed', created_at: { gte: cutoff } } }),
      prisma.user.count({ where: { account_status: 'suspended' } }),
      prisma.user.count({ where: { account_status: 'banned' } }),
      prisma.user.count({ where: { account_status: 'restricted' } }),
      prisma.live_payout_request.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { status: 'PENDING' } }),
      prisma.wallet_transaction.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { source: { contains: 'refund', mode: 'insensitive' }, created_at: { gte: cutoff } } }),
      prisma.wallet_transaction.count({ where: { amount: { gte: largeAmount }, created_at: { gte: cutoff } } }),
      prisma.wallet_transaction.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { source: { in: ['recruit', 'referral'] } } }),
    ]);

    // Daily new-alert + failed-login trend (risk pressure over time).
    const alertDaily = await prisma.$queryRaw`
      SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
      FROM user_alert WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`;
    const loginDaily = await prisma.$queryRaw`
      SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
      FROM user_activity_event WHERE type = 'auth.login_failed' AND created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`;

    res.json({
      synced,
      days,
      largeAmount,
      alerts: {
        total: alertsTotal, open: alertsOpen,
        byStatus: mapGroup(alertsByStatus, 'status'),
        bySeverity: mapGroup(alertsBySeverity, 'severity'),
      },
      wallets: {
        negative: negativeWallets, frozen: frozenWallets,
        negativeExposure: Math.abs(num(negativeSum._sum.balance)),
      },
      failedLogins,
      enforcement: { suspended: enforcedSuspended, banned: enforcedBanned, restricted: enforcedRestricted },
      exposure: {
        pendingPayouts: { count: num(payoutPending._count?._all), amount: num(payoutPending._sum?.amount) },
        refunds: { count: num(refundAgg._count?._all), amount: num(refundAgg._sum?.amount) },
        largeTransactions: largeTxns,
        referralLiability: { count: num(referralAgg._count?._all), amount: num(referralAgg._sum?.amount) },
      },
      trend: {
        alerts: alertDaily.map((d) => ({ day: d.day, count: num(d.count) })),
        failedLogins: loginDaily.map((d) => ({ day: d.day, count: num(d.count) })),
      },
      note: 'Risk overview = a read-only cross-signal rollup (derived user_alert set, wallet risk, failed logins, enforcement populations, and money-at-risk exposure). There is no risk-scoring model or standing fraud pipeline — these are reconciled signals, not scores.',
    });
  } catch (err) {
    console.error('[board-admin/risk] /overview failed:', err);
    res.status(500).json({ error: 'Failed to load risk overview' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /signals — unified risk-signal feed (alerts + failed logins + enforcement changes).
//   ?days=N (default 30)  ?limit=N (default 60)
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/signals', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const limit = clampInt(req.query.limit, 1, 200, 60);
    const cutoff = daysAgo(days);

    const [alerts, activity] = await Promise.all([
      prisma.user_alert.findMany({
        where: { status: { not: 'resolved' } },
        orderBy: [{ severity: 'asc' }, { updated_at: 'desc' }], take: limit,
        select: { alert_id: true, type: true, severity: true, message: true, status: true, created_at: true, user_id: true },
      }),
      prisma.user_activity_event.findMany({
        where: { type: { in: ['auth.login_failed', 'account.status_changed', 'account.force_logout'] }, created_at: { gte: cutoff } },
        orderBy: { created_at: 'desc' }, take: limit,
        select: { event_id: true, type: true, description: true, ip_address: true, created_at: true, user_id: true },
      }),
    ]);

    const users = await userSummaries([...alerts.map((a) => a.user_id), ...activity.map((e) => e.user_id)]);
    const signals = [
      ...alerts.map((a) => ({
        kind: 'alert', id: `alert-${a.alert_id}`, signal: a.type, severity: a.severity,
        message: a.message, status: a.status, at: a.created_at, user: users[a.user_id] || null,
      })),
      ...activity.map((e) => ({
        kind: 'event', id: `event-${e.event_id}`, signal: e.type,
        severity: e.type === 'auth.login_failed' ? 'warning' : 'info',
        message: e.description || e.type, ip_address: e.ip_address, at: e.created_at, user: users[e.user_id] || null,
      })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);

    res.json({
      days,
      counts: {
        alerts: alerts.length,
        failedLogins: activity.filter((e) => e.type === 'auth.login_failed').length,
        enforcement: activity.filter((e) => e.type !== 'auth.login_failed').length,
      },
      signals,
      note: 'Risk signals = a merged feed of the derived alerts (banned / shadow-banned / negative-balance / frozen-wallet) and the failed-login + account-status-change activity events. Read-only — triage of an alert is a write in the User Management endpoint.',
    });
  } catch (err) {
    console.error('[board-admin/risk] /signals failed:', err);
    res.status(500).json({ error: 'Failed to load risk signals' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /exposure — money-at-risk breakdown.
//   ?days=N (window for refunds, default 30)
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/exposure', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = daysAgo(days);

    const [payoutPending, payoutApproved, negativeSum, frozenWallets, refundAgg, referralAgg] = await Promise.all([
      prisma.live_payout_request.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { status: 'PENDING' } }),
      prisma.live_payout_request.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { status: 'APPROVED' } }),
      prisma.strug_wallet.aggregate({ _sum: { balance: true }, _count: { _all: true }, where: { balance: { lt: 0 } } }),
      prisma.strug_wallet.count({ where: { status: { not: 'active' } } }),
      prisma.wallet_transaction.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { source: { contains: 'refund', mode: 'insensitive' }, created_at: { gte: cutoff } } }),
      prisma.wallet_transaction.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { source: { in: ['recruit', 'referral'] } } }),
    ]);

    const items = [
      { key: 'pending_payouts', label: 'Pending payouts', amount: num(payoutPending._sum?.amount), count: num(payoutPending._count?._all), tone: 'warning' },
      { key: 'approved_payouts', label: 'Approved (unpaid) payouts', amount: num(payoutApproved._sum?.amount), count: num(payoutApproved._count?._all), tone: 'warning' },
      { key: 'negative_balances', label: 'Negative wallet balances', amount: Math.abs(num(negativeSum._sum?.balance)), count: num(negativeSum._count?._all), tone: 'critical' },
      { key: 'refunds', label: `Refunds (${days}d)`, amount: num(refundAgg._sum?.amount), count: num(refundAgg._count?._all), tone: 'info' },
      { key: 'referral_liability', label: 'Referral liability (all-time)', amount: num(referralAgg._sum?.amount), count: num(referralAgg._count?._all), tone: 'info' },
    ];
    const totalAtRisk = items.filter((i) => ['pending_payouts', 'approved_payouts', 'negative_balances'].includes(i.key)).reduce((s, i) => s + i.amount, 0);

    res.json({
      days,
      totalAtRisk,
      frozenWallets,
      items,
      note: 'Money-at-risk = payouts owed but not yet paid (pending + approved), negative wallet balances the platform is exposed to, plus refund and referral-liability context. Chargebacks / disputes are Stripe-side and not included (not stored in the platform DB).',
    });
  } catch (err) {
    console.error('[board-admin/risk] /exposure failed:', err);
    res.status(500).json({ error: 'Failed to load exposure' });
  }
});

// ═══════════════════════ DISPUTES (Stripe chargebacks) ═══════════════════════════════
// Chargebacks / disputes live entirely in Stripe (not the platform DB), so this reads them
// LIVE via the Stripe API. Read is safe; evidence-submission and conceding are WRITE actions
// on real money-disputes → each requires a step-up password (bcrypt re-auth). Stripe is the
// system of record and logs every evidence change in the dispute's own timeline.

// Step-up re-auth: the acting board member must re-type their login password (reused pattern
// from the payout write-actions). Returns true on success; else sends 400/401 and returns false.
async function verifyStepUp(req, res) {
  const password = req.body?.password;
  if (!password || typeof password !== 'string') {
    res.status(400).json({ successful: false, message: 'Password required to authorize this action.' });
    return false;
  }
  const row = await prisma.board_member.findUnique({ where: { member_id: req.member.member_id }, omit: { password: false } });
  const ok = row?.password ? await bcrypt.compare(password, row.password) : false;
  if (!ok) { res.status(401).json({ successful: false, message: 'Incorrect password.' }); return false; }
  return true;
}

const DISPUTE_STATUSES = ['warning_needs_response', 'warning_under_review', 'warning_closed', 'needs_response', 'under_review', 'won', 'lost'];
const cents = (n) => (n == null ? 0 : Number(n) / 100);
function shapeDispute(d) {
  const charge = d.charge && typeof d.charge === 'object' ? d.charge : null;
  const bd = charge?.billing_details || {};
  return {
    id: d.id, amount: cents(d.amount), currency: (d.currency || 'usd').toUpperCase(),
    reason: d.reason, status: d.status,
    evidence_due_by: d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000).toISOString() : null,
    has_evidence: !!d.evidence_details?.has_evidence, past_due: !!d.evidence_details?.past_due,
    submission_count: d.evidence_details?.submission_count ?? 0,
    is_charge_refundable: !!d.is_charge_refundable,
    created: d.created ? new Date(d.created * 1000).toISOString() : null,
    charge_id: charge?.id || (typeof d.charge === 'string' ? d.charge : null),
    customer: charge ? { email: bd.email || charge.receipt_email || null, name: bd.name || null } : null,
    charge_description: charge?.description || null,
  };
}

// GET /disputes — live Stripe dispute list.  ?status= ?limit= ?starting_after=
router.get('/disputes', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(200).json({ configured: false, disputes: [], counts: {}, note: 'Stripe is not configured in this environment — no live disputes to read.' });
  try {
    const limit = clampInt(req.query.limit, 1, 50, 20);
    const params = { limit, expand: ['data.charge'] };
    if (req.query.starting_after) params.starting_after = String(req.query.starting_after);
    const list = await stripe.disputes.list(params);
    let rows = list.data.map(shapeDispute);
    if (req.query.status) rows = rows.filter((d) => d.status === String(req.query.status));
    // Actionable = needs_response / warning_needs_response (has an evidence deadline).
    const counts = { total: rows.length, needsResponse: 0, underReview: 0, won: 0, lost: 0, warning: 0 };
    for (const d of rows) {
      if (d.status.includes('needs_response')) counts.needsResponse++;
      else if (d.status.includes('under_review')) counts.underReview++;
      else if (d.status === 'won') counts.won++;
      else if (d.status === 'lost') counts.lost++;
      if (d.status.startsWith('warning')) counts.warning++;
    }
    res.json({ configured: true, disputes: rows, counts, has_more: list.has_more, statuses: DISPUTE_STATUSES,
      note: 'Live chargebacks / disputes from Stripe. Read-only listing; submitting evidence or conceding are gated write-actions.' });
  } catch (err) {
    console.error('[board-admin/risk] /disputes failed:', err);
    res.status(502).json({ error: 'Failed to load disputes from Stripe', detail: err.message });
  }
});

// GET /disputes/:id — one dispute (with expanded charge).
router.get('/disputes/:id', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  try {
    const d = await stripe.disputes.retrieve(String(req.params.id), { expand: ['charge'] });
    res.json({ dispute: { ...shapeDispute(d), evidence: d.evidence || {} } });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: 'Dispute not found' });
    console.error('[board-admin/risk] /disputes/:id failed:', err);
    res.status(502).json({ error: 'Failed to load dispute', detail: err.message });
  }
});

const EVIDENCE_FIELDS = ['uncategorized_text', 'product_description', 'customer_name', 'customer_email_address', 'billing_address', 'shipping_tracking_number', 'shipping_carrier', 'service_date', 'refund_policy_disclosure'];
// POST /disputes/:id/evidence — submit dispute evidence to Stripe (STEP-UP + WRITE).
//   body: { password, submit?:bool, evidence:{ <EVIDENCE_FIELDS> } }
router.post('/disputes/:id/evidence', requireDashboard('payments-risks', 'write'), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ successful: false, message: 'Stripe not configured' });
  if (!(await verifyStepUp(req, res))) return;
  try {
    const inEv = req.body?.evidence || {};
    const evidence = {};
    for (const f of EVIDENCE_FIELDS) if (typeof inEv[f] === 'string' && inEv[f].trim()) evidence[f] = inEv[f];
    if (!Object.keys(evidence).length) return res.status(400).json({ successful: false, message: 'Provide at least one evidence field.' });
    const submit = req.body?.submit !== false; // default true
    const updated = await stripe.disputes.update(String(req.params.id), { evidence, submit });
    console.log(`[board-admin/risk] dispute ${req.params.id} evidence ${submit ? 'submitted' : 'saved'} by member ${req.member.member_id} (${req.member.name})`);
    res.json({ successful: true, data: { id: updated.id, status: updated.status, submitted: submit, submission_count: updated.evidence_details?.submission_count ?? null } });
  } catch (err) {
    if (err.statusCode >= 400 && err.statusCode < 500) return res.status(err.statusCode).json({ successful: false, message: err.message });
    console.error('[board-admin/risk] dispute evidence failed:', err);
    res.status(502).json({ successful: false, message: 'Failed to submit evidence', detail: err.message });
  }
});

// POST /disputes/:id/close — concede the dispute (forfeit the funds) (STEP-UP + WRITE).
router.post('/disputes/:id/close', requireDashboard('payments-risks', 'write'), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ successful: false, message: 'Stripe not configured' });
  if (!(await verifyStepUp(req, res))) return;
  try {
    const closed = await stripe.disputes.close(String(req.params.id));
    console.log(`[board-admin/risk] dispute ${req.params.id} CONCEDED by member ${req.member.member_id} (${req.member.name})`);
    res.json({ successful: true, data: { id: closed.id, status: closed.status } });
  } catch (err) {
    if (err.statusCode >= 400 && err.statusCode < 500) return res.status(err.statusCode).json({ successful: false, message: err.message });
    console.error('[board-admin/risk] dispute close failed:', err);
    res.status(502).json({ successful: false, message: 'Failed to close dispute', detail: err.message });
  }
});

export default router;
