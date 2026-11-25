/**
 * Auto-translate locales/en emails.* strings into all backend locale files.
 * Preserves {{placeholders}}; skips keys already translated (value !== English).
 *
 * Usage:
 *   node scripts/translate-email-locales.js
 *   node scripts/translate-email-locales.js --lang=ur
 *   node scripts/translate-email-locales.js --langs=ur,hi,ar
 *   node scripts/translate-email-locales.js --force
 *   node scripts/translate-email-locales.js --dry-run
 */
import {
  flatten,
  listLocaleCodes,
  loadEnEmailsFlat,
  readLocaleDoc,
  unflatten,
  writeLocaleDoc,
} from './email-locale-utils.js';
import { parseTranslateArgs, translateLocaleFlat } from './locale-translate-core.js';

async function main() {
  const { lang: onlyLang, langs: langList, force, dryRun } = parseTranslateArgs();
  const enFlat = loadEnEmailsFlat();
  const allCodes = listLocaleCodes(true);

  let langs = onlyLang ? [onlyLang] : langList.length ? langList : allCodes;
  for (const l of langs) {
    if (l === 'en') continue;
    if (!allCodes.includes(l)) {
      console.error(`Unknown locale folder: ${l}`);
      process.exit(1);
    }
  }

  console.log(
    `Email translate: ${langs.length} locale(s), ${Object.keys(enFlat).length} keys${force ? ' [FORCE]' : ''}${dryRun ? ' [DRY RUN]' : ''}`,
  );

  for (const lang of langs) {
    const doc = readLocaleDoc(lang);
    const currentFlat = flatten(doc.emails || {});
    const mergedFlat = await translateLocaleFlat(lang, enFlat, currentFlat, { force, dryRun });
    if (!dryRun) {
      doc.emails = unflatten(mergedFlat);
      writeLocaleDoc(lang, doc);
      console.log(`  wrote locales/${lang}/translation.json`);
    }
  }

  console.log('All done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
