/**
 * Merge locales/en/translation.json "emails" into every other locale folder.
 * Missing keys are filled from English; existing non-empty values are kept.
 *
 * Usage: node scripts/sync-email-locale-keys.js
 */
import {
  deepMergeEmails,
  listLocaleCodes,
  readLocaleDoc,
  writeLocaleDoc,
} from './email-locale-utils.js';

const en = readLocaleDoc('en');
const enEmails = en.emails;
if (!enEmails) {
  console.error('No emails section in en/translation.json');
  process.exit(1);
}

const targets = listLocaleCodes(true);
console.log(`Syncing emails → ${targets.length} locales...`);

for (const lng of targets) {
  const doc = readLocaleDoc(lng);
  doc.emails = deepMergeEmails(enEmails, doc.emails);
  writeLocaleDoc(lng, doc);
  console.log(`  ${lng}`);
}

console.log('Done.');
