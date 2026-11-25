/**
 * Shared customer-analytics segmentation (#327). Pure + DB-agnostic so every selling
 * vertical (food, product/ecommerce, service, …) can feed its own paid-order rows in
 * and get the same segmentation shape back for the SellerAnalyticsPanel "Customers" card.
 *
 * Feed the provider's LIFETIME paid orders (not just the range) — segments like
 * returning / lapsed / churned / one-and-done are only meaningful against full history.
 *
 * @param {Array<{customer_id:any, at:Date|string, amount:number}>} orders
 * @param {{now?:Date|string, newDays?:number, lapsedDays?:number, churnedDays?:number, vipPct?:number, audienceSize?:number}} [opts]
 */
export function computeCustomerSegments(orders, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : opts.now ? new Date(opts.now) : new Date();
  const newDays = opts.newDays ?? 30;
  const lapsedDays = opts.lapsedDays ?? 30;
  const churnedDays = opts.churnedDays ?? 90;
  const vipPct = opts.vipPct ?? 0.1;
  const audienceSize = Math.max(0, Number(opts.audienceSize) || 0);
  const DAY = 86400000;

  // Aggregate per customer: order count, total spend, first + last order timestamps.
  const byCustomer = new Map();
  for (const o of Array.isArray(orders) ? orders : []) {
    const id = o?.customer_id;
    if (id == null) continue;
    const at = o.at instanceof Date ? o.at : new Date(o.at);
    if (Number.isNaN(at.getTime())) continue;
    const amount = Number(o.amount) || 0;
    let c = byCustomer.get(id);
    if (!c) { c = { count: 0, spend: 0, first: at, last: at }; byCustomer.set(id, c); }
    c.count += 1;
    c.spend += amount;
    if (at < c.first) c.first = at;
    if (at > c.last) c.last = at;
  }

  const customers = [...byCustomer.values()];
  const total = customers.length;
  const daysSince = (d) => (now.getTime() - d.getTime()) / DAY;

  let newCustomers = 0, returning = 0, oneAndDone = 0;
  let lapsed = 0, churned = 0, active = 0;
  let totalOrders = 0, totalSpend = 0;
  for (const c of customers) {
    totalOrders += c.count;
    totalSpend += c.spend;
    if (daysSince(c.first) <= newDays) newCustomers += 1;
    if (c.count >= 2) returning += 1; else oneAndDone += 1;
    const recency = daysSince(c.last);
    if (recency > churnedDays) churned += 1;
    else if (recency > lapsedDays) lapsed += 1;
    else active += 1;
  }

  // VIP = the top vipPct of customers by lifetime spend (the top decile by default).
  // Take exactly the top-N after sorting — a spend threshold would over-count when many
  // customers tie at the boundary value (e.g. everyone with one same-price order).
  let vip = 0;
  if (total) {
    const spenders = customers.filter((c) => c.spend > 0).length;
    if (spenders) vip = Math.min(Math.max(1, Math.round(total * vipPct)), spenders);
  }

  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);

  return {
    total_customers: total,
    new_customers: newCustomers,
    returning_customers: returning,
    one_and_done: oneAndDone,
    lapsed_customers: lapsed,
    churned_customers: churned,
    active_customers: active,
    recent_buyers: active,
    non_buyers: Math.max(0, audienceSize - total),
    reachable_audience: audienceSize,
    vip_customers: Math.min(vip, total),
    repeat_rate_pct: pct(returning),
    avg_orders_per_customer: total ? Math.round((totalOrders / total) * 100) / 100 : 0,
    avg_ltv: total ? Math.round((totalSpend / total) * 100) / 100 : 0,
    thresholds: { new_days: newDays, lapsed_days: lapsedDays, churned_days: churnedDays },
  };
}

/** Canonical Opportunities audience keys accepted on promotions. */
export const FOOD_AUDIENCE_SEGMENTS = new Set([
  'prospects',
  'recent',
  'vip',
  'atrisk',
  'churned',
  'oneshot',
]);

export function normalizeAudienceSegment(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  const aliases = {
    non_buyers: 'prospects',
    first_order: 'prospects',
    firstorder: 'prospects',
    recent_buyers: 'recent',
    active: 'recent',
    upsell: 'recent',
    lapsed: 'atrisk',
    at_risk: 'atrisk',
    one_and_done: 'oneshot',
    oneshot: 'oneshot',
  };
  const key = aliases[s] || s;
  return FOOD_AUDIENCE_SEGMENTS.has(key) ? key : null;
}

/**
 * Classify one customer against a vendor's lifetime paid-order history.
 * `orders` = [{ customer_id, at, amount }, ...] for the whole vendor (same feed as segments).
 */
export function classifyCustomerAgainstVendorOrders(customerId, orders, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : opts.now ? new Date(opts.now) : new Date();
  const newDays = opts.newDays ?? 30;
  const lapsedDays = opts.lapsedDays ?? 30;
  const churnedDays = opts.churnedDays ?? 90;
  const vipPct = opts.vipPct ?? 0.1;
  const DAY = 86400000;
  const uid = customerId == null ? null : String(customerId);

  const byCustomer = new Map();
  for (const o of Array.isArray(orders) ? orders : []) {
    const id = o?.customer_id;
    if (id == null) continue;
    const at = o.at instanceof Date ? o.at : new Date(o.at);
    if (Number.isNaN(at.getTime())) continue;
    const amount = Number(o.amount) || 0;
    let c = byCustomer.get(String(id));
    if (!c) { c = { count: 0, spend: 0, first: at, last: at }; byCustomer.set(String(id), c); }
    c.count += 1;
    c.spend += amount;
    if (at < c.first) c.first = at;
    if (at > c.last) c.last = at;
  }

  const mine = uid ? byCustomer.get(uid) : null;
  if (!mine) {
    return {
      prospects: true,
      recent: false,
      vip: false,
      atrisk: false,
      churned: false,
      oneshot: false,
      order_count: 0,
      lifetime_spend: 0,
    };
  }

  const recency = (now.getTime() - mine.last.getTime()) / DAY;
  const recent = recency <= lapsedDays;
  const atrisk = recency > lapsedDays && recency <= churnedDays;
  const churned = recency > churnedDays;
  const oneshot = mine.count === 1;

  let vip = false;
  const spenders = [...byCustomer.entries()]
    .filter(([, c]) => c.spend > 0)
    .sort((a, b) => b[1].spend - a[1].spend || String(a[0]).localeCompare(String(b[0])));
  if (spenders.length) {
    const vipCount = Math.min(Math.max(1, Math.round(byCustomer.size * vipPct)), spenders.length);
    const vipIds = new Set(spenders.slice(0, vipCount).map(([id]) => id));
    vip = vipIds.has(uid);
  }

  return {
    prospects: false,
    recent,
    vip,
    atrisk,
    churned,
    oneshot,
    order_count: mine.count,
    lifetime_spend: mine.spend,
    is_new: ((now.getTime() - mine.first.getTime()) / DAY) <= newDays,
  };
}

export function customerMatchesAudienceSegment(flags, segment) {
  const key = normalizeAudienceSegment(segment);
  if (!key) return true; // no segment restriction
  if (!flags || typeof flags !== 'object') return false;
  return !!flags[key];
}
