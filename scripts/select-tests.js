/**
 * Selective test runner for CI: git diff + test/verticals.manifest.json.
 *
 * Combines PR #1256 selection hardening with unit/integration split outputs.
 *
 * Usage:
 *   node scripts/select-tests.js --base <sha|branch> --head <sha>
 *   node scripts/select-tests.js --files routes/food-routes.js
 *   node scripts/select-tests.js --run-vertical food
 *
 * GitHub Actions outputs (when $GITHUB_OUTPUT is set):
 *   run_full, needs_integration, verticals, vitest_args,
 *   unit_args, integration_args, test_count, reason
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.cwd());
const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_MANIFEST = join(ROOT, 'test', 'verticals.manifest.json');

export function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function matchesGlob(relPath, glob) {
  const posix = relPath.replace(/\\/g, '/');
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -3);
    return posix === prefix.slice(0, -1) || posix.startsWith(`${prefix}`);
  }
  return globToRegExp(glob).test(posix);
}

export function loadManifest(path = DEFAULT_MANIFEST) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listedTests(manifest) {
  const out = [];
  for (const spec of Object.values(manifest.verticals || {})) {
    for (const t of spec.tests || []) out.push(t.replace(/\\/g, '/'));
  }
  return [...new Set(out)];
}

export function isIntegrationTest(relPath) {
  const posix = String(relPath || '').replace(/\\/g, '/');
  return /(^|\/)test\/integration\//.test(posix);
}

/** Split selected files and flag whether Postgres / serial Vitest is required. */
export function enrichSelection(result) {
  const tests = (result.tests || []).map((t) => t.replace(/\\/g, '/'));
  const unitTests = tests.filter((t) => !isIntegrationTest(t));
  const integrationTests = tests.filter((t) => isIntegrationTest(t));
  return {
    ...result,
    tests,
    unitTests,
    integrationTests,
    needsIntegration: Boolean(result.runFull) || integrationTests.length > 0,
  };
}

/**
 * @param {string[]} changed
 * @param {object} manifest
 * @param {{ forceFull?: boolean }} [opts]
 */
export function selectFromChangedFiles(changed, manifest, opts = {}) {
  const files = (changed || []).map((f) => f.replace(/\\/g, '/')).filter(Boolean);
  const triggers = manifest.fullSuiteTriggers || [];
  const verticals = manifest.verticals || {};
  const allKnownTests = listedTests(manifest);

  const alwaysVerticals = [];
  const alwaysTests = [];
  for (const [id, spec] of Object.entries(verticals)) {
    if (spec.always) {
      alwaysVerticals.push(id);
      alwaysTests.push(...(spec.tests || []));
    }
  }

  if (opts.forceFull) {
    return enrichSelection({
      runFull: true,
      reason: 'Forced full suite execution',
      verticals: Object.keys(verticals),
      tests: allKnownTests,
    });
  }

  // Empty diff: still run always-on core smoke (from #1256 follow-up)
  if (!files.length) {
    return enrichSelection({
      runFull: false,
      reason: 'No changed files detected',
      verticals: alwaysVerticals,
      tests: [...new Set(alwaysTests)],
    });
  }

  // 1. Critical full-suite triggers
  for (const file of files) {
    if (triggers.some((g) => matchesGlob(file, g))) {
      return enrichSelection({
        runFull: true,
        reason: `Full-suite trigger touched: ${file}`,
        verticals: Object.keys(verticals),
        tests: allKnownTests,
      });
    }
  }

  const selectedVerticals = new Set(alwaysVerticals);

  const unmatched = [];
  for (const file of files) {
    const hits = [];
    for (const [id, spec] of Object.entries(verticals)) {
      const watch = spec.watch || [];
      const tests = spec.tests || [];
      if (watch.some((g) => matchesGlob(file, g)) || tests.includes(file)) {
        hits.push(id);
      }
    }
    if (!hits.length) {
      unmatched.push(file);
      continue;
    }
    // Prefer a concrete vertical over platform's broad utils/** watch, but never let
    // always-on `core` alone suppress platform (e.g. middleware → security-authz).
    const concrete = hits.filter((id) => id !== 'platform' && id !== 'core');
    const chosen = concrete.length ? concrete : hits;
    for (const id of chosen) selectedVerticals.add(id);
  }

  const ignored = (file) =>
    file.endsWith('.md')
    || file.startsWith('docs/')
    || file.startsWith('.cursor/')
    || file.startsWith('.github/workflows/deploy')
    || file.startsWith('.github/workflows/security')
    || file.includes('/README')
    || file.endsWith('.png')
    || file.endsWith('.jpg')
    || file.endsWith('.jpeg')
    || file.endsWith('.svg')
    || file.endsWith('.webp')
    || file.endsWith('.ico')
    || file.endsWith('.json.example');

  const knownTestSet = new Set(allKnownTests);
  const unmappedCodeFiles = unmatched.filter((f) => !ignored(f) && !knownTestSet.has(f));

  // Soft fallback: unmapped code → platform (keep speed; do not force full suite)
  if (unmappedCodeFiles.length) {
    console.warn(`[select-tests] Unmapped files detected, routing to platform suite: ${unmappedCodeFiles.join(', ')}`);
    selectedVerticals.add('platform');
  }

  const testsToRun = [];
  const seenTests = new Set();
  for (const id of [...selectedVerticals].sort()) {
    for (const t of verticals[id]?.tests || []) {
      if (!seenTests.has(t)) {
        seenTests.add(t);
        testsToRun.push(t);
      }
    }
  }

  return enrichSelection({
    runFull: false,
    reason: selectedVerticals.size
      ? `Targeted verticals: ${[...selectedVerticals].sort().join(', ')}`
      : 'No changed files detected',
    verticals: [...selectedVerticals].sort(),
    tests: testsToRun,
  });
}

export function gitChangedFiles(base, head) {
  if (!base || /^0+$/.test(String(base))) return null;
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    // Fallback to 2-dot diff if 3-dot fails (PR #1256)
    try {
      const out = execFileSync('git', ['diff', '--name-only', base, head], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch {
      return null;
    }
  }
}

function writeGithubOutput(result) {
  const enriched = enrichSelection(result);
  const dest = process.env.GITHUB_OUTPUT;
  if (!dest) {
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }
  const lines = [
    `run_full=${enriched.runFull ? 'true' : 'false'}`,
    `needs_integration=${enriched.needsIntegration ? 'true' : 'false'}`,
    `verticals=${JSON.stringify(enriched.verticals)}`,
    `vitest_args=${enriched.runFull ? '' : enriched.tests.join(' ')}`,
    `unit_args=${enriched.runFull ? '' : enriched.unitTests.join(' ')}`,
    `integration_args=${enriched.runFull ? '' : enriched.integrationTests.join(' ')}`,
    `test_count=${enriched.tests.length}`,
    `reason=${(enriched.reason || '').replace(/\r?\n/g, ' ')}`,
  ];
  appendFileSync(dest, `${lines.join('\n')}\n`);
  console.log(`[select-tests] Decision: ${enriched.reason}`);
  console.log(
    `[select-tests] run_full=${enriched.runFull} needs_integration=${enriched.needsIntegration} `
    + `tests=${enriched.tests.length} unit=${enriched.unitTests.length} `
    + `integration=${enriched.integrationTests.length} verticals=${enriched.verticals.join(',')}`,
  );
}

function runVitest(tests) {
  if (!tests.length) {
    console.log('[select-tests] No test files to run.');
    process.exit(0);
  }
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', ...tests], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

function parseArgs(argv) {
  const out = { base: '', head: 'HEAD', files: [], manifest: DEFAULT_MANIFEST, runVertical: '', forceFull: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--head') out.head = argv[++i];
    else if (a === '--manifest') out.manifest = resolve(argv[++i]);
    else if (a === '--files') out.files = argv[++i].split(/[,\s]+/).filter(Boolean);
    else if (a === '--run-vertical') out.runVertical = argv[++i];
    else if (a === '--full') out.forceFull = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(args.manifest);

  if (args.runVertical) {
    const spec = manifest.verticals?.[args.runVertical];
    if (!spec) {
      console.error(`Unknown vertical: ${args.runVertical}`);
      process.exit(1);
    }
    const always = Object.entries(manifest.verticals)
      .filter(([, s]) => s.always)
      .flatMap(([, s]) => s.tests || []);
    const tests = [...new Set([...(spec.tests || []), ...always])];
    runVitest(tests);
    return;
  }

  let changed = args.files;
  if (!changed.length) {
    const fromGit = gitChangedFiles(args.base, args.head);
    if (!fromGit) {
      console.warn('[select-tests] Could not determine changed files from git. Falling back safely to Full Suite.');
      writeGithubOutput(selectFromChangedFiles([], manifest, { forceFull: true }));
      return;
    }
    changed = fromGit;
  }

  const result = selectFromChangedFiles(changed, manifest, { forceFull: args.forceFull });
  writeGithubOutput(result);
}

if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  main();
}
