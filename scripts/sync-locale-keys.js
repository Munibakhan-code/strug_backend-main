/**
 * Ensure every supportedLngs code has locales/{lng}/translation.json
 * merged from en (missing keys filled from English).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesRoot = path.join(__dirname, '../locales');

const SUPPORTED = [
  'af', 'ar', 'az', 'bn', 'bs', 'bg', 'ca', 'cs', 'da', 'nl',
  'en', 'et', 'tl', 'fi', 'fr', 'ka', 'de', 'el', 'gu', 'ha',
  'he', 'hi', 'hu', 'is', 'ga', 'it', 'ja', 'kk', 'ko', 'lv',
  'ln', 'lt', 'lb', 'mk', 'ms', 'zh', 'ne', 'no', 'ps', 'fa',
  'pl', 'pt', 'ro', 'ru', 'sr', 'sk', 'sl', 'so', 'es', 'sw',
  'sv', 'ta', 'th', 'tr', 'ur', 'vi', 'cy',
];

function mergeFromEn(en, target) {
  if (en === null || typeof en !== 'object' || Array.isArray(en)) {
    return target !== undefined && target !== null && target !== '' ? target : en;
  }
  const out = {};
  for (const key of Object.keys(en)) {
    const enVal = en[key];
    const tgtVal = target?.[key];
    if (enVal !== null && typeof enVal === 'object' && !Array.isArray(enVal)) {
      out[key] = mergeFromEn(enVal, tgtVal);
    } else if (tgtVal !== undefined && tgtVal !== null && tgtVal !== '') {
      out[key] = tgtVal;
    } else {
      out[key] = enVal;
    }
  }
  return out;
}

const enPath = path.join(localesRoot, 'en/translation.json');
const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));

let created = 0;
let updated = 0;
for (const lng of SUPPORTED) {
  const dir = path.join(localesRoot, lng);
  const filePath = path.join(dir, 'translation.json');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    created++;
  }
  let current = {};
  if (fs.existsSync(filePath)) {
    try {
      current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      current = {};
    }
  }
  const merged = mergeFromEn(en, current);
  const prev = JSON.stringify(current);
  const next = JSON.stringify(merged);
  if (prev !== next || !fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    updated++;
    console.log(`${lng}: synced`);
  }
}
console.log(`Done. ${created} dirs created, ${updated} files written.`);
