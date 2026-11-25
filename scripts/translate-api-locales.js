/**
 * Auto-translate locales/en API sections into all backend locale files.
 * Sections: errors, food, user, auth, success
 */
import {
  listLocaleCodes,
  loadEnApiFlat,
  mergeApiSectionsIntoDoc,
  readApiFlatFromDoc,
  readLocaleDoc,
  writeLocaleDoc,
} from './email-locale-utils.js';
import { parseTranslateArgs, translateLocaleFlat } from './locale-translate-core.js';

async function main() {
  const { lang: onlyLang, langs: langList, force, dryRun } = parseTranslateArgs();
  const enFlat = loadEnApiFlat();
  const allCodes = listLocaleCodes(true);

  let langs = onlyLang ? [onlyLang] : langList.length ? langList : allCodes;
  for (const l of langs) {
    if (!allCodes.includes(l)) {
      console.error(`Unknown locale folder: ${l}`);
      process.exit(1);
    }
  }

  console.log(
    `API translate: ${langs.length} locale(s), ${Object.keys(enFlat).length} keys${force ? ' [FORCE]' : ''}${dryRun ? ' [DRY RUN]' : ''}`,
  );

  for (const lang of langs) {
    const doc = readLocaleDoc(lang);
    const currentFlat = readApiFlatFromDoc(doc);
    const mergedFlat = await translateLocaleFlat(lang, enFlat, currentFlat, { force, dryRun });
    if (!dryRun) {
      mergeApiSectionsIntoDoc(doc, mergedFlat);
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
