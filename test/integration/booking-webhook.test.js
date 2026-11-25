import { describe, it, expect, afterAll } from 'vitest';
import Stripe from 'stripe';
import request from 'supertest';
import { app } from '../../app.js';
import { closeDb } from '../helpers/db.js';

afterAll(async () => { await closeDb(); });

// The Stripe booking webhook is mounted with express.raw BEFORE json() (index.js/app.js).
// It verifies the signature over the RAW bytes. These tests prove both the raw-body mount
// and the HMAC verification work — entirely offline (constructEvent is pure crypto).
const stripe = new Stripe('sk_test_dummy_for_signing');

describe('POST /booking/webhook/stripe', () => {
  it('rejects a forged signature with 400', async () => {
    const payload = JSON.stringify({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } });
    const res = await request(app).post('/booking/webhook/stripe')
      .set('stripe-signature', 't=1,v1=deadbeefnotarealsignature')
      .set('Content-Type', 'application/json')
      .send(payload)
      .expect(400);
    expect(res.text).toMatch(/Webhook Error/);
  });

  it('accepts a correctly-signed event (raw body survives the mount)', async () => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    // An unhandled event type falls straight through to { received: true } — this isolates
    // the signature/raw-body path from any DB reconciliation.
    const payload = JSON.stringify({ id: 'evt_ok', type: 'payment_intent.created', data: { object: { id: 'pi_ok' } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });

    const res = await request(app).post('/booking/webhook/stripe')
      .set('stripe-signature', signature)
      .set('Content-Type', 'application/json')
      .send(payload)
      .expect(200);
    expect(res.body).toEqual({ received: true });
  });
});
