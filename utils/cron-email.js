/**
 * Step 2 (Target 4): cron-triggered emails always resolve lng from user.language.
 */
import mailerEvents from './mailer-event.js';
import { emailLngFromUser } from './email-lang.js';

/**
 * @param {string} jobId — matches CRON_INVENTORY id for logging
 * @param {Error | unknown} err
 */
export function logCronError(jobId, err) {
  const code = err?.code;
  if (code === 'P1001') return;
  const msg = err?.message || String(err);
  console.error(`[Cron ${jobId}] Error:`, msg);
}

/**
 * Emit a cron-triggered email with explicit user language resolution.
 * Requires `user` with `language` (use CRON_EMAIL_USER_SELECT in Prisma queries).
 *
 * @param {object} opts
 * @param {string} opts.jobId
 * @param {string} opts.templateName
 * @param {Record<string, unknown>} opts.variables
 * @param {string} opts.to — plaintext email
 * @param {string} opts.subjectKey
 * @param {{ email?: string; name?: string; language?: string } | null | undefined} opts.user
 */
export function emitCronEmail({ jobId, templateName, variables, to, subjectKey, user }) {
  if (!to) {
    console.warn(`[Cron ${jobId}] skip email — no recipient`);
    return;
  }
  if (!user) {
    console.warn(`[Cron ${jobId}] skip email — no user (cannot resolve lng)`);
    return;
  }

  const lng = emailLngFromUser(user);

  mailerEvents.emit('send_email', {
    templateName,
    variables,
    to,
    subjectKey,
    user: { name: user.name, language: user.language ?? lng },
    lng,
  });

  console.log(`[Cron ${jobId}] queued email [${lng}] → ${to}`);
}
