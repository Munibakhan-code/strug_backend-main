/**
 * Report locale translation coverage vs English master.
 * Usage:
 *   node scripts/locale-coverage-report.js
 *   node scripts/locale-coverage-report.js --frontend
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  flatten,
  listLocaleCodes,
  loadEnApiFlat,
  loadEnEmailsFlat,
  readApiFlatFromDoc,
  readLocaleDoc,
} from './email-locale-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontend = process.argv.includes('--frontend');

function report(label, enFlat, codes, getFlat) {
  const total = Object.keys(enFlat).length;
  const partial = [];
  let minPct = 100;

  for (const lng of codes.sort()) {
    const flat = getFlat(lng);
    let translated = 0;
    for (const [k, enVal] of Object.entries(enFlat)) {
      const v = flat[k];
      if (v && v !== enVal) translated++;
    }
    const pct = total ? Math.round((translated / total) * 100) : 100;
    minPct = Math.min(minPct, pct);
    if (pct < 100) partial.push({ lng, pct, untranslated: total - translated });
  }

  console.log(`\n${label}: ${total} keys × ${codes.length} locales (min ${minPct}%)`);
  if (!partial.length) {
    console.log('  ✓ 100% on all locales');
  } else {
    console.log(`  ${partial.length} locale(s) below 100%:`);
    for (const row of partial) {
      console.log(`    ${row.lng}: ${row.pct}% (${row.untranslated} untranslated)`);
    }
  }
  return partial.length === 0;
}

if (frontend) {
  const dir = path.join(__dirname, '../../strug-final-frontend/src/i18n/locales');
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
  const enFlat = flatten(en);
  const codes = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'en.json')
    .map((f) => f.replace('.json', ''));
  report('FRONTEND UI', enFlat, codes, (lng) =>
    flatten(JSON.parse(fs.readFileSync(path.join(dir, `${lng}.json`), 'utf8'))),
  );
} else {
  const codes = listLocaleCodes(true);
  const apiOk = report('BACKEND API', loadEnApiFlat(), codes, (lng) =>
    readApiFlatFromDoc(readLocaleDoc(lng)),
  );
  const emailOk = report('BACKEND EMAILS', loadEnEmailsFlat(), codes, (lng) =>
    flatten(readLocaleDoc(lng).emails || {}),
  );
  process.exit(apiOk && emailOk ? 0 : 1);
}
