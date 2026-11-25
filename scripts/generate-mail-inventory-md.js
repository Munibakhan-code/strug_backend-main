/**
 * Write docs/mail-template-inventory.md from EMAIL_TEMPLATE_REGISTRY.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildMailInventoryMarkdown } from './email-template-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '..', 'docs', 'mail-template-inventory.md');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buildMailInventoryMarkdown(), 'utf8');
console.log(`Wrote ${outPath}`);
