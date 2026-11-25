/**
 * Fail if IDE / AI-tool persistence droppers land in the repo.
 *
 * Historical hit: strug_worker `.vscode/tasks.json` with PolinRider
 * (`runOn: folderOpen`). ChainDrop also drops `.vscode/setup.mjs` and
 * `.claude/setup.mjs`.
 *
 * Usage: node scripts/guard-persistence.js
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.cwd());
const THIS_FILE = fileURLToPath(import.meta.url);

function rel(path, root = ROOT) {
  return relative(root, path).split(sep).join('/');
}

function readIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    return `UNREADABLE:${err.message}`;
  }
}

function walkDirs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (!ent.isDirectory()) continue;
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'coverage') continue;
    out.push(full);
    walkDirs(full, out);
  }
  return out;
}

/**
 * @param {string} root
 * @returns {{ file: string, reason: string }[]}
 */
export function scanPersistence(root = ROOT) {
  const issues = [];
  const dropper = 'setup' + '.mjs';
  const mathInit = 'math' + '_init.js';

  const tasksPath = join(root, '.vscode', 'tasks.json');
  const tasks = readIfPresent(tasksPath);
  if (tasks?.startsWith('UNREADABLE:')) {
    issues.push({ file: rel(tasksPath, root), reason: tasks });
  } else if (tasks) {
    if (/runOn\s*["']?\s*[:=]\s*["']?folderOpen|folderOpen/.test(tasks)) {
      issues.push({ file: rel(tasksPath, root), reason: 'VS Code auto-run on folder open' });
    }
    if (tasks.includes(dropper)) {
      issues.push({ file: rel(tasksPath, root), reason: `${dropper} referenced in tasks` });
    }
  }

  const claudeSettings = join(root, '.claude', 'settings.json');
  const claude = readIfPresent(claudeSettings);
  if (claude?.startsWith('UNREADABLE:')) {
    issues.push({ file: rel(claudeSettings, root), reason: claude });
  } else if (claude) {
    if (/SessionStart/.test(claude) || claude.includes(dropper)) {
      issues.push({ file: rel(claudeSettings, root), reason: 'Claude Code persistence hook' });
    }
  }

  const extras = [
    join(root, '.vscode', dropper),
    join(root, '.claude', dropper),
    join(root, '.claude', mathInit),
  ];
  for (const dir of walkDirs(root)) {
    const base = dir.split(/[/\\]/).pop();
    if (base === '.vscode') extras.push(join(dir, dropper), join(dir, 'tasks.json'));
    if (base === '.claude') extras.push(join(dir, dropper), join(dir, mathInit));
  }

  const seen = new Set();
  for (const extra of extras) {
    const key = rel(extra, root);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!existsSync(extra)) continue;
    if (extra.endsWith('tasks.json') && extra !== tasksPath) {
      const nested = readIfPresent(extra);
      if (nested && /folderOpen/.test(nested)) {
        issues.push({ file: key, reason: 'VS Code auto-run on folder open' });
      }
      continue;
    }
    issues.push({ file: key, reason: 'unexpected ChainDrop dropper file in repo' });
  }

  return issues;
}

function main() {
  const issues = scanPersistence(ROOT);
  if (issues.length) {
    console.error('Persistence guard FAILED:\n');
    for (const { file, reason } of issues) {
      console.error(`  ${file}`);
      console.error(`    • ${reason}`);
    }
    console.error('\nRefusing to continue. Remove auto-run tasks and dropper files.');
    process.exit(1);
  }
  console.log('persistence guard: OK');
}

if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  main();
}
