/**
 * Property saved-search alerts cron.
 * Every 15 minutes: for each alert-enabled saved search, find newly published
 * properties matching its filters (created after last_notified_at / created_at)
 * and notify the user (in-app + web push via notify()). Optional branded email
 * when PROPERTY_SAVED_SEARCH_EMAIL=true.
 */
import prisma from './prisma-client.js';
import { notify } from '../services/notify.js';
import { logCronError } from './cron-email.js';
import { sendEmail } from './mailer.js';
import { emailLngFromUser } from './email-lang.js';
import { decrypt } from './crypto.js';
import {
  buildPublicPropertyWhere,
  filtersToPropertyQuery,
  describeSavedSearchFilters,
} from './property-filters.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleCron } from './cron-lock.js';

const BATCH = 50;
const MAX_MATCHES_PER_SEARCH = 8;

function navForVertical(vertical) {
  if (vertical === 'preconstruct') return 'preconstruct';
  return 'realestate';
}

/**
 * Run alert matching. Optionally scope to one user (manual "check now").
 * @param {import('socket.io').Server|null} io
 * @param {{ userId?: number }} [opts]
 */
export async function runPropertySavedSearchAlerts(io, opts = {}) {
  const where = { alert_enabled: true };
  if (opts.userId != null) where.user_id = Number(opts.userId);

  const searches = await prisma.property_saved_search.findMany({
    where,
    // Rotate by staleness so processing doesn't starve higher ids once there
    // are more than BATCH alert-enabled searches globally; never-notified
    // (NULL) searches come first.
    orderBy: { last_notified_at: { sort: 'asc', nulls: 'first' } },
    take: BATCH,
  });

  let notified = 0;
  let matchedTotal = 0;

  for (const search of searches) {
    try {
      const since = search.last_notified_at || search.created_at;
      const filters = search.filters && typeof search.filters === 'object' ? search.filters : {};
      const query = filtersToPropertyQuery(filters, search.vertical || undefined);
      const baseWhere = buildPublicPropertyWhere(query, null);

      const matchWhere = {
        ...baseWhere,
        AND: [
          ...(baseWhere.AND || []),
          { created_at: { gt: since } },
          { NOT: { user_id: search.user_id } },
        ],
      };

      const matches = await prisma.property.findMany({
        where: matchWhere,
        orderBy: { created_at: 'desc' },
        take: MAX_MATCHES_PER_SEARCH,
        select: {
          property_id: true,
          property_name: true,
          city: true,
          price_min: true,
          vertical: true,
        },
      });

      if (!matches.length) continue;
      matchedTotal += matches.length;

      const label = search.name || describeSavedSearchFilters(filters, search.vertical);
      const first = matches[0];
      const title = matches.length === 1
        ? 'New listing matches your search'
        : `${matches.length} new listings match your search`;
      const body = matches.length === 1
        ? `${first.property_name || 'A new listing'} — ${label}`
        : `${first.property_name || 'New listing'} and ${matches.length - 1} more — ${label}`;

      const actionNav = navForVertical(search.vertical);

      await notify(io, {
        userId: search.user_id,
        vertical: 'system',
        type: 'property.saved_search_match',
        urgency: 'ambient',
        title,
        body,
        entityType: 'property_saved_search',
        entityId: search.saved_search_id,
        actionUrl: actionNav,
        data: {
          saved_search_id: search.saved_search_id,
          property_ids: matches.map((m) => m.property_id),
          vertical: search.vertical,
          filters,
        },
      });

      if (process.env.PROPERTY_SAVED_SEARCH_EMAIL === 'true') {
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
              'property-saved-search',
              {
                name: user.name || 'there',
                headline: title,
                summary: body,
                browse_url: `${appOrigin}/${actionNav}`,
                matches: matches.map((m) => ({
                  title: m.property_name || 'Listing',
                  detail: m.city || '',
                })),
              },
              to,
              'emails.property_saved_search.subject',
              emailLngFromUser(user),
            );
          }
        } catch (mailErr) {
          console.error('Property saved-search email failed:', mailErr.message);
        }
      }

      // Advance watermark even if notify partially fails (notify is fail-open).
      await prisma.property_saved_search.update({
        where: { saved_search_id: search.saved_search_id },
        data: { last_notified_at: new Date() },
      });
      notified += 1;
    } catch (err) {
      logCronError('property-saved-search-alerts-item', err);
    }
  }

  return { searches: searches.length, notified, matchedTotal };
}

export function startPropertySavedSearchCron(io) {
  scheduleCron('property-saved-search-alerts', '*/15 * * * *', async () => {
    try {
      const r = await runPropertySavedSearchAlerts(io);
      if (r.notified > 0) {
        console.log(`🏠 [Cron SavedSearch] notified=${r.notified} matches=${r.matchedTotal} scanned=${r.searches}`);
      }
    } catch (err) {
      logCronError('property-saved-search-alerts', err);
    }
  });
  console.log('🏠 Property saved-search alerts cron initialized (every 15m).');
}
