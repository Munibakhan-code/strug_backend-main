import express from 'express';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import {
  getMailConfigSnapshot,
  isMailConfigured,
  sendEmail,
} from '../services/email-service.js';
import { getMailHealthSummary, getMailCatalog } from '../services/mail/send-log.js';
import {
  listMailSuppressions,
  upsertMailSuppression,
  deactivateMailSuppression,
  SUPPRESSION_REASONS,
} from '../services/mail/suppression.js';
import { getMailOutboxSummary } from '../services/mail/outbox.js';
import { getMailRateLimits } from '../services/mail/rate-limit.js';
import { getMailCutoverStatus } from '../services/mail/cutover-status.js';

const router = express.Router();
router.use(authenticateToken, requireAdmin);

function probeAllowlist() {
  const raw =
    process.env.MAIL_PROBE_ALLOWLIST ||
    process.env.SUPPORT_EMAIL ||
    'support@strug.ca';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * GET /admin/mail/catalog
 * Read-only template inventory + last send status (admin only).
 */
router.get('/catalog', async (req, res) => {
  try {
    const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 168));
    const catalog = await getMailCatalog({ hours });
    res.json(catalog);
  } catch (err) {
    console.error('[Mail Catalog] read failed:', err?.message || err);
    res.status(500).json({ message: 'Failed to load mail catalog' });
  }
});

/**
 * GET /admin/mail/health
 * Last 24h counts + recent failures / sends + outbox summary (admin only).
 */
router.get('/health', async (req, res) => {
  try {
    const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
    const recentLimit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const [summary, outbox] = await Promise.all([
      getMailHealthSummary({ hours, recentLimit }),
      getMailOutboxSummary({ hours }),
    ]);
    const config = getMailConfigSnapshot();
    res.json({
      config: {
        provider: config.provider,
        from: config.from,
        configured: config.configured,
      },
      rate_limits: getMailRateLimits(),
      outbox,
      ...summary,
    });
  } catch (err) {
    console.error('[Mail Health] read failed:', err?.message || err);
    res.status(500).json({ message: 'Failed to load mail health' });
  }
});

/**
 * GET /admin/mail/cutover-status
 * Code-side SMTP cutover readiness (does not flip production provider).
 */
router.get('/cutover-status', async (_req, res) => {
  try {
    const status = await getMailCutoverStatus();
    res.json(status);
  } catch (err) {
    console.error('[Mail Cutover] status failed:', err?.message || err);
    res.status(500).json({ message: 'Failed to load cutover status' });
  }
});

/**
 * GET /admin/mail/suppressions
 */
router.get('/suppressions', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const activeOnly = req.query.active !== 'false' && req.query.active !== '0';
    const rows = await listMailSuppressions({ limit, activeOnly });
    res.json({
      reasons: SUPPRESSION_REASONS,
      count: rows.length,
      suppressions: rows,
    });
  } catch (err) {
    console.error('[Mail Suppression] list failed:', err?.message || err);
    res.status(500).json({ message: 'Failed to list suppressions' });
  }
});

/**
 * POST /admin/mail/suppressions
 * Body: { to, reason: 'bounce'|'complaint'|'manual'|'unsubscribe', note? }
 */
router.post('/suppressions', async (req, res) => {
  try {
    const to = String(req.body?.to || '')
      .trim()
      .toLowerCase();
    const reason = String(req.body?.reason || 'manual')
      .trim()
      .toLowerCase();
    if (!to || !to.includes('@')) {
      return res.status(400).json({ message: 'Valid to email required' });
    }
    if (!SUPPRESSION_REASONS.includes(reason)) {
      return res.status(400).json({
        message: 'Invalid reason',
        allowed: SUPPRESSION_REASONS,
      });
    }
    const row = await upsertMailSuppression({
      to,
      reason,
      source: 'admin',
      note: req.body?.note ?? null,
    });
    res.status(201).json({
      ok: true,
      suppression: {
        id: row.id,
        to_hash: row.to_hash,
        to_hint: row.to_hint,
        reason: row.reason,
        active: row.active,
      },
    });
  } catch (err) {
    console.error('[Mail Suppression] upsert failed:', err?.message || err);
    res.status(500).json({ message: err?.message || 'Failed to add suppression' });
  }
});

/**
 * DELETE /admin/mail/suppressions/:toHash
 * Soft-deactivate (allows mail again).
 */
router.delete('/suppressions/:toHash', async (req, res) => {
  try {
    const row = await deactivateMailSuppression(req.params.toHash);
    res.json({
      ok: true,
      to_hash: row.to_hash,
      active: row.active,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/Invalid suppression hash/i.test(msg)) {
      return res.status(400).json({ message: msg });
    }
    if (err?.code === 'P2025') {
      return res.status(404).json({ message: 'Suppression not found' });
    }
    console.error('[Mail Suppression] deactivate failed:', msg);
    res.status(500).json({ message: 'Failed to deactivate suppression' });
  }
});

/**
 * POST /admin/mail/probe
 * Body: { to?: string } — must be on MAIL_PROBE_ALLOWLIST (or SUPPORT_EMAIL).
 */
router.post('/probe', async (req, res) => {
  try {
    if (!isMailConfigured()) {
      return res.status(503).json({ message: 'Mail is not configured' });
    }

    const allow = probeAllowlist();
    const requested = String(req.body?.to || allow[0] || '')
      .trim()
      .toLowerCase();
    if (!requested || !allow.includes(requested)) {
      return res.status(400).json({
        message: 'Probe recipient must be on MAIL_PROBE_ALLOWLIST',
        allowlist_hint: allow.map((a) => a.replace(/^(.{1}).*(@.*)$/, '$1***$2')),
      });
    }

    const result = await sendEmail({
      to: requested,
      subject: '[Strug] Mail Health probe',
      html: '<p>Mail Health probe succeeded.</p>',
      text: 'Mail Health probe succeeded.',
      tags: [
        { name: 'template', value: 'mail-health-probe' },
        { name: 'vertical', value: 'ops' },
      ],
    });

    res.json({
      ok: true,
      provider: result.provider,
      message_id: result.id,
      to_hint: requested.replace(/^(.{1}).*(@.*)$/, '$1***$2'),
    });
  } catch (err) {
    console.error('[Mail Health] probe failed:', err?.message || err);
    res.status(502).json({
      message: 'Probe send failed',
      error: err?.message || String(err),
    });
  }
});

export default router;
