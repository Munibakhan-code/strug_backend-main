/**
 * Re-translate email keys that contain "Strug" in English but lost the brand in target locales.
 */
import {
  flatten,
  listLocaleCodes,
  loadEnEmailsFlat,
  readLocaleDoc,
  unflatten,
  writeLocaleDoc,
} from './email-locale-utils.js';
import { translateLocaleFlat } from './locale-translate-core.js';

const enFlat = loadEnEmailsFlat();
const brandKeys = Object.fromEntries(
  Object.entries(enFlat).filter(([, v]) => /Strug/i.test(v)),
);

console.log(`Fixing ${Object.keys(brandKeys).length} Strug email keys across locales...`);

for (const lang of listLocaleCodes(true)) {
  const doc = readLocaleDoc(lang);
  const currentFlat = flatten(doc.emails || {});
  const subset = {};
  for (const [key, enVal] of Object.entries(brandKeys)) {
    const cur = currentFlat[key];
    if (!cur || !/Strug/i.test(cur)) subset[key] = enVal;
  }
  if (!Object.keys(subset).length) {
    console.log(`  ${lang}: ok`);
    continue;
  }
  console.log(`  ${lang}: fixing ${Object.keys(subset).length} keys`);
  const fixed = await translateLocaleFlat(lang, subset, subset, { force: true, dryRun: false });
  Object.assign(currentFlat, fixed);
  doc.emails = unflatten(currentFlat);
  writeLocaleDoc(lang, doc);
}

console.log('Brand fix done.');
