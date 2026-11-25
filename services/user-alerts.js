// services/user-alerts.js
//
// Reconciles user_alert rows from existing risk signals for the User Management
// "Alerts & Warnings" dashboard. There's no dedicated alerting pipeline in the
// platform, so this DERIVES alerts from data we already have:
//   - banned profile        → critical 'account.banned'
//   - shadow-banned profile → warning  'account.shadow_banned'
//   - negative wallet balance → warning 'wallet.negative_balance'
//   - non-active wallet status → info  'wallet.frozen'
//
// syncUserAlerts() is a full reconcile: it upserts current conditions (re-opening a
// previously-resolved alert if the condition recurs) and auto-resolves open alerts
// whose condition has cleared. Cheap at current scale (a few hundred users).

import prisma from '../utils/prisma-client.js';

const num = (d) => (d == null ? 0 : Number(d));
const key = (userId, type) => `${userId}:${type}`;

// Build the set of alerts the current data implies.
async function computeDesired() {
  const [profiles, wallets] = await Promise.all([
    prisma.social_profile.findMany({
      where: { OR: [{ is_banned: true }, { is_shadow_banned: true }] },
      select: { user_id: true, is_banned: true, is_shadow_banned: true },
    }),
    prisma.strug_wallet.findMany({
      where: { OR: [{ balance: { lt: 0 } }, { status: { not: 'active' } }] },
      select: { user_id: true, balance: true, status: true, currency: true },
    }),
  ]);

  const desired = new Map(); // key → { user_id, type, severity, message }
  const add = (userId, type, severity, message) => {
    if (userId == null) return;
    desired.set(key(userId, type), { user_id: userId, type, severity, message });
  };

  for (const p of profiles) {
    if (p.is_banned) add(p.user_id, 'account.banned', 'critical', 'Account is banned (profile suspended).');
    if (p.is_shadow_banned) add(p.user_id, 'account.shadow_banned', 'warning', 'Account is shadow-banned.');
  }
  for (const w of wallets) {
    const bal = num(w.balance);
    if (bal < 0) add(w.user_id, 'wallet.negative_balance', 'warning', `Wallet balance is negative (${bal.toFixed(2)} ${w.currency || 'CAD'}).`);
    if (w.status && w.status !== 'active') add(w.user_id, 'wallet.frozen', 'info', `Wallet status is "${w.status}" (not active).`);
  }
  return desired;
}

export async function syncUserAlerts() {
  const desired = await computeDesired();
  const existing = await prisma.user_alert.findMany({ select: { alert_id: true, user_id: true, type: true, status: true } });
  const existingByKey = new Map(existing.map((a) => [key(a.user_id, a.type), a]));

  const summary = { created: 0, reopened: 0, updated: 0, resolved: 0 };

  // Upsert current conditions.
  for (const [k, d] of desired) {
    const prev = existingByKey.get(k);
    if (!prev) {
      await prisma.user_alert.create({
        data: { user_id: d.user_id, type: d.type, severity: d.severity, message: d.message, status: 'open' },
      });
      summary.created++;
    } else if (prev.status === 'resolved') {
      // Condition recurred — re-open.
      await prisma.user_alert.update({
        where: { alert_id: prev.alert_id },
        data: { severity: d.severity, message: d.message, status: 'open' },
      });
      summary.reopened++;
    } else {
      await prisma.user_alert.update({
        where: { alert_id: prev.alert_id },
        data: { severity: d.severity, message: d.message },
      });
      summary.updated++;
    }
  }

  // Auto-resolve alerts whose condition no longer holds.
  for (const a of existing) {
    if (a.status === 'resolved') continue;
    if (!desired.has(key(a.user_id, a.type))) {
      await prisma.user_alert.update({ where: { alert_id: a.alert_id }, data: { status: 'resolved' } });
      summary.resolved++;
    }
  }

  return summary;
}
