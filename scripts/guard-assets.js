/**
 * Fail if a binary-looking asset is actually text / JS.
 *
 * This repo was hit twice with `public/fonts/fa-solid-400.woff2`: a one-line
 * script behind a font extension. `guard-malware.js` only walks .js/.mjs/.cjs,
 * so that file was invisible. This guard checks magic bytes on fonts/images
 * and treats a UTF-8 / JS body as a dropper.
 *
 * Usage: node scripts/guard-assets.js
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.cwd());
const THIS_FILE = fileURLToPath(import.meta.url);

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'coverage',
  'dist',
  'build',
  'generated',
]);

const MAGIC = {
  '.woff2': [Buffer.from('wOF2')],
  '.woff': [Buffer.from('wOFF')],
  '.ttf': [Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from('true'), Buffer.from('typ1')],
  '.otf': [Buffer.from('OTTO')],
  '.eot': [Buffer.from([0x00, 0x00, 0x01, 0x00])],
  '.png': [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  '.jpg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.gif': [Buffer.from('GIF8')],
  '.webp': [Buffer.from('RIFF')],
  '.ico': [Buffer.from([0x00, 0x00, 0x01, 0x00])],
  '.wasm': [Buffer.from([0x00, 0x61, 0x73, 0x6d])],
  '.mp3': [Buffer.from('ID3'), Buffer.from([0xff, 0xfb])],
  '.mp4': [Buffer.from('ftyp')],
  '.webm': [Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
  '.pdf': [Buffer.from('%PDF')],
};

const JSISH = /(?:\beval\s*\(|new\s+Function\s*\(|\brequire\s*\(|import\s*\(|Function\s*\(\s*['"`])/i;

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIR_NAMES.has(ent.name) && !ent.name.startsWith('.')) walkFiles(full, out);
      continue;
    }
    if (ent.isFile()) out.push(full);
  }
  return out;
}

function startsWithMagic(buf, magics) {
  return magics.some((m) => {
    if (m.equals(Buffer.from('ftyp'))) {
      return buf.length >= 8 && buf.subarray(4, 8).equals(m);
    }
    return buf.length >= m.length && buf.subarray(0, m.length).equals(m);
  });
}

function looksLikeText(buf) {
  if (!buf.length) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  if (sample.includes(0)) return false;
  let printable = 0;
  for (const b of sample) {
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) printable += 1;
  }
  return printable / sample.length >= 0.85;
}

function rel(path, root = ROOT) {
  return relative(root, path).split(sep).join('/');
}

/**
 * @param {string} root
 * @returns {{ file: string, reason: string }[]}
 */
export function scanAssets(root = ROOT) {
  const issues = [];
  for (const file of walkFiles(root)) {
    const ext = extname(file).toLowerCase();
    const magics = MAGIC[ext];
    if (!magics) continue;
    let buf;
    try {
      buf = readFileSync(file);
    } catch (err) {
      issues.push({ file: rel(file, root), reason: `cannot read: ${err.message}` });
      continue;
    }
    if (startsWithMagic(buf, magics)) continue;

    const asText = looksLikeText(buf);
    const body = asText ? buf.toString('utf8') : '';
    if (asText && JSISH.test(body)) {
      issues.push({
        file: rel(file, root),
        reason: `${ext} has no ${ext.slice(1)} magic and contains script-like text (disguised dropper)`,
      });
      continue;
    }
    if (asText) {
      issues.push({
        file: rel(file, root),
        reason: `${ext} has no ${ext.slice(1)} magic; body is UTF-8 text, not a binary asset`,
      });
      continue;
    }
    issues.push({
      file: rel(file, root),
      reason: `${ext} magic bytes missing or corrupt`,
    });
  }
  return issues;
}

function main() {
  const issues = scanAssets(ROOT);
  if (issues.length) {
    console.error('Asset guard FAILED:\n');
    for (const { file, reason } of issues) {
      console.error(`  ${file}`);
      console.error(`    • ${reason}`);
    }
    console.error(
      '\nA binary extension must start with its real magic (e.g. woff2 → wOF2).',
    );
    console.error('Known prior hit: public/fonts/fa-solid-400.woff2 (text dropper, twice).');
    process.exit(1);
  }
  console.log('asset guard: OK');
}

if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  main();
}
