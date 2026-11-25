/**
 * Phase 2.3.7 — Cron email smoke test (ghost-driver, appointment, rental).
 *
 *   node scripts/smoke-cron-emails.js           # render + subject keys (no send)
 *   node scripts/smoke-cron-emails.js --send    # deliver via Resend
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
import { CRON_INVENTORY } from '../utils/cron-inventory.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, '../templates/emails');
const shouldSend = process.argv.includes('--send');
const testTo = process.env.RESEND_TEST_TO || process.env.RESEND_FROM_EMAIL || 'test@strug.ca';

const CRON_EMAIL_CASES = [
  {
    jobId: 'ghost-driver',
    template: 'ghost-driver',
    subjectKey: 'emails.ghost_driver.subject',
    variables: { name: 'Smoke Test User' },
  },
  {
    jobId: 'appointment-reminder',
    template: 'service-appointment',
    subjectKey: 'emails.services.subjects.reminder',
    buildVariables: (t) => ({
      title: t('emails.services.subjects.reminder'),
      message: t('emails.services.messages.reminder'),
      service_name: 'Smoke Test Service',
      other_party_name: 'Strug Provider',
      date: new Date().toISOString().slice(0, 10),
      time: '10:00 AM',
    }),
  },
  {
    jobId: 'rental-expiry',
    template: 'rental-expiry',
    subjectKey: 'emails.services.subjects.rental_expiry',
    variables: {
      item_name: 'Smoke Test Rental',
      expire_date: new Date().toISOString().slice(0, 10),
      rental_id: 1,
    },
  },
];

function pass(label) {
  console.log(`  ✓ ${label}`);
}

async function main() {
  console.log('--- Cron email smoke test ---\n');

  const emailCrons = CRON_INVENTORY.filter((e) => e.sendsEmail);
  pass(`inventory: ${emailCrons.length} email-sending cron job(s) registered`);

  await i18next.changeLanguage('en');
  const t = i18next.getFixedT('en');

  for (const job of CRON_EMAIL_CASES) {
    const inv = CRON_INVENTORY.find((e) => e.id === job.jobId);
    if (!inv?.sendsEmail) {
      throw new Error(`CRON_INVENTORY missing email job: ${job.jobId}`);
    }
    pass(`inventory entry: ${job.jobId}`);

    const templatePath = path.join(TEMPLATE_DIR, `${job.template}.hbs`);
    if (!(await fs.pathExists(templatePath))) {
      throw new Error(`Template missing: ${job.template}.hbs`);
    }
    pass(`template exists: ${job.template}.hbs`);

    const variables = job.buildVariables ? job.buildVariables(t) : job.variables;
    const subject = t(job.subjectKey, { ...variables });
    if (!subject || subject === job.subjectKey) {
      throw new Error(`Subject key unresolved: ${job.subjectKey}`);
    }
    pass(`subject key [en]: ${job.subjectKey}`);

    const html = await renderEmailHtml(job.template, variables, 'en');
    if (!html || html.length < 100) {
      throw new Error(`Render produced empty HTML for ${job.template}`);
    }
    pass(`render HTML: ${job.template} (${html.length} chars)`);

    if (shouldSend) {
      if (!isResendConfigured()) {
        throw new Error('Resend not configured — cannot --send');
      }
      await sendEmail(job.template, variables, testTo, job.subjectKey, 'en');
      pass(`sent → ${testTo}`);
    }
  }

  if (!shouldSend) {
    console.log('\nSkip send (pass --send to deliver test emails)');
  }
  console.log('\n--- PASS: cron email smoke complete ---');
}

main().catch((err) => {
  console.error('\n--- FAIL ---');
  console.error(err.message || err);
  process.exit(1);
});
