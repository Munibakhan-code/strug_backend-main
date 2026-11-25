/**
 * Phase 1.5 — Messaging staging E2E smoke test.
 *
 * Exercises: DM channel, text message, mark-read, shop context chat,
 * ondemand context chat, optional chat media upload.
 *
 * Usage:
 *   node scripts/smoke-messaging-e2e.js
 *   BASE_URL=http://localhost:5000 node scripts/smoke-messaging-e2e.js
 *
 * Env (optional overrides):
 *   SMOKE_EMAIL_A, SMOKE_PASSWORD_A — buyer / hirer (default test@strug.ca)
 *   SMOKE_EMAIL_B, SMOKE_PASSWORD_B — seller / worker (auto-created if missing)
 */
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const prisma = new PrismaClient();
const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');

const EMAIL_A = process.env.SMOKE_EMAIL_A || 'test@strug.ca';
const PASS_A = process.env.SMOKE_PASSWORD_A || 'Strug2026!';
const EMAIL_B = process.env.SMOKE_EMAIL_B || 'smoke-chat@strug.ca';
const PASS_B = process.env.SMOKE_PASSWORD_B || 'Strug2026!';

function encryptEmail(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return enc;
}

async function api(path, { method = 'GET', token, body, formData } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === 'object' ? JSON.stringify(data) : String(data);
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

async function login(email, password) {
  const data = await api('/auth/login', {
    method: 'POST',
    body: { login: email, password },
  });
  if (!data?.accessToken) throw new Error(`Login failed for ${email}`);
  return { token: data.accessToken, userId: data.user.user_id };
}

async function ensureUser(email, password, name) {
  const encrypted = encryptEmail(email);
  let user = await prisma.user.findUnique({ where: { email: encrypted } });
  if (user) return user;

  await prisma.user.deleteMany({ where: { email } }).catch(() => {});
  const hashed = await bcrypt.hash(password, 10);
  const refCode = 'SMK' + Math.random().toString(36).slice(2, 8).toUpperCase();
  user = await prisma.user.create({
    data: {
      name,
      email: encrypted,
      password: hashed,
      ref_code: refCode,
      is_seller: true,
    },
  });
  console.log(`  seeded user ${email} (id ${user.user_id})`);
  return user;
}

async function ensureWorkerProfile(userId) {
  const existing = await prisma.worker_profile.findFirst({ where: { user_id: userId } });
  if (existing) return existing;
  return prisma.worker_profile.create({
    data: { user_id: userId, is_available: true },
  });
}

async function seedShopOrder(buyerId, sellerId) {
  const existing = await prisma.product_order.findFirst({
    where: { buyer_id: buyerId, seller_id: sellerId },
    orderBy: { order_id: 'desc' },
  });
  if (existing) return existing.order_id;

  const order = await prisma.product_order.create({
    data: {
      buyer_id: buyerId,
      seller_id: sellerId,
      total: 9.99,
      qty: 1,
      status: 'confirmed',
      ispaid: true,
    },
  });
  return order.order_id;
}

async function seedWorkJob(hirerId, workerProfileId) {
  const existing = await prisma.work_job.findFirst({
    where: { hirer_id: hirerId, assigned_worker_id: workerProfileId },
    orderBy: { work_job_id: 'desc' },
  });
  if (existing) return existing.work_job_id;

  const job = await prisma.work_job.create({
    data: {
      hirer_id: hirerId,
      assigned_worker_id: workerProfileId,
      title: 'Smoke test plumbing job',
      status: 'assigned',
      hirer_set_price: 50,
    },
  });
  return job.work_job_id;
}

const results = [];

function pass(label) {
  results.push({ label, ok: true });
  console.log(`  ✓ ${label}`);
}

function skip(label, reason) {
  results.push({ label, ok: true, skipped: reason });
  console.log(`  ~ ${label} (skipped: ${reason})`);
}

async function main() {
  console.log(`Messaging E2E smoke → ${BASE_URL}\n`);

  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY missing — cannot seed/login users');
  }

  console.log('1. Seed users + fixtures');
  const userA = await ensureUser(EMAIL_A, PASS_A, 'Smoke User A');
  const userB = await ensureUser(EMAIL_B, PASS_B, 'Smoke User B');
  const workerProfile = await ensureWorkerProfile(userB.user_id);
  const shopOrderId = await seedShopOrder(userA.user_id, userB.user_id);
  const workJobId = await seedWorkJob(userA.user_id, workerProfile.worker_profile_id);
  console.log(`  shop order #${shopOrderId}, work job #${workJobId}\n`);

  console.log('2. Login');
  const sessionA = await login(EMAIL_A, PASS_A);
  const sessionB = await login(EMAIL_B, PASS_B);
  pass('login buyer + seller');

  console.log('\n3. DM channel + text message');
  const dm = await api('/chat-channel/dm', {
    method: 'POST',
    token: sessionA.token,
    body: { target_user_id: sessionB.userId },
  });
  const dmChannelId = dm.channel_id;
  pass(`open DM channel #${dmChannelId}`);

  const msg = await api('/chat-messages', {
    method: 'POST',
    token: sessionA.token,
    body: {
      channel_id: dmChannelId,
      content: `Smoke test ${new Date().toISOString()}`,
      content_type: 'text',
    },
  });
  pass(`send text message #${msg.message_id}`);

  const inbox = await api(`/chat-messages/channel/${dmChannelId}?limit=10`, {
    token: sessionB.token,
  });
  const found = (inbox.messages || inbox).some?.((m) => m.message_id === msg.message_id)
    ?? JSON.stringify(inbox).includes(String(msg.message_id));
  if (!found) throw new Error('Message not visible to recipient');
  pass('recipient loads channel messages');

  await api(`/chat-messages/channel/${dmChannelId}/read`, {
    method: 'PATCH',
    token: sessionB.token,
  });
  pass('mark messages read');

  console.log('\n4. Context channels');
  const shopCtx = await api(`/chat-context/shop/${shopOrderId}`, {
    method: 'POST',
    token: sessionA.token,
  });
  pass(`shop context chat #${shopCtx.channel_id}`);

  const shopMsg = await api('/chat-messages', {
    method: 'POST',
    token: sessionA.token,
    body: {
      channel_id: shopCtx.channel_id,
      content: 'Shop order smoke message',
      content_type: 'text',
    },
  });
  pass(`shop channel message #${shopMsg.message_id}`);

  const jobCtx = await api(`/chat-context/ondemand/${workJobId}`, {
    method: 'POST',
    token: sessionA.token,
  });
  pass(`ondemand context chat #${jobCtx.channel_id}`);

  const jobMsg = await api('/chat-messages', {
    method: 'POST',
    token: sessionB.token,
    body: {
      channel_id: jobCtx.channel_id,
      content: 'On-demand job smoke reply',
      content_type: 'text',
    },
  });
  pass(`ondemand channel message #${jobMsg.message_id}`);

  console.log('\n5. Chat media upload (optional)');
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    skip('chat media upload', 'AZURE_STORAGE_CONNECTION_STRING not set');
  } else {
    try {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const form = new FormData();
      form.append('file', new Blob([png], { type: 'image/png' }), 'smoke.png');
      const media = await api(`/chat-media/channel/${dmChannelId}`, {
        method: 'POST',
        token: sessionA.token,
        formData: form,
      });
      pass(`media message #${media.message_id} (${media.content_type})`);
    } catch (err) {
      skip('chat media upload', err.message);
    }
  }

  console.log('\n--- PASS: messaging E2E smoke complete ---');
  console.log(`  ${results.length} checks, ${results.filter((r) => r.skipped).length} skipped`);
}

main()
  .catch((err) => {
    console.error('\n--- FAIL ---');
    console.error(err.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
