import prisma from './prisma-client.js';
import { notify } from '../services/notify.js';

// Persist a quote-vertical notification for a user AND push it live over the socket so the
// bell updates instantly. Best-effort (never throws). Mirrors notifyWork.
//
// Epic 10: also mirrors into the unified `notification` table. Notably this is what finally tells a
// REQUESTER that a provider sent them a quote (`new_quote`) — previously only the provider was ever
// notified of anything in this vertical, so a requester had to poll the page to find out.
//
// Unlike work, every quote call site already supplies a human title, so only urgency needs mapping.
//
// ⚠️ actionUrl is deliberately NOT set here. The SPA has NO `quotes` nav id — the Quotes page is
// mounted per-vertical (`insurance` / `mortgage` for the requester, `sd-insurance` / `sd-mortgage`
// for the provider). An actionUrl of 'quotes' routes to the 404 page, which is what shipped before
// this. Since the right target depends on BOTH the request's vertical and whether the recipient is
// the requester or the provider, only the call site can know it — so it passes one in via
// `unified.actionUrl`, and a notification with no valid target simply has no deep link (clicking
// marks it read) rather than a dead one.
const UNIFIED = {
  new_request:          { urgency: 'actionable' },
  new_quote:            { urgency: 'ambient' },
  appointment_booked:   { urgency: 'ambient' },
  appointment_confirmed:{ urgency: 'ambient' },
  appointment_cancelled:{ urgency: 'ambient' },
  deal_closed:          { urgency: 'ambient' },
  review_received:      { urgency: 'ambient' },
};

// quote_request.vertical -> SPA nav id. Returns null for anything unmapped, so an unknown vertical
// yields no deep link instead of a broken one.
const QUOTE_NAV = { insurance: 'insurance', mortgage: 'mortgage' };
export function quoteActionUrl(vertical, { provider = false } = {}) {
  const nav = QUOTE_NAV[String(vertical || '').toLowerCase()];
  if (!nav) return null;
  return provider ? `sd-${nav}` : nav;
}

export async function notifyQuote(io, userId, type, { quote_request_id = null, title, body = null, unified = null } = {}) {
  if (!userId || !title) return null;

  const u = UNIFIED[type];
  if (u) {
    notify(io, {
      userId: Number(userId),
      vertical: 'quotes',
      type: `quote.${type}`,
      title,
      body,
      urgency: u.urgency,
      entityType: 'quote_request',
      entityId: quote_request_id,
      actionUrl: null, // call site supplies a real one via `unified` — see the note above
      ...(unified || {}),
    });
  }

  try {
    const n = await prisma.quote_notification.create({
      data: { user_id: Number(userId), type, quote_request_id: quote_request_id ?? null, title, body },
    });
    io?.to(`user-${userId}`).emit(`quote-notification-${userId}`, n);
    return n;
  } catch (e) {
    console.error('[quote-notify]', e.message);
    return null;
  }
}
