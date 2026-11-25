import { logCronError } from './cron-email.js';
import { scheduleInterval } from './cron-lock.js';
import { flushDueScheduledChatMessages } from '../services/scheduled-chat-service.js';

/** Poll interval for due scheduled chat messages (default 15s). */
export const SCHEDULED_CHAT_FLUSH_MS = Number(process.env.SCHEDULED_CHAT_FLUSH_MS ?? 15_000);

/**
 * Deliver due scheduled chat messages even when the sender's browser is closed.
 * @param {import('socket.io').Server} io
 */
export function startScheduledChatCron(io) {
  const ms = Number.isFinite(SCHEDULED_CHAT_FLUSH_MS) && SCHEDULED_CHAT_FLUSH_MS >= 5_000
    ? SCHEDULED_CHAT_FLUSH_MS
    : 15_000;

  scheduleInterval('scheduled-chat', async () => {
    try {
      const result = await flushDueScheduledChatMessages(io);
      if (result.due > 0) {
        console.log(
          `[scheduled-chat-cron] due=${result.due} sent=${result.sent} failed=${result.failed}`,
        );
      }
    } catch (err) {
      logCronError('scheduled-chat', err);
    }
  }, ms);
}
