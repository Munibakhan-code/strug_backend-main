/**
 * Fail if GitHub Actions YAML looks like secret exfil / untrusted RCE.
 *
 * Patterns are built from parts so this file does not trip itself.
 *
 * Usage: node scripts/guard-workflows.js
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.cwd());
const THIS_FILE = fileURLToPath(import.meta.url);
const WORKFLOWS = join(ROOT, '.github', 'workflows');

function rel(path, root = ROOT) {
  return relative(root, path).split(sep).join('/');
}

function buildRules() {
  const toJson = 'toJSON';
  const secrets = 'secrets';
  const vars = 'vars';
  const prTarget = 'pull_request' + '_target';
  const npmPub = 'npm publish';
  const writeAll = 'write' + '-all';
  return [
    {
      id: 'secrets-json',
      pattern: new RegExp(`${toJson}\\s*\\(\\s*${secrets}\\s*\\)`),
      reason: 'workflow dumps secrets via toJSON(secrets)',
      fail: true,
    },
    {
      id: 'vars-json',
      pattern: new RegExp(`${toJson}\\s*\\(\\s*${vars}\\s*\\)`),
      reason: 'workflow dumps vars via toJSON(vars)',
      fail: true,
    },
    {
      id: 'curl-bash',
      pattern: /curl[^\n]*\|\s*(?:sudo\s+)?(?:bash|sh)\b/i,
      reason: 'remote code exec (curl | bash)',
      fail: true,
    },
    {
      id: 'wget-pipe',
      pattern: /wget[^\n]*\|\s*(?:sudo\s+)?(?:bash|sh)\b/i,
      reason: 'remote code exec (wget | bash)',
      fail: true,
    },
    {
      id: 'iwr-pipe',
      pattern: /Invoke-WebRequest[^\n]*\|/i,
      reason: 'remote code exec (Invoke-WebRequest | …)',
      fail: true,
    },
    {
      id: 'npm-publish',
      pattern: new RegExp(npmPub.replace(' ', '\\s+')),
      reason: 'npm publish in CI without a production environment gate',
      fail: true,
    },
    {
      id: 'write-all',
      pattern: new RegExp(`permissions\\s*:\\s*${writeAll}`),
      reason: 'permissions: write-all on a workflow',
      fail: false,
    },
    {
      id: 'pr-target',
      pattern: new RegExp(`\\b${prTarget}\\b`),
      reason: 'pull_request_target (dangerous with PR-head checkout)',
      fail: true,
    },
  ];
}

const RULES = buildRules();

function listWorkflowFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      listWorkflowFiles(full, out);
      continue;
    }
    if (!ent.isFile()) continue;
    if (/\.ya?ml$/i.test(ent.name)) out.push(full);
  }
  return out;
}

/**
 * @param {string} text
 * @param {string} fileRel
 * @returns {{ file: string, reason: string, fail: boolean }[]}
 */
export function scanWorkflowText(text, fileRel) {
  const issues = [];
  const hasHeadCheckout = /github\.event\.pull_request\.head/.test(text)
    && /actions\/checkout/.test(text);
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(text)) continue;
    if (rule.id === 'pr-target' && !hasHeadCheckout) {
      issues.push({
        file: fileRel,
        reason: `${rule.reason} (no PR-head checkout detected — still blocked)`,
        fail: rule.fail,
      });
      continue;
    }
    issues.push({ file: fileRel, reason: rule.reason, fail: rule.fail });
  }
  return issues;
}

/**
 * @param {string} root
 * @returns {{ file: string, reason: string, fail: boolean }[]}
 */
export function scanWorkflows(root = ROOT) {
  const dir = join(root, '.github', 'workflows');
  const issues = [];
  for (const file of listWorkflowFiles(dir)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      issues.push({ file: rel(file, root), reason: `cannot read: ${err.message}`, fail: true });
      continue;
    }
    issues.push(...scanWorkflowText(text, rel(file, root)));
  }
  return issues;
}

function main() {
  const issues = scanWorkflows(ROOT);
  const fails = issues.filter((i) => i.fail !== false);
  const warns = issues.filter((i) => i.fail === false);
  for (const { file, reason } of warns) {
    console.warn(`workflow guard WARN: ${file}\n    • ${reason}`);
  }
  if (fails.length) {
    console.error('Workflow guard FAILED:\n');
    for (const { file, reason } of fails) {
      console.error(`  ${file}`);
      console.error(`    • ${reason}`);
    }
    console.error('\nRefusing to continue. Remove secret-exfil / untrusted RCE patterns.');
    process.exit(1);
  }
  console.log(`workflow guard: OK (${listWorkflowFiles(WORKFLOWS).length} files)`);
}

if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  main();
}
