import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const DELIM = '\n__STRUG_LOCALE_SPLIT__\n';
const PH_RE = /\{\{[^}]+\}\}/g;
const BATCH_CHARS = 2800;
const BATCH_ITEMS = 25;
export const REQUEST_DELAY_MS = 900;
const CURL_TIMEOUT_SEC = 120;

/** Folder code → Google Translate target */
export const GOOGLE_LANG = {
  tl: 'fil',
  fil: 'fil',
  no: 'no',
  zh: 'zh-CN',
};

/** Brand terms kept untranslated */
const BRAND_TERMS = ['Strug', 'STRUG'];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function protectTerms(text) {
  const map = new Map();
  let i = 0;
  let out = String(text);

  for (const term of BRAND_TERMS) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    out = out.replace(re, () => {
      const token = `__BR${i}__`;
      map.set(token, term);
      i += 1;
      return token;
    });
  }

  out = out.replace(PH_RE, (m) => {
    const token = `__PH${i}__`;
    map.set(token, m);
    i += 1;
    return token;
  });

  return { text: out, map };
}

function restoreTerms(text, map) {
  let out = String(text);
  for (const [token, orig] of map) {
    out = out.split(token).join(orig);
  }
  return out;
}

async function googleTranslate(text, targetLang) {
  const tl = GOOGLE_LANG[targetLang] || targetLang;
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const { stdout } = await execFileAsync(
        'curl.exe',
        ['-s', '--max-time', String(CURL_TIMEOUT_SEC), url],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      const raw = String(stdout || '').trim();
      if (!raw || raw.startsWith('<')) {
        throw new Error(`Non-JSON translate response (${raw.slice(0, 40)}…)`);
      }
      const data = JSON.parse(raw);
      if (!data?.[0]) throw new Error('Invalid translate response');
      return data[0].map((x) => x[0]).join('');
    } catch (err) {
      const msg = String(err?.message || err);
      const retryable = /429|503|timeout|ETIMEDOUT|Invalid|Non-JSON|Unexpected token|JSON/i.test(msg);
      if (attempt < 7 && retryable) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Rate limited for ${tl}`);
}

async function translateOne(text, targetLang, hint) {
  const payload = hint ? `${hint} — ${text}` : text;
  const { text: protectedText, map } = protectTerms(payload);
  const translated = await googleTranslate(protectedText, targetLang);
  let out = restoreTerms(translated, map);
  if (hint && out.toLowerCase().startsWith(hint.toLowerCase())) {
    out = out.slice(hint.length).replace(/^[\s:\-]+/, '');
  }
  return out;
}

async function translateBatch(strings, targetLang) {
  if (strings.length === 1) {
    return [await translateOne(strings[0], targetLang)];
  }

  const protectedItems = strings.map(protectTerms);
  const joined = protectedItems.map((p) => p.text).join(DELIM);

  let translated;
  try {
    translated = await googleTranslate(joined, targetLang);
  } catch {
    translated = null;
  }

  let parts = translated ? translated.split(DELIM) : [];
  if (parts.length !== strings.length) {
    parts = [];
    for (const s of strings) {
      parts.push(await translateOne(s, targetLang));
      await sleep(REQUEST_DELAY_MS);
    }
    return parts;
  }

  return parts.map((part, i) => restoreTerms(part, protectedItems[i].map));
}

function buildBatches(entries) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const entry of entries) {
    const len = entry.en.length + DELIM.length;
    if (
      batch.length > 0 &&
      (batch.length >= BATCH_ITEMS || chars + len > BATCH_CHARS)
    ) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(entry);
    chars += len;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function translateLocaleFlat(lang, enFlat, currentFlat, { force, dryRun, label = lang }) {
  const toTranslate = [];
  for (const [key, enVal] of Object.entries(enFlat)) {
    const cur = currentFlat[key];
    const needs = force || cur === undefined || cur === '' || cur === enVal;
    if (needs) toTranslate.push({ key, en: enVal });
  }

  if (!toTranslate.length) {
    console.log(`  ${label}: already localized (${Object.keys(enFlat).length} keys)`);
    return currentFlat;
  }

  console.log(
    `  ${label}: translating ${toTranslate.length} / ${Object.keys(enFlat).length} keys...`,
  );

  if (dryRun) return currentFlat;

  const out = { ...currentFlat };
  const batches = buildBatches(toTranslate);

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const strings = batch.map((x) => x.en);
    const translated = await translateBatch(strings, lang);
    batch.forEach((entry, i) => {
      out[entry.key] = translated[i];
    });
    for (const entry of batch) {
      if (out[entry.key] === entry.en && entry.en.length > 0) {
        const hint = entry.key.split('.').slice(-2).join(' ');
        const retry = await translateOne(entry.en, lang, hint);
        if (retry && retry !== entry.en) out[entry.key] = retry;
        await sleep(REQUEST_DELAY_MS);
      }
    }
    process.stdout.write(`    batch ${b + 1}/${batches.length}\r`);
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(`  ${label}: done (${batches.length} batches)          `);
  return out;
}

export function parseTranslateArgs() {
  const args = process.argv.slice(2);
  let lang = null;
  let force = false;
  let dryRun = false;
  const langs = [];
  for (const a of args) {
    if (a.startsWith('--lang=')) lang = a.slice(7);
    else if (a.startsWith('--langs=')) {
      langs.push(...a.slice(8).split(',').map((x) => x.trim()).filter(Boolean));
    } else if (a === '--force') force = true;
    else if (a === '--dry-run') dryRun = true;
  }
  return { lang, langs, force, dryRun };
}
