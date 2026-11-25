import prisma from './prisma-client.js';
import { notify } from '../services/notify.js';

// Persist an on-demand notification for a user AND push it live over the socket so the
// bell updates instantly. user_id is the recipient. Best-effort (never throws).
// When `params` is passed, body is stored as JSON { v: 1, ...params } for client-side i18n.
//
// Epic 10: this ALSO mirrors into the unified `notification` table via notify(). Every work event
// used to die in the work_notification silo — it reached the (now-retired) WorkNotificationBell but
// never the global bell, never web push, never the actionable-offer card. Mirroring here rather
// than at the 7 call sites means a work event can't be added that forgets to do it.
//
// The legacy row stores `params` for client-side i18n and no title, so the unified row needs its
// own human-readable copy — hence the map below.
const UNIFIED = {
  offer:           { title: 'New job offer',              urgency: 'actionable', actionUrl: 'sd-work' },
  no_match:        { title: 'No workers available',       urgency: 'ambient',    actionUrl: 'ondemand' },
  accepted:        { title: 'A worker accepted your job', urgency: 'ambient',    actionUrl: 'ondemand' },
  earning:         { title: 'Payment received',           urgency: 'ambient',    actionUrl: 'wallet' },
  worker_en_route: { title: 'Your worker is on the way',  urgency: 'ambient',    actionUrl: 'ondemand' },
  in_progress:     { title: 'Your job has started',       urgency: 'ambient',    actionUrl: 'ondemand' },
  completed:       { title: 'Your job is complete',       urgency: 'ambient',    actionUrl: 'ondemand' },
  cancelled:       { title: 'Job cancelled',              urgency: 'ambient',    actionUrl: 'sd-work' },
  tip:             { title: 'You received a tip',         urgency: 'ambient',    actionUrl: 'wallet' },
  no_show:         { title: 'You were marked as no-show', urgency: 'ambient',    actionUrl: 'ondemand' },
  offer_timeout:   { title: 'Offer timed out — refund issued', urgency: 'ambient', actionUrl: 'wallet' },
};

export async function notifyWork(io, userId, type, { work_job_id = null, title = null, body = null, params = null, unified = null } = {}) {
  if (!userId || !type) return null;
  const storedTitle = title || type;
  const storedBody = params != null ? JSON.stringify({ v: 1, ...params }) : body;

  const u = UNIFIED[type];
  if (u) {
    // Fire-and-forget by contract — notify() is fail-open and must not block the legacy write.
    notify(io, {
      userId: Number(userId),
      vertical: 'work',
      type: `work.${type}`,
      title: title || u.title,
      body: body || params?.jobTitle || null,
      urgency: u.urgency,
      entityType: 'work_job',
      entityId: work_job_id,
      actionUrl: u.actionUrl,
      ...(unified || {}),
    });
  }

  try {
    const n = await prisma.work_notification.create({
      data: { user_id: Number(userId), type, work_job_id: work_job_id ?? null, title: storedTitle, body: storedBody },
    });
    io?.to(`user-${userId}`).emit(`work-notification-${userId}`, n);
    return n;
  } catch (e) {
    console.error('[work-notify]', e.message);
    return null;
  }
}
