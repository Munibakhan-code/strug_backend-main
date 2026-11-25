/**
 * Test Manifest Integrity Verifier
 * 
 * Fails CI if:
 *  1. Any *.test.js file is missing from test/verticals.manifest.json (Orphan test)
 *  2. Any *.test.js file is mapped into more than one vertical (Conflict/Duplicate)
 *  3. Any test file listed in manifest does not exist on disk
 *
 * Usage: 
 *   node scripts/verify-test-manifest.js
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.cwd());
const THIS_FILE = fileURLToPath(import.meta.url);
const MANIFEST_PATH = join(ROOT, 'test', 'verticals.manifest.json');

export function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function matchesGlob(relPath, glob) {
  return globToRegExp(glob).test(relPath);
}

function walkTests(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', 'coverage', 'dist', '.git', '.cache'].includes(ent.name)) {
        continue;
      }
      walkTests(full, out);
      continue;
    }
    if (ent.isFile() && /\.test\.(js|jsx|mjs|cjs)$/.test(ent.name)) {
      out.push(relative(ROOT, full).split(sep).join('/'));
    }
  }
  return out;
}

function collectFromGlobs(globs) {
  const files = new Set();
  const roots = new Set();
  for (const glob of globs) {
    const head = glob.split('/')[0];
    if (head && !head.includes('*')) {
      roots.add(head);
    }
  }
  if (!roots.size) roots.add('test');
  for (const root of roots) {
    for (const file of walkTests(join(ROOT, root))) {
      files.add(file);
    }
  }
  return [...files].sort();
}

/**
 * Validates manifest against physical test files
 * 
 * @param {{ testGlobs?: string[], verticals?: Record<string, { tests?: string[] }> }} manifest
 * @param {string[]} files
 */
export function verifyManifest(manifest, files) {
  const verticals = manifest.verticals || {};
  const assigned = new Map();
  const conflicts = [];

  for (const [id, spec] of Object.entries(verticals)) {
    for (const glob of spec.tests || []) {
      const hits = files.filter((f) => matchesGlob(f, glob));
      if (!hits.length && !glob.includes('*')) {
        conflicts.push(`[${id}] listed test file does not exist on disk: ${glob}`);
      }
      for (const file of hits) {
        if (assigned.has(file) && assigned.get(file) !== id) {
          conflicts.push(`duplicate mapping: "${file}" is assigned to both "${assigned.get(file)}" and "${id}"`);
        } else {
          assigned.set(file, id);
        }
      }
    }
  }

  const orphans = files.filter((f) => !assigned.has(f));
  return { orphans, conflicts, assigned };
}

function main() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    console.error(`verify-test-manifest: failed to read ${relative(ROOT, MANIFEST_PATH).split(sep).join('/')}: ${err.message}`);
    process.exit(1);
  }

  const globs = manifest.testGlobs?.length ? manifest.testGlobs : ['test/**/*.test.js'];
  const files = collectFromGlobs(globs);
  const { orphans, conflicts } = verifyManifest(manifest, files);

  if (orphans.length || conflicts.length) {
    console.error('\nverify-test-manifest: integrity errors detected:\n');
    for (const msg of conflicts) {
      console.error(`  - ${msg}`);
    }
    for (const file of orphans) {
      console.error(`  - unmapped test file: ${file}`);
    }
    console.error('\nPlease add these test files to test/verticals.manifest.json under their respective vertical.\n');
    process.exit(1);
  }

  console.log(`verify-test-manifest: manifest verified, all ${files.length} test files mapped cleanly and uniquely`);
}

if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  main();
}
