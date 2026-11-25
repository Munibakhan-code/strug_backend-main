/**
 * CI guard: every templates/emails/*.hbs (except layout) is in EMAIL_TEMPLATE_REGISTRY,
 * every registry row has required org fields + an en locale subject key.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EMAIL_TEMPLATE_REGISTRY } from './email-template-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const templatesDir = path.join(root, 'templates', 'emails');
const enLocalePath = path.join(root, 'locales', 'en', 'translation.json');

const REQUIRED_FIELDS = ['template', 'subjectKey', 'trigger', 'vertical', 'owner', 'audience', 'priority'];
const AUDIENCES = new Set(['user', 'ops']);
const PRIORITIES = new Set(['critical', 'high', 'normal', 'low']);

function getByPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function main() {
  const errors = [];

  const hbsFiles = fs
    .readdirSync(templatesDir)
    .filter((f) => f.endsWith('.hbs') && f !== 'layout.hbs')
    .map((f) => f.replace(/\.hbs$/, ''));

  const registryNames = EMAIL_TEMPLATE_REGISTRY.map((r) => r.template);
  const registrySet = new Set(registryNames);

  for (const name of hbsFiles) {
    if (!registrySet.has(name)) {
      errors.push(`unregistered template file: templates/emails/${name}.hbs`);
    }
  }
  for (const name of registryNames) {
    if (!hbsFiles.includes(name)) {
      errors.push(`registry entry missing .hbs file: ${name}`);
    }
  }
  if (registryNames.length !== new Set(registryNames).size) {
    errors.push('duplicate template names in EMAIL_TEMPLATE_REGISTRY');
  }

  let en;
  try {
    en = JSON.parse(fs.readFileSync(enLocalePath, 'utf8'));
  } catch (err) {
    errors.push(`cannot read en locale: ${err.message}`);
    en = null;
  }

  for (const row of EMAIL_TEMPLATE_REGISTRY) {
    for (const field of REQUIRED_FIELDS) {
      if (!row[field]) {
        errors.push(`${row.template || '(unknown)'}: missing ${field}`);
      }
    }
    if (row.audience && !AUDIENCES.has(row.audience)) {
      errors.push(`${row.template}: invalid audience "${row.audience}"`);
    }
    if (row.priority && !PRIORITIES.has(row.priority)) {
      errors.push(`${row.template}: invalid priority "${row.priority}"`);
    }
    if (en && row.subjectKey) {
      const val = getByPath(en, row.subjectKey);
      if (typeof val !== 'string' || !val.trim()) {
        errors.push(`${row.template}: missing en locale subject key ${row.subjectKey}`);
      }
    }
  }

  if (errors.length) {
    console.error('guard-email-registry: FAILED');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `guard-email-registry: OK (${EMAIL_TEMPLATE_REGISTRY.length} templates, ${hbsFiles.length} .hbs files)`,
  );
}

main();
