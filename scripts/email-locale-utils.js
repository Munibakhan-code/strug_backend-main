import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const localesDir = path.join(__dirname, '../locales');

export function listLocaleCodes(excludeEn = true) {
  return fs
    .readdirSync(localesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!excludeEn || d.name !== 'en'))
    .map((d) => d.name)
    .sort();
}

export function localeFilePath(code) {
  return path.join(localesDir, code, 'translation.json');
}

export function readLocaleDoc(code) {
  const filePath = localeFilePath(code);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

export function writeLocaleDoc(code, doc) {
  fs.writeFileSync(localeFilePath(code), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

export function deepMergeEmails(enVal, tgtVal) {
  if (enVal !== null && typeof enVal === 'object' && !Array.isArray(enVal)) {
    const out = { ...(tgtVal && typeof tgtVal === 'object' ? tgtVal : {}) };
    for (const key of Object.keys(enVal)) {
      out[key] = deepMergeEmails(enVal[key], out[key]);
    }
    return out;
  }
  if (tgtVal !== undefined && tgtVal !== null && tgtVal !== '') return tgtVal;
  return enVal;
}

export function flatten(obj, prefix = '') {
  const out = {};
  for (const key of Object.keys(obj || {})) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'string') out[p] = obj[key];
    else Object.assign(out, flatten(obj[key], p));
  }
  return out;
}

export function unflatten(flat) {
  const root = {};
  for (const [dotPath, value] of Object.entries(flat)) {
    const parts = dotPath.split('.');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  return root;
}

export function loadEnEmailsFlat() {
  const en = readLocaleDoc('en');
  if (!en.emails) throw new Error('No emails section in locales/en/translation.json');
  return flatten(en.emails);
}

/** API / auth / errors sections (non-email backend strings). */
export const API_SECTIONS = ['errors', 'food', 'user', 'auth', 'success'];

export function loadEnApiFlat() {
  const en = readLocaleDoc('en');
  const pick = {};
  for (const sec of API_SECTIONS) {
    if (en[sec]) pick[sec] = en[sec];
  }
  if (!Object.keys(pick).length) {
    throw new Error('No API sections in locales/en/translation.json');
  }
  return flatten(pick);
}

export function mergeApiSectionsIntoDoc(doc, mergedFlat) {
  const tree = unflatten(mergedFlat);
  for (const sec of API_SECTIONS) {
    if (tree[sec]) {
      doc[sec] = { ...(doc[sec] || {}), ...tree[sec] };
    }
  }
  return doc;
}

export function readApiFlatFromDoc(doc) {
  const pick = {};
  for (const sec of API_SECTIONS) {
    if (doc[sec]) pick[sec] = doc[sec];
  }
  return flatten(pick);
}

export function syncApiSectionsFromEn(doc, enDoc = readLocaleDoc('en')) {
  for (const sec of API_SECTIONS) {
    if (enDoc[sec]) doc[sec] = deepMergeEmails(enDoc[sec], doc[sec]);
  }
  return doc;
}
