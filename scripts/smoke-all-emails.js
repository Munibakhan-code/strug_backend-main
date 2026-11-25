/**
 * Phase 2.2 — Full branded email smoke test (all 23 templates).
 *
 *   node scripts/smoke-all-emails.js           # render + subject keys (no send)
 *   node scripts/smoke-all-emails.js --send    # deliver via Resend
 *
 * Env: RESEND_* (for --send), optional RESEND_TEST_TO
 */
import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import i18next from '../utils/i18n.js';
import { renderEmailHtml, sendEmail } from '../utils/mailer.js';
import { isResendConfigured } from '../services/email-service.js';
import {
  EMAIL_TEMPLATE_REGISTRY,
  sampleVariablesForTemplate,
  logEmailTemplateInventory,
} from './email-template-registry.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, '../templates/emails');
const shouldSend = process.argv.includes('--send');
const testTo = process.env.RESEND_TEST_TO || process.env.RESEND_FROM_EMAIL || 'test@strug.ca';

function pass(label) {
  console.log(`  ✓ ${label}`);
}

async function main() {
  console.log('--- Branded email smoke test (all templates) ---\n');
  logEmailTemplateInventory();
  console.log('');

  await i18next.changeLanguage('en');
  const t = i18next.getFixedT('en');

  const layoutPath = path.join(TEMPLATE_DIR, 'layout.hbs');
  if (!(await fs.pathExists(layoutPath))) {
    throw new Error('Master layout.hbs missing');
  }
  pass('layout.hbs exists');

  for (const row of EMAIL_TEMPLATE_REGISTRY) {
    const templatePath = path.join(TEMPLATE_DIR, `${row.template}.hbs`);
    if (!(await fs.pathExists(templatePath))) {
      throw new Error(`Template missing: ${row.template}.hbs`);
    }
    pass(`template exists: ${row.template}.hbs`);

    const variables = sampleVariablesForTemplate(row.template, t);
    const subject = t(row.subjectKey, { ...variables });
    if (!subject || subject === row.subjectKey) {
      throw new Error(`Subject key unresolved: ${row.subjectKey} (${row.template})`);
    }
    pass(`subject [en]: ${row.template} → ${row.subjectKey}`);

    const html = await renderEmailHtml(row.template, variables, 'en');
    if (!html || html.length < 100) {
      throw new Error(`Render produced empty HTML for ${row.template}`);
    }
    if (!html.includes('Strug') && !html.includes('strug')) {
      console.warn(`  ⚠ ${row.template}: HTML may be missing brand markers`);
    }
    pass(`render HTML: ${row.template} (${html.length} chars)`);

    if (shouldSend) {
      if (!isResendConfigured()) {
        throw new Error('Resend not configured — cannot --send');
      }
      await sendEmail(row.template, variables, testTo, row.subjectKey, 'en');
      pass(`sent → ${testTo}`);
    }
  }

  if (!shouldSend) {
    console.log('\nSkip send (pass --send to deliver test emails)');
  }
  console.log(`\n--- PASS: ${EMAIL_TEMPLATE_REGISTRY.length}/${EMAIL_TEMPLATE_REGISTRY.length} branded templates OK ---`);
}

main().catch((err) => {
  console.error('\n--- FAIL ---');
  console.error(err.message || err);
  process.exit(1);
});
