// Shared Event (v1): break the "one checkout" into a sequence of card charges that
// each stay under the market's per-transaction online-card limit.
//
// Why this exists: a wedding-sized Shared Event cart (venue + catering + floral)
// routinely totals well past what a single online card transaction is allowed to be
// in many markets — e.g. CA$1,500 in Canada. A single PaymentIntent for the whole
// party total just gets declined. The Shared Event already fulfils each piece with
// its own order, so each piece is already its own charge; this splits any single
// piece that is still over the cap into equal installments, and hands the checkout
// an ordered list of "segments" to charge one after another.

const round2 = (n) => Math.round((parseFloat(n ?? 0) + Number.EPSILON) * 100) / 100;

const SHARE_CATEGORIES = ['venue', 'catering', 'floral'];
const TITLE_BY_CATEGORY = { venue: 'Venue', catering: 'Catering', floral: 'Floral' };

// Per-transaction online card limits, by ISO-3166 alpha-2 country. These are the
// ceilings acquirers/regulators put on a single card-not-present transaction, not a
// Strug policy number. Extend as we onboard markets; override any entry (or the
// fallback) from the environment, e.g. EVENT_CARD_TXN_LIMIT_CA=2000.
const DEFAULT_CARD_TXN_LIMITS = {
  CA: 1500, // Canada — the case from the product thread
  US: 10000,
  GB: 10000,
  AU: 10000,
};

// Used when the buyer's country is unknown or not in the table. Deliberately low so
// an unknown market never sails past a real limit; bump via EVENT_CARD_TXN_LIMIT_DEFAULT.
const FALLBACK_CARD_TXN_LIMIT = 1500;

export function normalizeCountry(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const upper = s.toUpperCase();
  if (upper.length === 2) return upper;
  // A few long-form names we actually store on user.country.
  const byName = {
    CANADA: 'CA',
    'UNITED STATES': 'US',
    'UNITED STATES OF AMERICA': 'US',
    USA: 'US',
    'UNITED KINGDOM': 'GB',
    UK: 'GB',
    AUSTRALIA: 'AU',
  };
  return byName[upper] || null;
}

/** Per-transaction online card limit (in the buyer's currency units) for a country. */
export function cardTxnLimit(country) {
  const cc = normalizeCountry(country);
  const envFallback = Number(process.env.EVENT_CARD_TXN_LIMIT_DEFAULT);
  const fallback = Number.isFinite(envFallback) && envFallback > 0 ? envFallback : FALLBACK_CARD_TXN_LIMIT;
  if (!cc) return fallback;
  const envOverride = Number(process.env[`EVENT_CARD_TXN_LIMIT_${cc}`]);
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride;
  return DEFAULT_CARD_TXN_LIMITS[cc] ?? fallback;
}

/**
 * Split an amount into the fewest installments that each stay <= limit, cents-exact
 * (installments sum back to the original) and as even as possible.
 * @returns {number[]} one entry per installment; [] for a non-positive amount.
 */
export function splitAmount(total, limit) {
  const cents = Math.round(round2(total) * 100);
  const limitCents = Math.round(round2(limit) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return [];
  if (!Number.isFinite(limitCents) || limitCents <= 0) return [round2(total)];
  if (cents <= limitCents) return [round2(total)];

  const n = Math.ceil(cents / limitCents);
  const base = Math.floor(cents / n);
  const remainder = cents - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < remainder ? 1 : 0)) / 100);
}

/**
 * Turn a saved Shared Event cart into an ordered list of card charges.
 *
 * @param {object} args
 * @param {Record<string, {listing_id?, vendor_id?, seller_id?, title?, line_total?}>} args.cart
 *        the `package_json.cart` written by PATCH /event-concierge/plans/:id/cart
 * @param {string|null} [args.country]   buyer country (ISO-2 or a long-form name we store)
 * @param {string} [args.currency='CAD']
 * @returns {{
 *   country: string|null, currency: string, per_transaction_limit: number,
 *   grand_total: number, payment_count: number, requires_split: boolean,
 *   segments: Array<{
 *     category: string, title: string, listing_id: number|null, vendor_id: number|null,
 *     seller_id: number|null, amount: number, installment: number, installments: number
 *   }>
 * }}
 */
export function buildEventPaymentPlan({ cart, country = null, currency = 'CAD' }) {
  const limit = cardTxnLimit(country);
  const source = cart && typeof cart === 'object' && !Array.isArray(cart) ? cart : {};

  const segments = [];
  let grandTotal = 0;
  let pieceCount = 0;

  for (const category of SHARE_CATEGORIES) {
    const line = source[category];
    if (!line || typeof line !== 'object') continue;
    const amount = Number(line.line_total);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    pieceCount += 1;
    grandTotal += amount;

    const parts = splitAmount(amount, limit);
    parts.forEach((part, i) => {
      segments.push({
        category,
        title: line.title ? String(line.title).slice(0, 300) : TITLE_BY_CATEGORY[category],
        listing_id: line.listing_id != null ? parseInt(line.listing_id, 10) || null : null,
        vendor_id: line.vendor_id != null ? parseInt(line.vendor_id, 10) || null : null,
        seller_id: line.seller_id != null ? parseInt(line.seller_id, 10) || null : null,
        amount: round2(part),
        installment: i + 1,
        installments: parts.length,
      });
    });
  }

  return {
    country: normalizeCountry(country),
    currency: String(currency || 'CAD').toUpperCase().slice(0, 3),
    per_transaction_limit: round2(limit),
    grand_total: round2(grandTotal),
    payment_count: segments.length,
    // true when the checkout is more than one charge per piece (i.e. at least one
    // piece had to be split) — the frontend uses this to explain the multi-charge flow.
    requires_split: segments.length > pieceCount,
    segments,
  };
}

export const __test = { DEFAULT_CARD_TXN_LIMITS, FALLBACK_CARD_TXN_LIMIT, SHARE_CATEGORIES };
