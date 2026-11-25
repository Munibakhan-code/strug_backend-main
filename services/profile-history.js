// services/profile-history.js
//
// Best-effort profile-change recorder. Powers the User Management "Username History",
// "Display Name History" and "Verification History" sections.
//
// CONTRACT: recordProfileChange() MUST NEVER throw into or reject the caller's request
// path. It is fire-and-forget — callers do NOT await it. A logging failure must never
// turn a successful profile update into a 500. Mirrors services/activity-log.js.

import prisma from '../utils/prisma-client.js';

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * Record a single field change on a user's profile (fire-and-forget).
 * No-ops when the value didn't actually change.
 * @param {number} userId
 * @param {string} field      'handle' | 'username' | 'display_name' | 'verification' | …
 * @param {string|null} oldValue
 * @param {string|null} newValue
 * @param {{changedBy?:string, actorId?:number}} [opts]  changedBy: 'user'|'admin'|'system'
 */
export function recordProfileChange(userId, field, oldValue, newValue, opts = {}) {
  try {
    if (!userId || !field) return;
    // Skip no-op writes (e.g. PATCH with the same value).
    if (String(oldValue ?? '') === String(newValue ?? '')) return;
    const { changedBy = 'user', actorId } = opts;
    prisma.user_profile_history
      .create({
        data: {
          user_id: userId,
          field: clip(field, 64),
          old_value: clip(oldValue, 2000),
          new_value: clip(newValue, 2000),
          changed_by: clip(changedBy, 32) || 'user',
          actor_id: actorId ?? undefined,
        },
      })
      .catch((err) => console.error('[profile-history] record failed:', err?.message || err));
  } catch (err) {
    console.error('[profile-history] record threw:', err?.message || err);
  }
}
