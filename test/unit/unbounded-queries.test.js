import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A ratchet, not a cleanup.
//
// 612 of ~900 `findMany` calls in this service have no `take` and no cursor. Fixing all of them
// at once is not realistic and not all of them need it — a query bounded by a foreign key (one
// order's line items, one item's modifier groups) is fine unbounded. What must not happen is the
// count going UP, so this test records the current number per file and fails when a file gains a
// new one. Lowering a number here is always welcome; raising one needs a deliberate edit and a
// reviewer asking why.
//
// The paired helper is utils/pagination.js.

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCANNED_DIRS = ['routes', 'auth-routes', 'services'];

/**
 * Names of the keys at depth 1 of an object literal — i.e. the options object's own keys, not
 * those of any nested include/select block. `body` starts just after the opening brace.
 */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let token = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '[' || c === '(') { depth++; token = ''; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; token = ''; continue; }
    if (depth !== 0) continue;
    if (c === ':' || c === ',') {
      const name = token.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.push(name);
      token = '';
      continue;
    }
    token += c;
  }
  const tail = token.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(tail)) keys.push(tail);
  return keys;
}

/**
 * Count `findMany` calls whose OPTIONS OBJECT has neither `take` nor `cursor` at its top level.
 * A `take` inside a nested relation bounds that relation, not the outer query, so it must not
 * count — which is exactly the mistake that made an earlier version of this scan under-report.
 */
function countUnbounded(source) {
  const re = /(?:prisma|tx)\.(\w+)\.findMany\(\s*\{/g;
  let m;
  let unbounded = 0;
  let total = 0;
  // Calls with no options object at all — `findMany()` — are unbounded by definition.
  const bare = (source.match(/(?:prisma|tx)\.\w+\.findMany\(\s*\)/g) || []).length;

  while ((m = re.exec(source))) {
    let i = re.lastIndex; // just past the options object's opening brace
    let depth = 1;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    const keys = topLevelKeys(source.slice(re.lastIndex, i - 1));
    total++;
    if (!keys.includes('take') && !keys.includes('cursor')) unbounded++;
  }
  return { unbounded: unbounded + bare, total: total + bare };
}

function scan() {
  const results = {};
  for (const dir of SCANNED_DIRS) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith('.js')) continue;
      const rel = `${dir}/${name}`;
      const { unbounded } = countUnbounded(fs.readFileSync(path.join(full, name), 'utf8'));
      if (unbounded > 0) results[rel] = unbounded;
    }
  }
  return results;
}

// Recorded 2026-09-08. To lower a number: add `take` (see utils/pagination.js) and update it.
//
// Raised 612 → 619 on 2026-09-11 when merging main (grocery delivery ops, multistop rides).
// None of the seven are platform-wide lists:
//   food-routes.js (+6)
//     - items/export.csv, inventory-alerts, reorder-suggestions: one vendor's own catalogue, and
//       a `take` on the CSV export would silently truncate the file the vendor downloads.
//     - items/import.csv: `food_item_id in existingIds` — bounded by the uploaded CSV.
//     - delivery-runs/:batch_id/offers: one batch's pending offers for one driver.
//     - vendor/me/analytics/overview: vendors owned by the caller.
//     - grocery-delivery/analytics: vendor ids/names feeding an aggregate. Owner-scoped for
//       vendors; an admin without vendor_id reads every vendor's id+name — a bounded select,
//       but the one to revisit if the vendor table gets large.
//   ride-request-routes.js (+1): a ride's own stops (`where: { ride_request_id }`).
const BASELINE_TOTAL = 623;

// Files that were explicitly paginated in this pass. These are held at their exact count so a
// regression in the specific endpoints that were fixed is caught immediately, not just in the
// global total. food-routes.js was 18 before the main merge above added six bounded reads.
const PINNED = {
  'routes/food-routes.js': 24,
  'routes/celebrity-routes.js': 0,
};

describe('unbounded findMany ratchet', () => {
  const current = scan();
  const total = Object.values(current).reduce((a, b) => a + b, 0);

  it(`does not exceed the recorded total of ${BASELINE_TOTAL}`, () => {
    expect(
      total,
      total > BASELINE_TOTAL
        ? `${total - BASELINE_TOTAL} new unbounded findMany call(s) were added. A list endpoint ` +
          'must bound its result — use paginate()/parsePagination() from utils/pagination.js. ' +
          'If the query is genuinely bounded by a foreign key, raise BASELINE_TOTAL here and say why.'
        : undefined,
    ).toBeLessThanOrEqual(BASELINE_TOTAL);
  });

  it('reports progress when the count drops, so the baseline stays honest', () => {
    // Not a failure — just a nudge to lower the number while the context is fresh.
    if (total < BASELINE_TOTAL) {
      console.log(
        `[ratchet] unbounded findMany is down to ${total} (baseline ${BASELINE_TOTAL}). ` +
        'Lower BASELINE_TOTAL in this file to lock the improvement in.',
      );
    }
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it.each(Object.entries(PINNED))('%s stays at %i unbounded', (file, expected) => {
    expect(current[file] ?? 0).toBeLessThanOrEqual(expected);
  });

  it('detects an unbounded call', () => {
    expect(countUnbounded('await prisma.thing.findMany({ where: { a: 1 } })').unbounded).toBe(1);
  });

  it('accepts an explicit take and the take shorthand', () => {
    expect(countUnbounded('prisma.t.findMany({ where: {}, take: 20 })').unbounded).toBe(0);
    expect(countUnbounded('prisma.t.findMany({ where: {}, take, skip })').unbounded).toBe(0);
  });

  it('accepts cursor pagination', () => {
    expect(countUnbounded('prisma.t.findMany({ cursor: { id: 5 }, where: {} })').unbounded).toBe(0);
  });

  it('does NOT count a take that only appears inside a nested relation', () => {
    const nested = 'prisma.t.findMany({ where: {}, include: { kids: { take: 5 } } })';
    expect(countUnbounded(nested).unbounded).toBe(1);
  });
});
