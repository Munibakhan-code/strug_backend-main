// #193 Web Push (VAPID) dispatcher.
//
// Sends background push notifications to a user's registered browser/device
// subscriptions using the standard Web Push protocol. This is deliberately
// FAIL-OPEN: if the VAPID env keys are not configured the whole module becomes a
// no-op, so notification code paths that call it never break in an environment
// (dev/staging) where push isn't set up. Dead subscriptions (the push service
// returns 404/410 Gone) are pruned automatically.
//
// Notifications elsewhere in the app are keyed by social_profile.profile_id, but a
// push subscription belongs to a *user* (a browser the person logged into). Use
// sendWebPushToProfile() to bridge profile → user, or sendWebPushToUser() directly.

import webpush from 'web-push';
import prisma from '../utils/prisma-client.js';

// Static fallback VAPID pair for environments where env vars cannot be managed yet.
// Env vars still win when present. Replace this with environment-provided keys when deploy
// access is available; rotating VAPID keys invalidates existing browser subscriptions.
const STATIC_VAPID_PUBLIC_KEY = 'BLr6b9y_4XPN4DOQ1jpKA20AkBM6w03P6ek6KQeJ7sZ_7d7eoiDHU8wjMiFeK85CZ1cxUIyN-ww-BAtVjNCAgyM';
const STATIC_VAPID_PRIVATE_KEY = 'eBMFRUmyyLd1Vfnj46lxNlzDkG9WbqlSPsH5mbrERxA';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || STATIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || STATIC_VAPID_PRIVATE_KEY;
// mailto: or https: subject required by the spec; identifies the app to the push service.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@strug.ca';

let configured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    configured = true;
  } catch (err) {
    console.error('[web-push] invalid VAPID configuration, push disabled:', err.message);
  }
} else {
  console.warn('[web-push] VAPID keys not set — background push disabled (fail-open).');
}

export function isWebPushConfigured() {
  return configured;
}

export function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY;
}

// The canonical set of user-togglable push categories. This is the SINGLE source of truth:
// routes/push-routes.js validates incoming preference keys against it, services/notify.js maps
// verticals onto it, and the SPA renders one toggle per entry. They drifted apart once already —
// notify() emitted 'rides'/'work'/'quotes' while push-routes only accepted
// ['chat','social','orders','system'], so sanitizeCategories() silently dropped those keys and
// ride/work/quote push could never be muted. Add a category here, not in three places.
export const PUSH_CATEGORIES = [
  'chat', 'social', 'orders', 'rides', 'work', 'quotes',
  'live', 'video', 'townhall', 'payments', 'system',
];

// Map a social_notification.type to a coarse push category the user can toggle.
export function categoryForNotificationType(type) {
  const t = String(type || '').toUpperCase();
  if (t === 'CHAT_MESSAGE') return 'chat';
  if (t === 'LIVE') return 'live';
  if (['FOLLOW', 'LIKE', 'COMMENT', 'MENTION', 'REPLY', 'REACT', 'TAG'].includes(t)) return 'social';
  if (t.includes('PAYMENT') || t.includes('PAYOUT') || t.includes('REFUND') || t.includes('DISPUTE')) {
    return 'payments';
  }
  if (t.includes('ORDER') || t.includes('BOOKING')) {
    return 'orders';
  }
  return 'system';
}

// A subscription opts INTO every category by default. `categories` is a sparse
// opt-out map: only an explicit `false` disables that category.
function subscriptionAllows(subscription, category) {
  const prefs = subscription.categories;
  if (!prefs || typeof prefs !== 'object') return true;
  return prefs[category] !== false;
}

async function pushToSubscription(subscription, payloadString) {
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      payloadString,
    );
    return { ok: true };
  } catch (err) {
    const status = err?.statusCode;
    // 404 Not Found / 410 Gone: the subscription is permanently dead — prune it so we
    // stop trying and the row count stays meaningful.
    if (status === 404 || status === 410) {
      await prisma.push_subscription
        .delete({ where: { id: subscription.id } })
        .catch(() => {});
      return { ok: false, pruned: true };
    }
    console.error('[web-push] send failed:', status || err.message);
    return { ok: false };
  }
}

// Fire a background push to all of a user's subscriptions that have opted into
// `category`. Returns a small summary; never throws.
export async function sendWebPushToUser(userId, payload, category = 'system') {
  if (!configured) return { sent: 0, skipped: 0 };
  const safeUserId = Number(userId);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return { sent: 0, skipped: 0 };

  try {
    const subscriptions = await prisma.push_subscription.findMany({ where: { user_id: safeUserId } });
    if (!subscriptions.length) return { sent: 0, skipped: 0 };

    const body = {
      title: payload.title || 'Strug',
      body: String(payload.body ?? '').slice(0, 240),
      url: payload.url || '/',
      icon: payload.icon || '/favicon.ico',
      tag: payload.tag || undefined,
      data: payload.data || {},
    };
    const payloadString = JSON.stringify(body);

    let sent = 0;
    let skipped = 0;
    await Promise.all(
      subscriptions.map(async (subscription) => {
        if (!subscriptionAllows(subscription, category)) {
          skipped += 1;
          return;
        }
        const result = await pushToSubscription(subscription, payloadString);
        if (result.ok) sent += 1;
      }),
    );
    return { sent, skipped };
  } catch (err) {
    console.error('[web-push] dispatch error:', err.message);
    return { sent: 0, skipped: 0 };
  }
}

// Bridge a profile_id (how notifications are addressed) to its owning user, then push.
export async function sendWebPushToProfile(profileId, payload, category = 'system') {
  if (!configured) return { sent: 0, skipped: 0 };
  const safeProfileId = Number(profileId);
  if (!Number.isInteger(safeProfileId) || safeProfileId <= 0) return { sent: 0, skipped: 0 };
  try {
    const profile = await prisma.social_profile.findUnique({
      where: { profile_id: safeProfileId },
      select: { user_id: true },
    });
    if (!profile?.user_id) return { sent: 0, skipped: 0 };
    return sendWebPushToUser(profile.user_id, payload, category);
  } catch (err) {
    console.error('[web-push] profile dispatch error:', err.message);
    return { sent: 0, skipped: 0 };
  }
}
