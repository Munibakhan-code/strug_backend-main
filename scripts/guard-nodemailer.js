/**
 * CI guard: nodemailer may only be imported by the SMTP mail driver.
 * Prevents resurrecting scattered Gmail/SMTP send paths outside services/mail.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ALLOWED = new Set([
  path.normalize('services/mail/providers/smtp.js'),
  // Unit tests mock the package; they do not open a real transport.
  path.normalize('test/unit/mail-facade.test.js'),
  path.normalize('test/unit/mail-phase5-hardening.test.js'),
  path.normalize('test/unit/mail-phase5-cutover.test.js'),
]);

const IMPORT_RE =
  /(?:from\s+['"]nodemailer['"]|require\(\s*['"]nodemailer['"]\s*\)|import\(\s*['"]nodemailer['"]\s*\))/;

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'coverage') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs)$/.test(ent.name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const offenders = [];

for (const file of files) {
  const rel = path.normalize(path.relative(ROOT, file));
  if (ALLOWED.has(rel)) continue;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (IMPORT_RE.test(text)) {
    offenders.push(rel);
  }
}

if (offenders.length) {
  console.error('guard-nodemailer: nodemailer import outside SMTP driver:');
  for (const o of offenders) console.error(`  - ${o}`);
  console.error(
    'Only services/mail/providers/smtp.js may import nodemailer (see docs/mail-smtp-cutover-gate.md).',
  );
  process.exit(1);
}

console.log('guard-nodemailer: OK (nodemailer isolated to SMTP driver)');
