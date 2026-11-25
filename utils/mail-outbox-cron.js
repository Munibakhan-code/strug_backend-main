/**
 * Phase 5: drain stale critical-mail outbox rows (crash recovery).
 */
import cron from 'node-cron';
import { sendEmail } from '../services/email-service.js';
import { drainMailOutbox } from '../services/mail/outbox.js';
import { logCronError } from './cron-email.js';

export async function runMailOutboxDrain(limit = 20) {
  return drainMailOutbox({
    limit,
    deliver: (opts) => sendEmail({ ...opts, __skipOutbox: true, __fromOutbox: true }),
  });
}

export function startMailOutboxCron() {
  if (process.env.MAIL_OUTBOX_DISABLED === 'true' || process.env.MAIL_OUTBOX_DISABLED === '1') {
    console.log('[Mail] Outbox drain cron skipped (MAIL_OUTBOX_DISABLED)');
    return;
  }
  cron.schedule('*/2 * * * *', async () => {
    try {
      const r = await runMailOutboxDrain(25);
      if (r.scanned > 0) {
        console.log(`[Mail] Outbox drain scanned=${r.scanned}`);
      }
    } catch (err) {
      logCronError('mail-outbox-drain', err);
    }
  });
  console.log('[Mail] Outbox drain cron initialized (every 2m).');
}
