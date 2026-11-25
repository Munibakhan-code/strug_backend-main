// Security regression tests for the 2026-08-08 authz/PII sweep (Critical cluster C1–C5).
// Each block asserts: (a) the hole is closed (401 unauth / 403 cross-user), and (b) the
// legitimate path still works (owner/admin) and no plaintext PII leaks into embedded users.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { truncateAll, createUser, closeDb, db } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

const adminHeader = (user) => authHeader(user, { permission: 'admin' });

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

describe('C2 loan routes — unmounted scaffold (#1291)', () => {
  it('returns 404 for former /loan surface (no longer mounted)', async () => {
    for (const path of ['/loan', '/loan/1', '/loan/payments', '/loan/providers']) {
      const res = await request(app).get(path);
      expect(res.status, `GET ${path}`).toBe(404);
    }
  });
});

describe('C3 period routes — health data owner scoping', () => {
  it('rejects unauthenticated access with 401', async () => {
    expect((await request(app).get('/period')).status).toBe(401);
  });

  it('only returns/permits the caller-owned flo_user cycle data', async () => {
    const a = await createUser();
    const b = await createUser();
    const floA = await db.flo_user.create({ data: { user_id: a.user_id } });
    const periodA = await db.period.create({ data: { flo_user_id: floA.flo_user_id, start_date: new Date() } });

    // B cannot see A's periods in the list, cannot read by id, cannot write to A's flo_user.
    const listB = await request(app).get('/period').set(authHeader(b));
    expect(listB.body.some((p) => p.period_id === periodA.period_id)).toBe(false);
    expect((await request(app).get(`/period/${periodA.period_id}`).set(authHeader(b))).status).toBe(403);
    const createB = await request(app).post('/period')
      .set(authHeader(b)).send({ flo_user_id: floA.flo_user_id, start_date: new Date().toISOString() });
    expect(createB.status).toBe(403);

    // A sees their own.
    expect((await request(app).get(`/period/${periodA.period_id}`).set(authHeader(a))).status).toBe(200);
  });
});

describe('C4 symptom-log routes — health data owner scoping', () => {
  it('rejects unauthenticated access and cross-user reads', async () => {
    const a = await createUser();
    const b = await createUser();
    const floA = await db.flo_user.create({ data: { user_id: a.user_id } });
    const logA = await db.symptom_log.create({ data: { flo_user_id: floA.flo_user_id, date: new Date() } });

    expect((await request(app).get('/symptom-log')).status).toBe(401);
    expect((await request(app).get(`/symptom-log/${logA.symptom_log_id}`).set(authHeader(b))).status).toBe(403);
    expect((await request(app).get(`/symptom-log/${logA.symptom_log_id}`).set(authHeader(a))).status).toBe(200);
    const listB = await request(app).get('/symptom-log').set(authHeader(b));
    expect(listB.body.some((l) => l.symptom_log_id === logA.symptom_log_id)).toBe(false);
  });
});

describe('C5 user-service-provider — auth + no full-user PII', () => {
  it('401s unauthenticated and never serializes email/KYC on the provider user', async () => {
    const a = await createUser({ email: 'provider-secret@strug.test' });
    await db.user_service_provider.create({ data: { user_id: a.user_id, is_active: true } });

    expect((await request(app).get('/user-service-provider')).status).toBe(401);

    const res = await request(app).get('/user-service-provider').set(authHeader(a));
    expect(res.status).toBe(200);
    const withUser = res.body.find((p) => p.user);
    expect(withUser).toBeTruthy();
    expect(withUser.user.email).toBeUndefined();
    expect(withUser.user.document_verification_document_url).toBeUndefined();
    expect(withUser.user.document_verification_dob).toBeUndefined();
  });
});

describe('H1 seller-check — no silent self-grant', () => {
  it('403s a non-seller on product-listing writes and does not flip is_seller', async () => {
    const u = await createUser();
    const res = await request(app).post('/product-listing/').set(authHeader(u)).send({ name: 'x', availability: 1 });
    expect(res.status).toBe(403);
    const after = await db.user.findUnique({ where: { user_id: u.user_id }, select: { is_seller: true } });
    expect(after.is_seller).toBeFalsy(); // never auto-granted

    // A properly-onboarded seller is NOT blocked by the middleware.
    const seller = await createUser({ is_seller: true });
    const ok = await request(app).post('/product-listing/').set(authHeader(seller)).send({ name: 'x', availability: 1 });
    expect(ok.status).not.toBe(403);
    expect(ok.status).not.toBe(401);
  });
});

describe('H2 donation confirm — admin-only reconciliation', () => {
  it('forbids the project owner and only credits on admin confirm', async () => {
    const owner = await createUser();
    const project = await db.projects.create({ data: { owner_user_id: owner.user_id, title: 'P', current_amount: 0, status: 'published' } });
    const donation = await db.donations.create({
      data: { donated_user_id: owner.user_id, project_id: project.project_id, amount: 250, payment_status: 'unpaid' },
    });

    // The campaign owner must NOT be able to self-confirm an unpaid donation.
    const asOwner = await request(app).patch(`/donation/${donation.donation_id}/confirm`).set(authHeader(owner));
    expect(asOwner.status).toBe(403);
    const stillUnpaid = await db.donations.findUnique({ where: { donation_id: donation.donation_id } });
    expect(stillUnpaid.payment_status).toBe('unpaid');

    // Admin reconciliation works.
    const asAdmin = await request(app).patch(`/donation/${donation.donation_id}/confirm`).set(adminHeader(owner));
    expect(asAdmin.status).toBe(200);
    const paid = await db.donations.findUnique({ where: { donation_id: donation.donation_id } });
    expect(paid.payment_status).toBe('paid');
  });
});

describe('M ads-wallet preauth-hold — campaign ownership', () => {
  it('403s funding another user campaign and rolls back the wallet debit', async () => {
    const a = await createUser();
    const b = await createUser();
    await db.ads_wallet.create({ data: { user_id: a.user_id, balance: 100 } });
    const walletB = await db.ads_wallet.create({ data: { user_id: b.user_id, balance: 0 } });
    const campaignB = await db.ads_campaign.create({
      data: {
        ads_wallet_id: walletB.ads_wallet_id, title: 'B campaign',
        ad_type: 'banner', vertical: 'food', media_url: 'https://example.com/a.jpg',
        bid_type: 'cpc', bid_amount: 1, status: 'ACTIVE', daily_budget: 10, total_budget: 0, spent_today: 0,
      },
    });

    const res = await request(app).post('/ads-wallet/preauth-hold')
      .set(authHeader(a)).send({ campaign_id: campaignB.campaign_id, amount: 10 });
    expect(res.status).toBe(403);

    // The debit must have rolled back with the transaction.
    const wallet = await db.ads_wallet.findUnique({ where: { user_id: a.user_id } });
    expect(Number(wallet.balance)).toBe(100);
    const camp = await db.ads_campaign.findUnique({ where: { campaign_id: campaignB.campaign_id } });
    expect(Number(camp.total_budget)).toBe(0); // untouched
  });
});

describe('M checkout + driver list + catalog writes — auth/admin gating', () => {
  it('checkout writes are admin-only', async () => {
    const u = await createUser();
    expect((await request(app).post('/checkout').set(authHeader(u)).send({ total: 999 })).status).toBe(403);
    expect((await request(app).post('/checkout').set(adminHeader(u)).send({ total: 5 })).status).toBe(201);
  });

  it('driver-profile list is admin-only', async () => {
    const u = await createUser();
    expect((await request(app).get('/driver-profile').set(authHeader(u))).status).toBe(403);
    expect((await request(app).get('/driver-profile').set(adminHeader(u))).status).toBe(200);
  });

  it('catalog writes now require authentication (401 anonymous)', async () => {
    // Mounted catalogs still require auth. /platform-type and /talent-category were unmounted (#1291).
    for (const path of ['/symptom-types', '/product-type', '/rental-type']) {
      const res = await request(app).post(path).send({ name: 'x' });
      expect(res.status, `POST ${path}`).toBe(401);
    }
  });

  it('unmounted catalog scaffolds return 404 (#1291)', async () => {
    for (const path of ['/platform-type', '/talent-category', '/loan']) {
      expect((await request(app).post(path).send({ name: 'x' })).status, `POST ${path}`).toBe(404);
    }
  });
});

describe('PII omit — KYC stripped from bare embeds, still readable via explicit select', () => {
  it('hides KYC on bare reads/embeds but returns it when explicitly selected (review path)', async () => {
    const u = await createUser({
      document_verification_document_url: 'https://blob/kyc/id-123.jpg',
      document_verification_document_name: 'passport.jpg',
      document_verification_dob: new Date('1990-05-05'),
    });

    // Bare read (what `include:{user:true}` embeds do) must NOT carry KYC.
    const bare = await db.user.findUnique({ where: { user_id: u.user_id } });
    expect(bare.document_verification_document_url).toBeUndefined();
    expect(bare.document_verification_document_name).toBeUndefined();
    expect(bare.document_verification_dob).toBeUndefined();

    // Explicit select (KYC-review + age-gate paths) still works.
    const selected = await db.user.findUnique({
      where: { user_id: u.user_id },
      select: { document_verification_document_url: true, document_verification_dob: true },
    });
    expect(selected.document_verification_document_url).toBe('https://blob/kyc/id-123.jpg');
    expect(selected.document_verification_dob).toBeInstanceOf(Date);
  });
});

describe('C1 social-moderation — admin-only publish/delete', () => {
  it('blocks anonymous and non-admin, allows admin approve', async () => {
    // Anonymous is rejected before any resource lookup.
    expect((await request(app).get('/social-moderation/pending-videos')).status).toBe(401);
    expect((await request(app).patch('/social-moderation/approve/1')).status).toBe(401);
    expect((await request(app).delete('/social-moderation/reject/1')).status).toBe(401);

    const u = await createUser();
    const profile = await db.social_profile.create({
      data: { user_id: u.user_id, handle: `sec_${u.user_id}`, display_name: 'Sec Tester' },
    });
    const post = await db.social_feed.create({
      data: { profile_id: profile.profile_id, status: 'under_review', caption_text: 'pending' },
    });

    // Non-admin authenticated user is forbidden.
    expect((await request(app).patch(`/social-moderation/approve/${post.social_post_id}`).set(authHeader(u))).status).toBe(403);

    // Admin can approve → post published.
    const ok = await request(app).patch(`/social-moderation/approve/${post.social_post_id}`).set(adminHeader(u));
    expect(ok.status).toBe(200);
    const after = await db.social_feed.findUnique({ where: { social_post_id: post.social_post_id } });
    expect(after.status).toBe('published');
  });
});

// --- 2026-08-09 follow-up sweep: unauth IDOR / PII on on-demand order + cart routes ---

describe('service-order single + buyer routes — auth + ownership (was unauth IDOR)', () => {
  it('rejects unauthenticated reads with 401', async () => {
    expect((await request(app).get('/service-order/1')).status).toBe(401);
    expect((await request(app).get('/service-order/buyer/1')).status).toBe(401);
  });

  it('403s a cross-user single order; 200s the buyer and admin', async () => {
    const buyer = await createUser();
    const other = await createUser();
    const order = await db.service_order.create({ data: { buyer_id: buyer.user_id } });

    expect((await request(app).get(`/service-order/${order.order_id}`).set(authHeader(other))).status).toBe(403);
    expect((await request(app).get(`/service-order/${order.order_id}`).set(authHeader(buyer))).status).toBe(200);
    expect((await request(app).get(`/service-order/${order.order_id}`).set(adminHeader(other))).status).toBe(200);
  });

  it('403s reading another buyer\'s order history; 200s self and admin', async () => {
    const buyer = await createUser();
    const other = await createUser();
    await db.service_order.create({ data: { buyer_id: buyer.user_id } });

    expect((await request(app).get(`/service-order/buyer/${buyer.user_id}`).set(authHeader(other))).status).toBe(403);
    expect((await request(app).get(`/service-order/buyer/${buyer.user_id}`).set(authHeader(buyer))).status).toBe(200);
    expect((await request(app).get(`/service-order/buyer/${buyer.user_id}`).set(adminHeader(other))).status).toBe(200);
  });
});

describe('courier-order listing — no longer a public dump', () => {
  it('401s unauthenticated (including ?public=true) and no longer leaks orders', async () => {
    const owner = await createUser();
    const cc = await db.courier_customer.create({ data: { user_id: owner.user_id } });
    await db.courier_order.create({ data: { customer_id: cc.customer_id, status: 'pending' } });

    expect((await request(app).get('/courier-order')).status).toBe(401);
    expect((await request(app).get('/courier-order?public=true')).status).toBe(401);
  });

  it('scopes the listing to the caller\'s own courier orders', async () => {
    const owner = await createUser();
    const other = await createUser();
    const cc = await db.courier_customer.create({ data: { user_id: owner.user_id } });
    const order = await db.courier_order.create({ data: { customer_id: cc.customer_id, status: 'pending' } });

    const asOwner = await request(app).get('/courier-order').set(authHeader(owner));
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.some((o) => o.courier_order_id === order.courier_order_id)).toBe(true);

    const asOther = await request(app).get('/courier-order').set(authHeader(other));
    expect(asOther.status).toBe(200);
    expect(asOther.body.some((o) => o.courier_order_id === order.courier_order_id)).toBe(false);
  });
});

describe('courier-customer listing — no longer a public dump', () => {
  it('401s unauthenticated and scopes the list to the caller', async () => {
    const owner = await createUser();
    const other = await createUser();
    const mine = await db.courier_customer.create({ data: { user_id: owner.user_id } });
    await db.courier_customer.create({ data: { user_id: other.user_id } });

    expect((await request(app).get('/courier-customer')).status).toBe(401);

    const asOwner = await request(app).get('/courier-customer').set(authHeader(owner));
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.some((c) => c.customer_id === mine.customer_id)).toBe(true);
    expect(asOwner.body.every((c) => c.user_id === owner.user_id)).toBe(true);
    expect(asOwner.body[0].user?.email).toBeUndefined();

    const asAdmin = await request(app).get('/courier-customer').set(adminHeader(other));
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.length).toBe(2);
  });

  it('403s cross-user GET/PUT/DELETE; POST binds user_id to the JWT', async () => {
    const owner = await createUser();
    const other = await createUser();
    const victim = await createUser();
    const mine = await db.courier_customer.create({ data: { user_id: owner.user_id } });

    expect((await request(app).get(`/courier-customer/${mine.customer_id}`).set(authHeader(other))).status).toBe(403);
    expect((await request(app).get(`/courier-customer/${mine.customer_id}`).set(authHeader(owner))).status).toBe(200);
    expect((await request(app).put(`/courier-customer/${mine.customer_id}`).set(authHeader(other)).send({ user_id: other.user_id })).status).toBe(403);

    const ownerPut = await request(app).put(`/courier-customer/${mine.customer_id}`).set(authHeader(owner)).send({ user_id: victim.user_id });
    expect(ownerPut.status).toBe(200);
    const still = await db.courier_customer.findUnique({ where: { customer_id: mine.customer_id } });
    expect(still.user_id).toBe(owner.user_id);

    const created = await request(app).post('/courier-customer').set(authHeader(other)).send({ user_id: victim.user_id });
    expect(created.status).toBe(201);
    expect(created.body.user_id).toBe(other.user_id);

    expect((await request(app).delete(`/courier-customer/${mine.customer_id}`).set(authHeader(other))).status).toBe(403);
    expect((await request(app).delete(`/courier-customer/${mine.customer_id}`).set(authHeader(owner))).status).toBe(200);
  });
});

describe('rental-cart + service-cart mutate/delete — auth + ownership (was unauth IDOR)', () => {
  it('rental-cart: 401 unauth, 403 cross-user, 200 owner on PUT/DELETE', async () => {
    const owner = await createUser();
    const other = await createUser();
    const item = await db.rental_cart.create({ data: { buyer_id: owner.user_id, qty: 1, total: 10 } });

    expect((await request(app).put(`/rental-cart/${item.cart_id}`).send({ total: 999 })).status).toBe(401);
    expect((await request(app).put(`/rental-cart/${item.cart_id}`).set(authHeader(other)).send({ total: 999 })).status).toBe(403);
    const okOwner = await request(app).put(`/rental-cart/${item.cart_id}`).set(authHeader(owner)).send({ total: 42 });
    expect(okOwner.status).toBe(200);
    // owner is never taken from the body — reassignment is ignored.
    const still = await db.rental_cart.findUnique({ where: { cart_id: item.cart_id } });
    expect(still.buyer_id).toBe(owner.user_id);

    expect((await request(app).delete(`/rental-cart/${item.cart_id}`).set(authHeader(other))).status).toBe(403);
    expect((await request(app).delete(`/rental-cart/${item.cart_id}`).set(authHeader(owner))).status).toBe(200);
  });

  it('service-cart: 401 unauth, 403 cross-user, 200 owner on PUT/DELETE', async () => {
    const owner = await createUser();
    const other = await createUser();
    const item = await db.service_cart.create({ data: { buyer_id: owner.user_id, qty: 1, total: 10 } });

    expect((await request(app).put(`/service-cart/${item.cart_id}`).send({ total: 999 })).status).toBe(401);
    expect((await request(app).put(`/service-cart/${item.cart_id}`).set(authHeader(other)).send({ total: 999 })).status).toBe(403);
    expect((await request(app).put(`/service-cart/${item.cart_id}`).set(authHeader(owner)).send({ total: 42 })).status).toBe(200);

    expect((await request(app).delete(`/service-cart/${item.cart_id}`).set(authHeader(other))).status).toBe(403);
    expect((await request(app).delete(`/service-cart/${item.cart_id}`).set(authHeader(owner))).status).toBe(200);
  });
});

describe('food order PUT/checkout — ownership + no client money fields', () => {
  it('403s cross-user PUT and checkout; owner cannot flip paid without Stripe', async () => {
    const owner = await createUser();
    const other = await createUser();
    const vendor = await db.food_vendor.create({
      data: { owner_id: owner.user_id, vendor_name: 'Authz Kitchen', is_active: true },
    });
    const order = await db.food_order.create({
      data: {
        user_id: owner.user_id,
        vendor_id: vendor.vendor_id,
        order_status: 'pending',
        ispaid: false,
        total_amount: 10,
      },
    });

    expect((await request(app).put(`/food/orders/${order.food_order_id}`).send({ order_status: 'delivered', total_amount: 1 })).status).toBe(401);
    expect((await request(app).put(`/food/orders/${order.food_order_id}`).set(authHeader(other)).send({ order_status: 'delivered', total_amount: 1 })).status).toBe(403);
    const ownerPut = await request(app).put(`/food/orders/${order.food_order_id}`).set(authHeader(owner)).send({
      order_status: 'cancelled',
      total_amount: 1,
      ispaid: true,
    });
    expect(ownerPut.status).toBe(200);
    const after = await db.food_order.findUnique({ where: { food_order_id: order.food_order_id } });
    expect(after.order_status).toBe('cancelled');
    expect(after.total_amount).toBe(10);
    expect(after.ispaid).toBe(false);

    expect((await request(app).patch(`/food/orders/${order.food_order_id}/checkout`).set(authHeader(other)).send({ transaction_id: 'pi_x' })).status).toBe(403);
  });
});

describe('courier/service order mutate — IDOR + payment fields stripped', () => {
  it('courier PUT/DELETE: 401 unauth, 403 cross-user, owner cannot set is_paid/price', async () => {
    const owner = await createUser();
    const other = await createUser();
    const cc = await db.courier_customer.create({ data: { user_id: owner.user_id } });
    const order = await db.courier_order.create({
      data: { customer_id: cc.customer_id, status: 'pending', is_paid: false, price: 20 },
    });

    expect((await request(app).put(`/courier-order/${order.courier_order_id}`).send({ is_paid: true, price: 1 })).status).toBe(401);
    expect((await request(app).put(`/courier-order/${order.courier_order_id}`).set(authHeader(other)).send({ is_paid: true, price: 1 })).status).toBe(403);
    const ok = await request(app).put(`/courier-order/${order.courier_order_id}`).set(authHeader(owner)).send({
      status: 'cancelled',
      is_paid: true,
      price: 1,
    });
    expect(ok.status).toBe(200);
    const after = await db.courier_order.findUnique({ where: { courier_order_id: order.courier_order_id } });
    expect(after.status).toBe('cancelled');
    expect(after.is_paid).toBe(false);
    expect(after.price).toBe(20);

    expect((await request(app).delete(`/courier-order/${order.courier_order_id}`).set(authHeader(other))).status).toBe(403);
    expect((await request(app).delete(`/courier-order/${order.courier_order_id}`).set(authHeader(owner))).status).toBe(200);
  });

  it('service-order PUT/DELETE: 401 unauth, 403 cross-user, total/ispaid immutable', async () => {
    const buyer = await createUser();
    const other = await createUser();
    const order = await db.service_order.create({ data: { buyer_id: buyer.user_id, total: 50, ispaid: false, status: 'pending' } });

    expect((await request(app).put(`/service-order/${order.order_id}`).send({ total: 1, ispaid: true })).status).toBe(401);
    expect((await request(app).put(`/service-order/${order.order_id}`).set(authHeader(other)).send({ total: 1 })).status).toBe(403);
    const ok = await request(app).put(`/service-order/${order.order_id}`).set(authHeader(buyer)).send({ total: 1, checkout_id: 99, note: 'ok' });
    expect(ok.status).toBe(200);
    const after = await db.service_order.findUnique({ where: { order_id: order.order_id } });
    expect(after.total).toBe(50);
    expect(after.ispaid).toBe(false);

    expect((await request(app).delete(`/service-order/${order.order_id}`).set(authHeader(other))).status).toBe(403);
    expect((await request(app).delete(`/service-order/${order.order_id}`).set(authHeader(buyer))).status).toBe(200);
  });
});

describe('social interactions + media attachments require auth', () => {
  it('rejects unauthenticated CRUD', async () => {
    expect((await request(app).get('/social-interactions')).status).toBe(401);
    expect((await request(app).post('/social-interactions').send({ social_post_id: 1, user_id: 99, reaction_type: 'like' })).status).toBe(401);
    expect((await request(app).get('/social-media-attachments')).status).toBe(401);
    expect((await request(app).post('/social-media-attachments').send({ social_post_id: 1, media_url: 'x' })).status).toBe(401);
  });

  it('binds interaction user to JWT profile, not client user_id', async () => {
    const owner = await createUser();
    const other = await createUser();
    const profile = await db.social_profile.create({
      data: { user_id: owner.user_id, handle: `ia_${owner.user_id}`, display_name: 'Owner' },
    });
    const post = await db.social_feed.create({
      data: { profile_id: profile.profile_id, status: 'published', caption_text: 'hi' },
    });
    const created = await request(app).post('/social-interactions').set(authHeader(owner)).send({
      social_post_id: post.social_post_id,
      user_id: other.user_id,
      reaction_type: 'like',
    });
    expect(created.status).toBe(201);
    expect(created.body.profile_id).toBe(profile.profile_id);
    expect(created.body.user).toBeUndefined();
  });
});

describe('calm lesson enrollments — auth + owner scoping', () => {
  async function seedLessonOrder({ student, instructor }) {
    const provider = await db.calm_providers.create({
      data: { provider_user_id: instructor.user_id },
    });
    const lesson = await db.calm_lesson.create({
      data: { calm_provider_id: provider.calm_provider_id, lesson_name: 'Breathing' },
    });
    const order = await db.calm_lesson_order_buy.create({
      data: { calm_lesson_id: lesson.calm_lesson_id, user_id: student.user_id, status: 'pending' },
    });
    return { provider, lesson, order };
  }

  it('rejects unauthenticated list/read with 401', async () => {
    expect((await request(app).get('/calm-lesson-order-buy')).status).toBe(401);
    expect((await request(app).get('/calm-lesson-order-buy/1')).status).toBe(401);
    expect((await request(app).get('/calm-lesson-order-buy?public=true')).status).toBe(401);
  });

  it('does not dump every enrollment via ?public=true', async () => {
    const student = await createUser();
    const instructor = await createUser();
    const stranger = await createUser();
    const { order } = await seedLessonOrder({ student, instructor });

    const leaked = await request(app).get('/calm-lesson-order-buy?public=true').set(authHeader(stranger));
    expect(leaked.status).toBe(200);
    expect(leaked.body.some((o) => o.calm_lesson_order_buy_id === order.calm_lesson_order_buy_id)).toBe(false);
  });

  it('403s a cross-user GET and accept, but 200s the owner and instructor', async () => {
    const student = await createUser();
    const instructor = await createUser();
    const stranger = await createUser();
    const { order } = await seedLessonOrder({ student, instructor });

    expect((await request(app).get(`/calm-lesson-order-buy/${order.calm_lesson_order_buy_id}`).set(authHeader(stranger))).status).toBe(403);
    expect((await request(app).get(`/calm-lesson-order-buy/${order.calm_lesson_order_buy_id}`).set(authHeader(student))).status).toBe(200);
    expect((await request(app).get(`/calm-lesson-order-buy/${order.calm_lesson_order_buy_id}`).set(authHeader(instructor))).status).toBe(200);

    expect((await request(app).put(`/calm-lesson-order-buy/${order.calm_lesson_order_buy_id}/accept`).set(authHeader(stranger))).status).toBe(403);
    expect((await request(app).put(`/calm-lesson-order-buy/${order.calm_lesson_order_buy_id}/accept`).set(authHeader(instructor))).status).toBe(200);
  });

  it('binds POST enrollment to the JWT user, not a client-supplied user_id', async () => {
    const student = await createUser();
    const victim = await createUser();
    const instructor = await createUser();
    const { lesson } = await seedLessonOrder({ student: victim, instructor });

    const created = await request(app).post('/calm-lesson-order-buy').set(authHeader(student)).send({
      calm_lesson_id: lesson.calm_lesson_id,
      user_id: victim.user_id,
    });
    expect(created.status).toBe(201);
    expect(created.body.user_id).toBe(student.user_id);
  });
});
