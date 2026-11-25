/**
 * Merge locales/en API sections (errors, auth, user, food, success) into all locale folders.
 */
import {
  listLocaleCodes,
  readLocaleDoc,
  syncApiSectionsFromEn,
  writeLocaleDoc,
} from './email-locale-utils.js';

const en = readLocaleDoc('en');
const targets = listLocaleCodes(true);
console.log(`Syncing API strings → ${targets.length} locales...`);

for (const lng of targets) {
  const doc = readLocaleDoc(lng);
  syncApiSectionsFromEn(doc, en);
  writeLocaleDoc(lng, doc);
  console.log(`  ${lng}`);
}

console.log('Done.');
