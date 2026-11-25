/**
 * Fail on "evil merges": merge commits that change a path both parents agree on.
 *
 * PolinRider / EtherHiding was injected this way in #1096 and #1135 — neither parent
 * touched routes/active_trip-routes.js, but the merge commit tree did.
 *
 * A clean Git merge never rewrites a blob that is identical in both parents.
 * Legitimate conflict resolution only affects paths that differ between parents.
 *
 * Usage:
 *   node scripts/guard-evil-merge.js
 *   node scripts/guard-evil-merge.js <sha> [<sha> ...]
 *   node scripts/guard-evil-merge.js --range <before>..<after>
 *
 * Env:
 *   GUARD_EVIL_MERGE_RANGE  same as --range (used by CI on push)
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { scanText } from './guard-malware.js';

/** Payload has only ever landed in JS. Keeps the content check false-positive free. */
const SCANNED_EXT = /\.(?:js|mjs|cjs)$/i;

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (err) {
    if (allowFail) return '';
    const stderr = err.stderr?.toString?.() || err.message;
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

function isMergeCommit(sha) {
  const parents = git(['rev-list', '--parents', '-n', '1', sha]).split(/\s+/);
  return parents.length >= 3;
}

function parentsOf(sha) {
  return git(['rev-list', '--parents', '-n', '1', sha]).split(/\s+/).slice(1);
}

/** @returns {Map<string, string>} path -> blob sha */
function lsTreeMap(sha) {
  const out = git(['ls-tree', '-r', sha], { allowFail: true });
  const map = new Map();
  if (!out) return map;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab);
    const path = line.slice(tab + 1);
    // meta: <mode> <type> <object>
    const parts = meta.split(' ');
    if (parts[1] !== 'blob') continue;
    map.set(path, parts[2]);
  }
  return map;
}

/**
 * Run the payload signatures over a blob's content straight out of git.
 * @returns {string[]} issue descriptions (empty = clean or unreadable)
 */
function scanBlob(blobSha) {
  const text = git(['cat-file', '-p', blobSha], { allowFail: true });
  if (!text) return [];
  return scanText(text);
}

/**
 * @returns {{ path: string, reason: string, parentBlob: string|null, mergeBlob: string|null }[]}
 */
function findEvilChanges(mergeSha) {
  const [p1, p2] = parentsOf(mergeSha);
  if (!p1 || !p2) return [];

  const map1 = lsTreeMap(p1);
  const map2 = lsTreeMap(p2);
  const mapM = lsTreeMap(mergeSha);

  const paths = new Set([...map1.keys(), ...map2.keys(), ...mapM.keys()]);
  const issues = [];

  for (const path of paths) {
    const a = map1.get(path) || null;
    const b = map2.get(path) || null;
    const m = mapM.get(path) || null;

    if (!a && !b) {
      if (m) {
        issues.push({
          path,
          reason: 'file exists only in the merge commit (not in either parent)',
          parentBlob: null,
          mergeBlob: m,
        });
      }
      continue;
    }

    if (a && b && a === b && m !== a) {
      issues.push({
        path,
        reason: m
          ? 'both parents agree on this blob, but the merge rewrote it'
          : 'both parents have this file, but the merge deleted it',
        parentBlob: a,
        mergeBlob: m,
      });
      continue;
    }

    // Parents disagree, so a merge blob matching neither is ordinary conflict
    // resolution — the shape check above cannot fire. That makes it the cheap
    // bypass: touch the target file on the feature branch and the "agreed blob"
    // rule no longer applies. Fall back to scanning the resolved content, which
    // is the same thing guard-malware does to the working tree.
    if (a && b && a !== b && m && m !== a && m !== b && SCANNED_EXT.test(path)) {
      for (const issue of scanBlob(m)) {
        issues.push({
          path,
          reason: `merge resolution introduced content matching a payload signature: ${issue}`,
          parentBlob: null,
          mergeBlob: m,
        });
      }
    }
  }

  return issues;
}

function short(sha) {
  return sha.slice(0, 12);
}

function checkCommit(sha) {
  const full = git(['rev-parse', sha]);
  if (!isMergeCommit(full)) {
    return { sha: full, skipped: true, issues: [] };
  }
  const subject = git(['log', '-1', '--format=%s', full]);
  return { sha: full, skipped: false, subject, issues: findEvilChanges(full) };
}

function parseArgs(argv) {
  const out = { shas: [], range: process.env.GUARD_EVIL_MERGE_RANGE || null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--range') {
      out.range = argv[++i];
      continue;
    }
    if (a.startsWith('--range=')) {
      out.range = a.slice('--range='.length);
      continue;
    }
    if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    out.shas.push(a);
  }
  return out;
}

function commitsInRange(range) {
  const [before, after] = range.split('..');
  if (!after) throw new Error(`invalid range: ${range}`);
  if (!before || /^0+$/.test(before)) {
    return git(['rev-list', '--merges', '-n', '20', after])
      .split('\n')
      .filter(Boolean);
  }
  return git(['rev-list', '--merges', `${before}..${after}`])
    .split('\n')
    .filter(Boolean);
}

function main() {
  const { shas, range } = parseArgs(process.argv.slice(2));
  let targets = [...shas];
  if (range) targets.push(...commitsInRange(range));
  if (!targets.length) targets = ['HEAD'];

  const seen = new Set();
  const unique = [];
  for (const t of targets) {
    const full = git(['rev-parse', t]);
    if (seen.has(full)) continue;
    seen.add(full);
    unique.push(full);
  }

  let checked = 0;
  let failed = 0;
  const reports = [];

  for (const sha of unique) {
    const result = checkCommit(sha);
    if (result.skipped) continue;
    checked += 1;
    if (result.issues.length) {
      failed += 1;
      reports.push(result);
    }
  }

  if (!checked && unique.length === 1 && !isMergeCommit(unique[0])) {
    console.log('evil-merge guard: OK (HEAD is not a merge commit)');
    return;
  }

  if (failed) {
    console.error('Evil-merge guard FAILED:\n');
    for (const r of reports) {
      console.error(`  ${short(r.sha)} ${r.subject}`);
      for (const issue of r.issues) {
        console.error(`    • ${issue.path}`);
        console.error(`      ${issue.reason}`);
        if (issue.parentBlob) console.error(`      parent blob: ${issue.parentBlob}`);
        if (issue.mergeBlob) console.error(`      merge blob:  ${issue.mergeBlob}`);
      }
      console.error('');
    }
    console.error(
      'A clean merge never rewrites a path both parents agree on (known PolinRider vector in #1096 / #1135).',
    );
    console.error(
      'Merge via the GitHub UI only; do not commit local merge trees from an infected worktree.',
    );
    process.exit(1);
  }

  console.log(
    `evil-merge guard: OK (${checked} merge commit${checked === 1 ? '' : 's'} checked)`,
  );
}

try {
  main();
} catch (err) {
  console.error(`evil-merge guard error: ${err.message}`);
  process.exit(1);
}
