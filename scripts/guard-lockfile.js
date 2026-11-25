/**
 * Fail on known-bad lockfile pins and unexpected preinstall hooks.
 *
 * Usage: node scripts/guard-lockfile.js
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.cwd());
const THIS_FILE = fileURLToPath(import.meta.url);

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectLockEntries(lock) {
  const out = [];
  if (lock.packages && typeof lock.packages === 'object') {
    for (const [path, meta] of Object.entries(lock.packages)) {
      if (!meta || typeof meta !== 'object') continue;
      const name = path === ''
        ? (lock.name || 'root')
        : path.split('node_modules/').pop();
      out.push({ name, version: meta.version, path });
    }
  }
  if (lock.dependencies && typeof lock.dependencies === 'object') {
    const walk = (deps, prefix = '') => {
      for (const [name, meta] of Object.entries(deps)) {
        if (!meta || typeof meta !== 'object') continue;
        out.push({ name: prefix ? `${prefix}/${name}` : name, version: meta.version, path: name });
        if (meta.dependencies) walk(meta.dependencies, name);
      }
    };
    walk(lock.dependencies);
  }
  return out;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function scanLockfile(root = ROOT) {
  const issues = [];
  let denylist = { packages: {}, preinstallAllowlist: [] };
  try {
    denylist = loadJson(join(root, 'scripts', 'supply-chain-denylist.json'));
  } catch {
    issues.push('missing scripts/supply-chain-denylist.json');
  }

  let pkg;
  try {
    pkg = loadJson(join(root, 'package.json'));
  } catch (err) {
    issues.push(`cannot read package.json: ${err.message}`);
    return issues;
  }

  const pre = pkg.scripts?.preinstall;
  const allow = new Set(denylist.preinstallAllowlist || []);
  if (typeof pre === 'string' && pre.trim() && !allow.has('root')) {
    issues.push(`package.json scripts.preinstall is set (${JSON.stringify(pre)})`);
  }

  let lockRaw;
  try {
    lockRaw = readFileSync(join(root, 'package-lock.json'), 'utf8');
  } catch {
    return issues;
  }

  if (/"preinstall"\s*:/.test(lockRaw)) {
    issues.push('package-lock.json contains a preinstall script entry');
  }

  let lock;
  try {
    lock = JSON.parse(lockRaw);
  } catch (err) {
    issues.push(`package-lock.json is not valid JSON: ${err.message}`);
    return issues;
  }

  const bad = denylist.packages || {};
  for (const entry of collectLockEntries(lock)) {
    const versions = bad[entry.name];
    if (!Array.isArray(versions) || !entry.version) continue;
    if (versions.includes(entry.version)) {
      issues.push(`denylisted ${entry.name}@${entry.version}`);
    }
  }

  return issues;
}

function main() {
  const issues = scanLockfile(ROOT);
  if (issues.length) {
    console.error('Lockfile guard FAILED:\n');
    for (const issue of issues) console.error(`  • ${issue}`);
    console.error('\nRefusing to continue. Pin a clean version and re-run npm ci --ignore-scripts.');
    process.exit(1);
  }
  console.log('lockfile guard: OK');
}

if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  main();
}
