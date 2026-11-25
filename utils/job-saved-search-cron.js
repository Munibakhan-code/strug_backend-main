/**
 * Job saved-search alerts cron (Phase 5).
 * Every 15 minutes: match newly posted open jobs against alert-enabled searches.
 */
import prisma from './prisma-client.js';
import { notify } from '../services/notify.js';
import { logCronError } from './cron-email.js';
import { sendEmail } from './mailer.js';
import { emailLngFromUser } from './email-lang.js';
import { decrypt } from './crypto.js';
import {
  buildPublicJobWhere,
  filtersToJobQuery,
  describeJobSavedSearchFilters,
  isJobSavedSearchDue,
} from './job-filters.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleCron } from './cron-lock.js';

const BATCH = 50;
const MAX_MATCHES_PER_SEARCH = 8;

/**
 * @param {import('socket.io').Server|null} io
 * @param {{ userId?: number }} [opts]
 */
export async function runJobSavedSearchAlerts(io, opts = {}) {
  const where = { alert_enabled: true };
  if (opts.userId != null) where.user_id = Number(opts.userId);

  const searches = await prisma.job_saved_search.findMany({
    where,
    orderBy: { last_notified_at: { sort: 'asc', nulls: 'first' } },
    take: BATCH,
  });

  let notified = 0;
  let matchedTotal = 0;

  for (const search of searches) {
    try {
      if (!isJobSavedSearchDue(search)) continue;

      const since = search.last_notified_at || search.created_at;
      const filters = search.filters && typeof search.filters === 'object' ? search.filters : {};
      const query = filtersToJobQuery(filters);
      const baseWhere = buildPublicJobWhere(query);

      const matchWhere = {
        ...baseWhere,
        AND: [
          ...(baseWhere.AND || []),
          { posted_date: { gt: since } },
        ],
      };

      const matches = await prisma.jobs.findMany({
        where: matchWhere,
        orderBy: [{ posted_date: 'desc' }, { job_id: 'desc' }],
        take: MAX_MATCHES_PER_SEARCH,
        select: {
          job_id: true,
          job_name: true,
          location: true,
          is_remote: true,
          salary_min: true,
          salary_max: true,
        },
      });

      if (!matches.length) continue;
      matchedTotal += matches.length;

      const label = search.name || describeJobSavedSearchFilters(filters);
      const first = matches[0];
      const title = matches.length === 1
        ? 'New job matches your search'
        : `${matches.length} new jobs match your search`;
      const body = matches.length === 1
        ? `${first.job_name || 'A new role'} — ${label}`
        : `${first.job_name || 'New role'} and ${matches.length - 1} more — ${label}`;

      await notify(io, {
        userId: search.user_id,
        vertical: 'jobs',
        type: 'job.saved_search_match',
        urgency: 'ambient',
        title,
        body,
        entityType: 'job_saved_search',
        entityId: search.saved_search_id,
        actionUrl: 'jobs',
        data: {
          saved_search_id: search.saved_search_id,
          job_ids: matches.map((m) => m.job_id),
          filters,
        },
      });

      if (process.env.JOB_SAVED_SEARCH_EMAIL === 'true') {
        try {
          const user = await prisma.user.findUnique({
            where: { user_id: search.user_id },
            select: { email: true, name: true, language: true },
          });
          if (user?.email) {
            let to = user.email;
            try { to = decrypt(user.email); } catch { /* plain */ }
            const appOrigin = (process.env.FRONTEND_URL || 'https://app.strug.ca').replace(/\/$/, '');
            await sendEmail(
              'job-saved-search',
              {
                name: user.name || 'there',
                headline: title,
                summary: body,
                browse_url: `${appOrigin}/jobs`,
                matches: matches.map((m) => ({
                  title: m.job_name || 'Role',
                  detail: m.is_remote ? 'Remote' : (m.location || ''),
                })),
              },
              to,
              'emails.job_saved_search.subject',
              emailLngFromUser(user),
            );
          }
        } catch (mailErr) {
          console.error('Job saved-search email failed:', mailErr.message);
        }
      }

      await prisma.job_saved_search.update({
        where: { saved_search_id: search.saved_search_id },
        data: { last_notified_at: new Date() },
      });
      notified += 1;
    } catch (err) {
      logCronError('job-saved-search-alerts-item', err);
    }
  }

  return { searches: searches.length, notified, matchedTotal };
}

export function startJobSavedSearchCron(io) {
  scheduleCron('job-saved-search-alerts', '*/15 * * * *', async () => {
    try {
      await runJobSavedSearchAlerts(io);
    } catch (err) {
      logCronError('job-saved-search-alerts', err);
    }
  });
}
