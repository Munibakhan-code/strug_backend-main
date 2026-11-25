// Ensure the platform's Stripe webhook endpoint is subscribed to the live-
// subscription lifecycle events. The backend already HANDLES these events
// (services/live-subscription.js, dispatched from booking-engine-routes.js), but
// the registered Stripe endpoint historically only enabled `payment_intent.succeeded`
// — so Stripe never DELIVERS the subscription events and subscriptions silently
// never activate. This script unions the required events onto the endpoint.
//
// SAFE: it only ADDS events (never removes existing ones) and is a no-op once the
// endpoint already has them. Dry-run by default; pass --apply to write.
//
// Usage:
//   node scripts/configure-stripe-webhook-events.mjs                 # dry run
//   node scripts/configure-stripe-webhook-events.mjs --apply         # apply
//   STRIPE_WEBHOOK_ENDPOINT_ID=we_123 node ... --apply               # target by id
//
// Loads STRIPE_SECRET_KEY from the process env (set it inline or via your env file).
// Prod Stripe is LIVE — double-check you're pointed at the intended account.

import Stripe from 'stripe';

const REQUIRED_EVENTS = [
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

// The path the backend mounts the Stripe webhook on (index.js → bookingWebhookRouter).
const ENDPOINT_PATH_HINT = '/booking/webhook/stripe';

const APPLY = process.argv.includes('--apply');

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

const key = process.env.STRIPE_SECRET_KEY;
if (!key) fail('STRIPE_SECRET_KEY is not set.');
const stripe = new Stripe(key);
const mode = key.startsWith('sk_live') ? 'LIVE' : 'TEST';

async function pickEndpoint() {
  const id = process.env.STRIPE_WEBHOOK_ENDPOINT_ID;
  if (id) return stripe.webhookEndpoints.retrieve(id);

  const { data } = await stripe.webhookEndpoints.list({ limit: 100 });
  if (data.length === 0) fail('No webhook endpoints registered on this Stripe account.');

  const match = data.filter((e) => (e.url || '').includes(ENDPOINT_PATH_HINT));
  if (match.length === 1) return match[0];
  if (match.length > 1) {
    fail(
      `Multiple endpoints match "${ENDPOINT_PATH_HINT}". Re-run with STRIPE_WEBHOOK_ENDPOINT_ID set:\n` +
        match.map((e) => `  ${e.id}  ${e.url}`).join('\n')
    );
  }
  // No path match — show the list so the operator can choose explicitly.
  fail(
    `Could not auto-identify the endpoint (none match "${ENDPOINT_PATH_HINT}"). ` +
      `Re-run with STRIPE_WEBHOOK_ENDPOINT_ID set to one of:\n` +
      data.map((e) => `  ${e.id}  ${e.url}  [${(e.enabled_events || []).length} events]`).join('\n')
  );
}

async function main() {
  console.log(`Stripe mode: ${mode}${APPLY ? '' : '  (dry run — pass --apply to write)'}`);

  const endpoint = await pickEndpoint();
  const current = endpoint.enabled_events || [];

  // If the endpoint is already a catch-all ("*"), every event is delivered — nothing to do.
  if (current.includes('*')) {
    console.log(`✔ Endpoint ${endpoint.id} (${endpoint.url}) is a catch-all ("*"); all events already delivered.`);
    return;
  }

  const missing = REQUIRED_EVENTS.filter((e) => !current.includes(e));
  console.log(`\nEndpoint: ${endpoint.id}\nURL:      ${endpoint.url}`);
  console.log(`Currently enabled (${current.length}): ${current.join(', ') || '(none)'}`);

  if (missing.length === 0) {
    console.log('\n✔ All required subscription events are already enabled. No change needed.');
    return;
  }

  const merged = [...new Set([...current, ...REQUIRED_EVENTS])];
  console.log(`Missing (${missing.length}): ${missing.join(', ')}`);
  console.log(`Will set enabled_events to (${merged.length}): ${merged.join(', ')}`);

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write this change.');
    return;
  }

  const updated = await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: merged });
  console.log(`\n✔ Updated. Endpoint now has ${updated.enabled_events.length} events:`);
  console.log(`  ${updated.enabled_events.join(', ')}`);
}

main().catch((err) => fail(err.message));
