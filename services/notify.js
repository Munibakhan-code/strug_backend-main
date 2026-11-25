// services/notify.js — the ONE entry point for cross-vertical notifications (Epic 10 Phase 1).
//
// Every vertical that needs to alert a user calls notify() instead of hand-rolling a socket
// emit. It does three things, in order, all best-effort:
//   1. persist a `notification` row (durable — survives a dropped socket / offline recipient)
//   2. emit the SINGLE unified event `notification:new` into the recipient's `user-<id>` room
//   3. fire web push (no-op unless VAPID is configured for the environment)
//
// Why a stable event name matters: the legacy code emits a *different, per-user-suffixed* event
// per vertical (`work-notification-<id>`, `ride-request-<id>`, …), which is exactly why the SPA
// could never register one global listener. Here it is always `notification:new`; the room
// already scopes delivery, so no id suffix.
//
// FAIL-OPEN by contract: a notification problem must NEVER block the thing it describes. A ride
// must dispatch even if the DB write throws. So every step is wrapped and notify() resolves to
// the row (or null) rather than rejecting. Callers should NOT await-with-catch; fire and forget.

import prisma from '../utils/prisma-client.js';
import { sendWebPushToUser, PUSH_CATEGORIES } from './web-push-service.js';
import { areUsersBlockedOnPlatform } from '../utils/platform-blocks.js';

// Coarse push categories map onto the push_subscription.categories opt-out JSON. Every value here
// MUST be a member of PUSH_CATEGORIES — anything else is silently dropped by push-routes'
// sanitizeCategories(), which makes that vertical permanently unmutable. Asserted at import.
const VERTICAL_PUSH_CATEGORY = {
  rideshare: 'rides',
  courier: 'rides',
  food: 'orders',
  dating: 'social',
  ecommerce: 'orders',
  work: 'work',
  jobs: 'work',
  quotes: 'quotes',
  booking: 'orders',
  social: 'social',
  video: 'video',
  live: 'live',
  townhall: 'townhall',
  payments: 'payments',
  system: 'system',
};

// Fail loudly at boot rather than silently shipping an unmutable vertical to prod.
for (const [vertical, category] of Object.entries(VERTICAL_PUSH_CATEGORY)) {
  if (!PUSH_CATEGORIES.includes(category)) {
    throw new Error(
      `[notify] vertical '${vertical}' maps to push category '${category}', which is not in ` +
      `PUSH_CATEGORIES (${PUSH_CATEGORIES.join(', ')}). Users could never mute it. ` +
      `Add the category to web-push-service.PUSH_CATEGORIES.`,
    );
  }
}

const VALID_URGENCY = new Set(['actionable', 'ambient']);

/**
 * @param {import('socket.io').Server} io   socket server (may be undefined under tests)
 * @param {object} n
 * @param {number} n.userId                 recipient user_id (required)
 * @param {number|null} [n.actorUserId]     user_id that caused the notification; blocked pairs are suppressed
 * @param {string} n.vertical               rideshare|food|ecommerce|courier|work|quotes|booking|social|system
 * @param {string} n.type                   dotted type, e.g. 'ride.offer', 'order.placed'
 * @param {string} n.title
 * @param {'actionable'|'ambient'} [n.urgency='ambient']
 * @param {string|null} [n.body]
 * @param {string|null} [n.entityType]      e.g. 'ride_request'
 * @param {number|null} [n.entityId]
 * @param {string|null} [n.actionUrl]       SPA deep-link target, e.g. 'sd-drive'
 * @param {object|null} [n.data]            vertical-specific payload (fare, pickup, …)
 * @param {Date|null}   [n.expiresAt]       actionable offers only
 * @param {boolean}     [n.push=true]       set false to skip web push (socket + row still happen)
 * @returns {Promise<object|null>} the persisted row, or null if persistence failed
 */
export async function notify(io, {
  userId, actorUserId = null, vertical, type, title,
  urgency = 'ambient', body = null,
  entityType = null, entityId = null,
  actionUrl = null, data = null, expiresAt = null,
  push = true,
} = {}) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || !vertical || !type || !title) {
    console.error('[notify] missing required field', { userId, vertical, type, hasTitle: !!title });
    return null;
  }
  const actorId = Number(actorUserId);
  if (Number.isInteger(actorId) && actorId > 0 && actorId !== uid) {
    try {
      if (await areUsersBlockedOnPlatform(uid, actorId)) return null;
    } catch (e) {
      console.error('[notify] block check failed:', e.message);
    }
  }
  const safeUrgency = VALID_URGENCY.has(urgency) ? urgency : 'ambient';

  let row = null;
  try {
    row = await prisma.notification.create({
      data: {
        user_id: uid,
        vertical,
        type,
        urgency: safeUrgency,
        title,
        body,
        entity_type: entityType,
        entity_id: entityId != null ? Number(entityId) : null,
        action_url: actionUrl,
        data: data ?? undefined,
        expires_at: expiresAt ?? null,
      },
    });
  } catch (e) {
    // Persistence failed — still try to deliver live so the recipient isn't left blind, but
    // there's no durable row to fall back on. Never rethrow.
    console.error('[notify] persist failed:', e.message);
  }

  // Real-time: one stable event into the private per-user room. Payload is the row when we have
  // it, else a synthesised shape so the client can render even when the DB write lost.
  try {
    const payload = row ?? {
      notification_id: null, user_id: uid, vertical, type, urgency: safeUrgency,
      title, body, entity_type: entityType, entity_id: entityId ?? null,
      action_url: actionUrl, data: data ?? null, is_read: false,
      expires_at: expiresAt ?? null, created_at: new Date(),
    };
    io?.to(`user-${uid}`).emit('notification:new', payload);
  } catch (e) {
    console.error('[notify] socket emit failed:', e.message);
  }

  // Background push — a no-op when VAPID isn't configured (web-push-service fails open).
  if (push) {
    try {
      const category = VERTICAL_PUSH_CATEGORY[vertical] || 'system';
      await sendWebPushToUser(uid, {
        title,
        body: body || undefined,
        // web-push-service reads `url` at the top level (it's what the service worker opens on
        // click); `data` is passed through for the SPA's own routing.
        url: actionUrl || '/',
        tag: entityType && entityId ? `${entityType}-${entityId}` : `${vertical}-${type}`,
        data: { url: actionUrl || '/', vertical, type, notification_id: row?.notification_id ?? null },
      }, category);
    } catch (e) {
      console.error('[notify] web push failed:', e.message);
    }
  }

  return row;
}

export default notify;
