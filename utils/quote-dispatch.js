import prisma from './prisma-client.js';
import { notifyQuote, quoteActionUrl } from './quote-notify.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleInterval } from './cron-lock.js';

// How long a quote request stays open before auto-expiring (no activity).
export const QUOTE_REQUEST_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

// Find providers eligible to receive a request: active, serving the request's leaf
// category, and serving the same city (case-insensitive). Country is a HARD filter when
// the request specifies one — quotes never cross a country border. Late-joining providers
// match too, since this is evaluated dynamically (no stored recipient list).
export async function findMatchingProviders({ categoryId, city, country }) {
  if (!categoryId || !city) return [];
  const cityFilter = { city: { equals: String(city), mode: 'insensitive' } };
  if (country) cityFilter.country = { equals: String(country), mode: 'insensitive' };

  return prisma.quote_provider.findMany({
    where: {
      is_active: true,
      quote_provider_category: { some: { quote_category_id: Number(categoryId) } },
      quote_provider_city: { some: cityFilter },
    },
    select: { quote_provider_id: true, user_id: true, business_name: true },
  });
}

// Same matching rule as findMatchingProviders, but returns richer public fields so the
// requester's page can PREVIEW who would receive the request (name, type, rating, bio)
// before actually creating one. Read-only — no request is created and no provider is
// notified. Capped so a busy city can't return an unbounded list.
export async function previewMatchingProviders({ categoryId, city, country, limit = 24 }) {
  if (!categoryId || !city) return [];
  const cityFilter = { city: { equals: String(city), mode: 'insensitive' } };
  if (country) cityFilter.country = { equals: String(country), mode: 'insensitive' };

  return prisma.quote_provider.findMany({
    where: {
      is_active: true,
      quote_provider_category: { some: { quote_category_id: Number(categoryId) } },
      quote_provider_city: { some: cityFilter },
    },
    select: {
      quote_provider_id: true,
      business_name: true,
      provider_type: true,
      rating: true,
      bio: true,
      // Public service areas only — never user_id (used for country-mismatch hints).
      quote_provider_city: { select: { city: true, country: true } },
    },
    orderBy: [{ rating: 'desc' }, { quote_provider_id: 'asc' }],
    take: Math.min(Number(limit) || 24, 50),
  });
}

// True if a provider is eligible for a request: serves its category and a city matching
// the request's city, with the same country when the request specifies one. Mirrors the
// rule in findMatchingProviders so the requester's matched set and the provider's inbox
// stay consistent.
export function providerMatchesRequest(provider, request) {
  if (!provider || !request) return false;
  const servesCategory = (provider.quote_provider_category || []).some(
    (pc) => pc.quote_category_id === request.category_id,
  );
  if (!servesCategory) return false;
  const reqCity = (request.city || '').toLowerCase();
  const reqCountry = (request.country || '').toLowerCase();
  return (provider.quote_provider_city || []).some((c) => {
    if ((c.city || '').toLowerCase() !== reqCity) return false;
    if (reqCountry) return (c.country || '').toLowerCase() === reqCountry;
    return true;
  });
}

// The provider's inbox: open/quoted requests in their categories + serviced cities.
// Country is applied per the same rule as broadcast matching (post-filtered in JS).
export async function findRequestsForProvider(providerId, { includeQuoted = true } = {}) {
  const provider = await prisma.quote_provider.findUnique({
    where: { quote_provider_id: Number(providerId) },
    include: { quote_provider_city: true, quote_provider_category: { select: { quote_category_id: true } } },
  });
  if (!provider || !provider.is_active) return [];
  const catIds = provider.quote_provider_category.map((c) => c.quote_category_id);
  if (!catIds.length || !provider.quote_provider_city.length) return [];

  const statuses = includeQuoted ? ['open', 'quoted'] : ['open'];
  const candidates = await prisma.quote_request.findMany({
    where: {
      status: { in: statuses },
      category_id: { in: catIds },
      OR: provider.quote_provider_city.map((c) => ({ city: { equals: c.city, mode: 'insensitive' } })),
    },
    orderBy: { created_at: 'desc' },
    include: {
      quote_category: { select: { name: true, slug: true, vertical: true } },
      quote: { where: { provider_id: Number(providerId) }, orderBy: { created_at: 'desc' } },
    },
  });
  // Apply the country rule and surface whether this provider already quoted.
  return candidates
    .filter((r) => providerMatchesRequest(provider, r))
    .map((r) => {
      const mine = (r.quote || []).find((q) => q.status === 'active') || (r.quote || [])[0] || null;
      const { quote, ...rest } = r;
      return { ...rest, my_quote: mine };
    });
}

// CRM-style pipeline: live inbox leads PLUS later-stage deals this provider already
// participated in (appointment_set / deal_closed where they have a quote). Powers the
// provider Kanban without leaking other brokers' closed deals.
export async function findPipelineForProvider(providerId) {
  const pid = Number(providerId);
  const inbox = await findRequestsForProvider(pid);

  const advanced = await prisma.quote_request.findMany({
    where: {
      status: { in: ['appointment_set', 'deal_closed'] },
      quote: { some: { provider_id: pid } },
    },
    orderBy: { updated_at: 'desc' },
    take: 80,
    include: {
      quote_category: { select: { name: true, slug: true, vertical: true } },
      quote: { where: { provider_id: pid }, orderBy: { created_at: 'desc' } },
      quote_appointment: {
        where: { status: { not: 'cancelled' }, provider_id: pid },
        orderBy: { scheduled_at: 'desc' },
        take: 1,
        select: { quote_appointment_id: true, scheduled_at: true, status: true, meeting_type: true },
      },
    },
  });

  const seen = new Set(inbox.map((r) => r.quote_request_id));
  const later = advanced
    .filter((r) => !seen.has(r.quote_request_id))
    .map((r) => {
      const mine =
        (r.quote || []).find((q) => q.status === 'active' || q.status === 'selected') ||
        (r.quote || [])[0] ||
        null;
      const { quote, quote_appointment, ...rest } = r;
      return {
        ...rest,
        my_quote: mine,
        appointment: (quote_appointment && quote_appointment[0]) || null,
        is_winner: rest.status === 'deal_closed' && rest.selected_quote_id != null && mine?.quote_id === rest.selected_quote_id,
      };
    });

  // Annotate inbox rows with stage helpers the Kanban expects.
  const early = inbox.map((r) => ({
    ...r,
    appointment: null,
    is_winner: false,
  }));

  return [...early, ...later];
}

// Soft prospect lists for the provider Prospects tab. No external CRM — derived from
// quote_request activity in the provider's cities/categories:
//   switching  = open/quoted shoppers still comparing (matched inbox leads)
//   renewing   = recently expired searches in-area + own closed deals older than ~11 months
// Identity is anonymised (no requester name/email); quote_request_id is kept so the
// provider can jump into a matched lead from Inbox.
export async function findProspectsForProvider(providerId) {
  const pid = Number(providerId);
  const provider = await prisma.quote_provider.findUnique({
    where: { quote_provider_id: pid },
    include: { quote_provider_city: true, quote_provider_category: { select: { quote_category_id: true } } },
  });
  if (!provider || !provider.is_active) return { switching: [], renewing: [] };
  const catIds = provider.quote_provider_category.map((c) => c.quote_category_id);
  if (!catIds.length || !provider.quote_provider_city.length) return { switching: [], renewing: [] };

  const now = new Date();
  const expiredSince = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const renewalCutoff = new Date(now.getTime() - 300 * 24 * 60 * 60 * 1000);

  const cityOr = provider.quote_provider_city.map((c) => ({
    city: { equals: c.city, mode: 'insensitive' },
  }));

  const [shopping, expired, oldWins] = await Promise.all([
    prisma.quote_request.findMany({
      where: {
        status: { in: ['open', 'quoted'] },
        category_id: { in: catIds },
        OR: cityOr,
      },
      orderBy: { created_at: 'desc' },
      take: 40,
      include: {
        quote_category: { select: { name: true, slug: true, vertical: true } },
        quote: { select: { quote_id: true, provider_id: true, status: true } },
      },
    }),
    prisma.quote_request.findMany({
      where: {
        status: 'expired',
        category_id: { in: catIds },
        OR: cityOr,
        updated_at: { gte: expiredSince },
      },
      orderBy: { updated_at: 'desc' },
      take: 40,
      include: {
        quote_category: { select: { name: true, slug: true, vertical: true } },
        _count: { select: { quote: true } },
      },
    }),
    prisma.quote_request.findMany({
      where: {
        status: 'deal_closed',
        category_id: { in: catIds },
        OR: cityOr,
        updated_at: { lte: renewalCutoff },
        quote: { some: { provider_id: pid, status: 'selected' } },
      },
      orderBy: { updated_at: 'desc' },
      take: 20,
      include: {
        quote_category: { select: { name: true, slug: true, vertical: true } },
        _count: { select: { quote: true } },
      },
    }),
  ]);

  const switching = shopping
    .filter((r) => providerMatchesRequest(provider, r))
    .map((r) => {
      const mine = (r.quote || []).some((q) => q.provider_id === pid && ['active', 'selected'].includes(q.status));
      const others = (r.quote || []).filter((q) => q.provider_id !== pid && q.status === 'active').length;
      return {
        quote_request_id: r.quote_request_id,
        title: r.title,
        city: r.city,
        country: r.country,
        vertical: r.vertical,
        category: r.quote_category?.name || null,
        status: r.status,
        signal: others > 0 ? 'comparing' : mine ? 'your_quote_pending' : 'new_shopper',
        quote_count: (r.quote || []).length,
        has_my_quote: mine,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });

  const renewingFromExpired = expired
    .filter((r) => providerMatchesRequest(provider, r))
    .map((r) => ({
      quote_request_id: r.quote_request_id,
      title: r.title,
      city: r.city,
      country: r.country,
      vertical: r.vertical,
      category: r.quote_category?.name || null,
      status: r.status,
      signal: 'expired_search',
      quote_count: r._count?.quote || 0,
      has_my_quote: false,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

  const renewingFromWins = oldWins
    .filter((r) => providerMatchesRequest(provider, r))
    .map((r) => ({
      quote_request_id: r.quote_request_id,
      title: r.title,
      city: r.city,
      country: r.country,
      vertical: r.vertical,
      category: r.quote_category?.name || null,
      status: r.status,
      signal: 'renewal_window',
      quote_count: r._count?.quote || 0,
      has_my_quote: true,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));

  return {
    switching,
    renewing: [...renewingFromWins, ...renewingFromExpired].slice(0, 40),
  };
}

// Notify matched providers that a new request is available: a live socket event plus a
// persisted bell notification. Each provider has a personal room `user-<user_id>`.
export async function broadcastQuoteRequest(io, request, providers) {
  if (!Array.isArray(providers)) return;
  const where = [request.vertical, request.city].filter(Boolean).join(' in ');
  await Promise.all(
    providers.map((p) => {
      if (!p.user_id) return null;
      io?.to(`user-${p.user_id}`).emit('quote-request-new', {
        quote_request_id: request.quote_request_id,
        category_id: request.category_id,
        vertical: request.vertical,
        city: request.city,
        country: request.country,
        title: request.title,
        created_at: request.created_at,
      });
      const quoteBody = where ? `New ${where} — send a quote.` : 'A new request matches you.';
      // Writes the legacy quote_notification row AND mirrors into the unified bell as an actionable
      // lead (see quote-notify.js). No expiresAt: a quote lead has a 72h TTL, not a short per-offer
      // countdown, so the ClaimCard should not auto-dismiss it.
      return notifyQuote(io, p.user_id, 'new_request', {
        quote_request_id: request.quote_request_id,
        title: 'New quote request',
        body: quoteBody,
        unified: {
          body: request.title || quoteBody,
          // The recipient is the PROVIDER, so deep-link to their provider dashboard for this
          // vertical (sd-insurance / sd-mortgage), not the public page.
          actionUrl: quoteActionUrl(request.vertical, { provider: true }),
          data: { category_id: request.category_id, vertical: request.vertical, city: request.city },
        },
      });
    }),
  );
}

// Auto-expire requests past their TTL that nobody acted on (still open/quoted, no
// appointment set). Returns the number expired.
export async function expireStaleQuoteRequests() {
  const now = new Date();
  const { count } = await prisma.quote_request.updateMany({
    where: { status: { in: ['open', 'quoted'] }, expires_at: { lt: now } },
    data: { status: 'expired', updated_at: now },
  });
  return count;
}

export function startQuoteExpiryCron() {
  scheduleInterval('quote-expiry', () => {
    expireStaleQuoteRequests().catch((e) => console.error('[quote-expiry] error:', e.message));
  }, 60 * 1000); // every minute
}
