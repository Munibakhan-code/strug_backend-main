/**
 * Regenerates test/verticals.manifest.json so every *.test.js is in exactly one vertical.
 *   node scripts/_gen-vertical-manifest.mjs
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const rules = [
  ['food', [/\/food-/, /\/vendor-type\.test/, /\/reservation-listing-config\.test/, /\/customer-analytics\.test/]],
  ['shop', [/\/shop-/, /\/product-/]],
  ['rideshare', [/\/ride-/, /\/rider-/, /\/active_trip/, /\/driver-safety/, /\/courier-/]],
  ['jobs', [/\/job-/, /\/jobs-/]],
  ['property', [/\/property-/]],
  ['video', [/\/video-/]],
  ['medical', [/\/medical/, /\/seller-doctors/, /\/booking-listing-geo/, /\/vertical-model-map-medical/]],
  ['wedding', [/\/wedding/, /\/book-artist/, /\/artist-booking/]],
  ['tempstay', [/\/booking-/, /\/tempstay/, /\/hotel-room/]],
  ['automotive', [/\/seller-automotive/]],
  ['raise', [/\/raise-/, /\/donation/, /\/kickstarter/, /\/campaign/]],
  ['discounts', [/\/discount/]],
  ['recruiter', [/\/recruit/, /\/referral/]],
];

function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.name.endsWith('.test.js')) out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

const files = walk(join(ROOT, 'test')).sort();
const buckets = Object.fromEntries(rules.map(([id]) => [id, []]));
buckets.core = [];
for (const f of files) {
  const hit = rules.find(([, pats]) => pats.some((re) => re.test(f)));
  buckets[hit ? hit[0] : 'core'].push(f);
}
const verticals = {};
for (const [id, tests] of Object.entries(buckets)) {
  if (tests.length) verticals[id] = { tests };
}

writeFileSync(join(ROOT, 'test/verticals.manifest.json'), `${JSON.stringify({
  comment: 'Sprint 2 coverage map. Sprint 3 will add watch globs + select-tests.js. Every *.test.js must appear in exactly one vertical.',
  testGlobs: ['test/**/*.test.js'],
  fullSuiteTriggers: [
    'package.json', 'package-lock.json', 'prisma/schema.prisma',
    'app.js', 'index.js', 'vitest.config.js', 'scripts/guard-*.js', '.github/**',
  ],
  verticals,
}, null, 2)}\n`);

console.log(Object.entries(verticals).map(([id, v]) => `${id}: ${v.tests.length}`).join('\n'));
console.log('total', files.length);
