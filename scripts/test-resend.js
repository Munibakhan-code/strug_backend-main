/**
 * Resend connectivity smoke test.
 *   node scripts/test-resend.js           # config + domain list only
 *   node scripts/test-resend.js --send    # also send a test email
 *
 * Env: RESEND_API_KEY, RESEND_FROM_EMAIL, optional RESEND_TEST_TO
 */
import dotenv from 'dotenv';
import {
  isResendConfigured,
  logResendStartupStatus,
  sendEmail,
} from '../services/email-service.js';

dotenv.config();

const shouldSend = process.argv.includes('--send');
const testTo = process.env.RESEND_TEST_TO || process.env.RESEND_FROM_EMAIL || 'test@strug.ca';

async function main() {
  console.log('--- Resend smoke test ---');
  if (!isResendConfigured()) {
    console.error('FAIL: RESEND_API_KEY or RESEND_FROM_EMAIL missing');
    process.exit(1);
  }
  console.log('OK: Resend env configured');

  await logResendStartupStatus();

  if (!shouldSend) {
    console.log('Skip send (pass --send to deliver a test email)');
    process.exit(0);
  }

  await sendEmail({
    to: testTo,
    subject: '[Strug] Resend smoke test',
    html: '<p>Resend smoke test from <code>scripts/test-resend.js</code>.</p>',
    text: 'Resend smoke test from scripts/test-resend.js',
  });
  console.log(`OK: test email sent to ${testTo}`);
}

main().catch((err) => {
  console.error('FAIL:', err.message || err);
  process.exit(1);
});
