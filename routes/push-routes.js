// #193 Web Push (VAPID) subscription management.
//
// A logged-in browser registers its PushSubscription here; the dispatcher
// (services/web-push-service.js) later delivers background notifications to it.
// The VAPID *public* key is safe to expose — the client needs it to subscribe.

import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from './../utils/prisma-client.js';
import { getVapidPublicKey, isWebPushConfigured, PUSH_CATEGORIES } from '../services/web-push-service.js';

const router = express.Router();

// Public: the client fetches the VAPID public key to build its subscription.
router.get('/vapid-public-key', (_req, res) => {
  res.json({ key: getVapidPublicKey(), enabled: isWebPushConfigured() });
});

function sanitizeCategories(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const key of PUSH_CATEGORIES) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  return Object.keys(out).length ? out : null;
}

// Register / refresh this browser's subscription (idempotent on endpoint).
router.post('/subscribe', authenticateToken, async (req, res) => {
  try {
    const { subscription, categories } = req.body || {};
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({ error: 'subscription with endpoint and keys is required' });
    }
    const ua = String(req.headers['user-agent'] || '').slice(0, 255) || null;
    const cats = sanitizeCategories(categories);

    const saved = await prisma.push_subscription.upsert({
      where: { endpoint },
      // Re-subscribing from the same browser rebinds the endpoint to the current user
      // (e.g. a shared device where a different account logs in) and refreshes keys.
      update: { user_id: req.user.user_id, p256dh, auth, ua, ...(cats ? { categories: cats } : {}) },
      create: { user_id: req.user.user_id, endpoint, p256dh, auth, ua, categories: cats },
    });
    res.status(201).json({ ok: true, id: saved.id });
  } catch (err) {
    console.error('[push] subscribe failed:', err.message);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// Remove this browser's subscription. Scoped to the caller so one user can't delete
// another's row by guessing an endpoint.
router.post('/unsubscribe', authenticateToken, async (req, res) => {
  try {
    const endpoint = req.body?.endpoint;
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
    await prisma.push_subscription.deleteMany({ where: { endpoint, user_id: req.user.user_id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[push] unsubscribe failed:', err.message);
    res.status(500).json({ error: 'Failed to remove subscription' });
  }
});

// Representative category preferences for the caller (from their most recent subscription).
router.get('/preferences', authenticateToken, async (req, res) => {
  try {
    const latest = await prisma.push_subscription.findFirst({
      where: { user_id: req.user.user_id },
      orderBy: { id: 'desc' },
      select: { categories: true },
    });
    const prefs = (latest?.categories && typeof latest.categories === 'object') ? latest.categories : {};
    const merged = {};
    for (const key of PUSH_CATEGORIES) merged[key] = prefs[key] !== false;
    res.json({ categories: merged, subscribed: Boolean(latest) });
  } catch (err) {
    console.error('[push] get preferences failed:', err.message);
    res.status(500).json({ error: 'Failed to load preferences' });
  }
});

// Update category preferences across ALL of the caller's subscriptions (their devices
// share one preference set from the settings UI's point of view).
router.put('/preferences', authenticateToken, async (req, res) => {
  try {
    const cats = sanitizeCategories(req.body?.categories);
    if (!cats) return res.status(400).json({ error: 'categories object is required' });
    const result = await prisma.push_subscription.updateMany({
      where: { user_id: req.user.user_id },
      data: { categories: cats },
    });
    res.json({ ok: true, updated: result.count, categories: cats });
  } catch (err) {
    console.error('[push] update preferences failed:', err.message);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

export default router;
