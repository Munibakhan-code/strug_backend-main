// services/activity-log.js
//
// Best-effort user-activity recorder. Powers the User Management "Live Activity"
// dashboard (and Login / Failed-Login views going forward).
//
// CONTRACT: recordActivity() MUST NEVER throw into or reject the caller's request
// path. It is fire-and-forget — callers do NOT await it. A logging failure must
// never turn a successful login/signup into a 500.

import prisma from '../utils/prisma-client.js';

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

// Pull a best-guess client IP without assuming a particular proxy config.
export function clientIp(req) {
  const fwd = req?.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req?.ip || null;
}

/**
 * Record a user activity event (fire-and-forget).
 * @param {number} userId
 * @param {string} type  e.g. 'user.signup' | 'auth.login' | 'auth.login_failed'
 * @param {{description?:string, ip?:string, userAgent?:string, metadata?:object, source?:string}} [opts]
 */
export function recordActivity(userId, type, opts = {}) {
  try {
    if (!userId || !type) return;
    const { description, ip, userAgent, metadata, source = 'live' } = opts;
    // Don't await — isolate all failure inside the promise chain.
    prisma.user_activity_event
      .create({
        data: {
          user_id: userId,
          type: clip(type, 64),
          description: clip(description, 500),
          ip_address: clip(ip, 45),
          user_agent: clip(userAgent, 300),
          source: clip(source, 16) || 'live',
          metadata: metadata ?? undefined,
        },
      })
      .catch((err) => console.error('[activity-log] record failed:', err?.message || err));
  } catch (err) {
    console.error('[activity-log] record threw:', err?.message || err);
  }
}
