import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Stripe from 'stripe';
import request from 'supertest';
import { app } from '../../app.js';
import { db, truncateAll, createUser, closeDb } from '../helpers/db.js';

/**
 * Freelance (digital services) orders are paid via Stripe. Their PaymentIntent events are
 * delivered to the single registered webhook — /booking/webhook/stripe — and reconciled there,
 * because the old dedicated freelance webhook was mounted after express.json() and 400'd on
 * every delivery, leaving paid orders stuck PENDING. These tests prove the central webhook
 * flips the order, is idempotent, and cannot clobber a paid order with a late failure.
 */
const stripe = new Stripe('sk_test_dummy_for_signing');

async function seedFreelanceOrder(over = {}) {
  const buyer = await createUser({ name: 'Buyer' });
  const seller = await createUser({ name: 'Seller' });
  const buyerProfile = await db.buyerProfile.create({ data: { user_id: buyer.user_id } });
  const sellerProfile = await db.freelancerProfile.create({
    data: { user_id: seller.user_id, display_name: 'Seller Co' },
  });
  const gig = await db.gig.create({
    data: {
      freelancer_profile_id: sellerProfile.id,
      Freelance_Category: 'Design',
      Freelance_SubCategory: 'Logo',
      title: 'A logo',
      description: 'desc',
      images: [],
      packages: [{ type: 'BASIC', price: 50 }],
      status: 'ACTIVE',
    },
  });
  const order = await db.freelancerOrder.create({
    data: {
      buyer_profile_id: buyerProfile.id,
      freelancer_profile_id: sellerProfile.id,
      gig_id: gig.id,
      package_type: 'BASIC',
      price: 50,
      status: 'PENDING',
      payment_status: 'PENDING',
      stripe_payment_intent_id: 'pi_freelance_test',
      ...over,
    },
  });
  return { buyer, order };
}

function post(type, pi) {
  const payload = JSON.stringify({ id: `evt_${type}`, type, data: { object: pi } });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  return request(app)
    .post('/booking/webhook/stripe')
    .set('stripe-signature', signature)
    .set('Content-Type', 'application/json')
    .send(payload);
}

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

describe('freelance order Stripe webhook (via /booking/webhook/stripe)', () => {
  it('marks a PENDING order PAID + IN_PROGRESS on payment_intent.succeeded', async () => {
    const { buyer, order } = await seedFreelanceOrder();

    await post('payment_intent.succeeded', {
      id: 'pi_freelance_test',
      metadata: { buyer_id: String(buyer.user_id) },
    }).expect(200);

    const after = await db.freelancerOrder.findUnique({ where: { id: order.id } });
    expect(after.payment_status).toBe('PAID');
    expect(after.status).toBe('IN_PROGRESS');
  });

  it('is idempotent — a re-delivered succeeded event does not re-run side effects', async () => {
    const { buyer, order } = await seedFreelanceOrder();
    const pi = { id: 'pi_freelance_test', metadata: { buyer_id: String(buyer.user_id) } };

    await post('payment_intent.succeeded', pi).expect(200);
    await post('payment_intent.succeeded', pi).expect(200); // second delivery

    const after = await db.freelancerOrder.findUnique({ where: { id: order.id } });
    expect(after.payment_status).toBe('PAID');
  });

  it('marks a PENDING order FAILED on payment_intent.payment_failed', async () => {
    const { buyer, order } = await seedFreelanceOrder();

    await post('payment_intent.payment_failed', {
      id: 'pi_freelance_test',
      metadata: { buyer_id: String(buyer.user_id) },
      last_payment_error: { message: 'card declined' },
    }).expect(200);

    const after = await db.freelancerOrder.findUnique({ where: { id: order.id } });
    expect(after.payment_status).toBe('FAILED');
  });

  it('a late payment_failed cannot clobber an already-PAID order', async () => {
    const { buyer, order } = await seedFreelanceOrder({ payment_status: 'PAID', status: 'IN_PROGRESS' });

    await post('payment_intent.payment_failed', {
      id: 'pi_freelance_test',
      metadata: { buyer_id: String(buyer.user_id) },
    }).expect(200);

    const after = await db.freelancerOrder.findUnique({ where: { id: order.id } });
    expect(after.payment_status).toBe('PAID'); // unchanged
    expect(after.status).toBe('IN_PROGRESS');
  });
});
