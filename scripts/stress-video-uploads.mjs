#!/usr/bin/env node
/**
 * Mass-upload stress harness for the Videos pipeline.
 *
 * Simulates N concurrent uploads via:
 *   POST /video/bulk/presign → PutBlock/PutBlockList → PATCH /video/:id/finalize
 *
 * Single-user (hits per-user cap of 5 if concurrency > 5):
 *   node scripts/stress-video-uploads.mjs --token JWT --count 20 --concurrency 5
 *
 * Multi-user (50 uploads at once from 50 different users):
 *   node scripts/stress-video-uploads.mjs --users 50 --count 50 --concurrency 50
 *
 * --users seeds stress_u{N}@strug.ca + channel + logs in (needs DATABASE_URL + ENCRYPTION_KEY).
 * Env: STRESS_TOKEN, STRESS_BASE_URL, STRESS_PASSWORD (default Strug2026!)
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, []),
);

const BASE = String(args.base || process.env.STRESS_BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
const COUNT = Math.max(1, Number(args.count) || 20);
const CONCURRENCY = Math.max(1, Number(args.concurrency) || 10);
const SIZE_KB = Math.max(64, Number(args['size-kb']) || 256);
const USERS = Math.max(0, Number(args.users) || 0);
const PASSWORD = String(args.password || process.env.STRESS_PASSWORD || 'Strug2026!');
let TOKEN = args.token || process.env.STRESS_TOKEN;

/** @type {string[]} */
let tokens = [];

function encryptEmail(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
}

function fakeMp4(bytes) {
  const buf = Buffer.alloc(bytes, 0);
  buf.writeUInt32BE(8, 0);
  buf.write('ftyp', 4);
  buf.write('isom', 8);
  return buf;
}

async function api(method, path, body, token) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}

async function putBlock(sasUrl, blockId, chunk) {
  const url = `${sasUrl}&comp=block&blockid=${encodeURIComponent(blockId)}`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'x-ms-blob-type': 'BlockBlob' },
    body: chunk,
  });
  if (!r.ok) throw new Error(`PutBlock ${r.status}`);
}

async function putBlockList(sasUrl, blockIds) {
  const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList>${blockIds.map((id) => `<Latest>${id}</Latest>`).join('')}</BlockList>`;
  const r = await fetch(`${sasUrl}&comp=blocklist`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
  });
  if (!r.ok) throw new Error(`PutBlockList ${r.status}`);
}

async function login(email) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: email, password: PASSWORD }),
  });
  const d = await r.json();
  if (!d.accessToken) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(d)}`);
  return d.accessToken;
}

/** Create N distinct users with channels so each can upload in parallel. */
async function ensureStressUsers(n) {
  if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY required for --users seed');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for --users seed');

  const prisma = new PrismaClient();
  const hashed = await bcrypt.hash(PASSWORD, 10);
  const out = [];

  try {
    for (let i = 1; i <= n; i++) {
      const email = `stress_u${i}@strug.ca`;
      const handle = `stressu${i}`;
      const encryptedEmail = encryptEmail(email);

      await prisma.user.deleteMany({ where: { email } });
      let user = await prisma.user.findUnique({ where: { email: encryptedEmail } });
      if (user) {
        user = await prisma.user.update({
          where: { user_id: user.user_id },
          data: { name: `Stress User ${i}`, password: hashed, is_creator: true, is_seller: true },
        });
      } else {
        user = await prisma.user.create({
          data: {
            name: `Stress User ${i}`,
            email: encryptedEmail,
            password: hashed,
            ref_code: 'ST' + crypto.randomBytes(3).toString('hex').toUpperCase(),
            is_creator: true,
            is_seller: true,
          },
        });
      }

      const ch = await prisma.channel.findUnique({ where: { user_id: user.user_id } });
      if (!ch) {
        const handleTaken = await prisma.channel.findUnique({ where: { handle } });
        if (handleTaken) {
          await prisma.channel.update({
            where: { channel_id: handleTaken.channel_id },
            data: { handle: `${handle}_x${handleTaken.channel_id}` },
          });
        }
        await prisma.channel.create({
          data: {
            user_id: user.user_id,
            handle,
            display_name: `Stress Channel ${i}`,
            description: 'stress harness',
            is_active: true,
          },
        });
      }

      const token = await login(email);
      out.push({ email, user_id: user.user_id, token });
      process.stdout.write(`\r  seeded users ${i}/${n}`);
    }
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
  return out;
}

async function uploadOne(idx, token) {
  const title = `stress-${Date.now()}-${idx}-${crypto.randomBytes(3).toString('hex')}`;
  const file = fakeMp4(SIZE_KB * 1024);
  const filename = `${title}.mp4`;

  const presign = await api('POST', '/video/bulk/presign', {
    videos: [{
      title,
      description: 'stress upload',
      filename,
      file_size_bytes: file.length,
      video_type: 'long',
      category: 'General',
    }],
  }, token);

  if (presign.status === 429) {
    const code = presign.json?.code === 'UPLOAD_CONCURRENCY_LIMIT'
      ? 'USER_CONCURRENCY'
      : (presign.json?.code === 'VIDEO_PIPELINE_BUSY' ? 'BACKPRESSURE' : 'RATE_LIMIT');
    return { ok: false, code, detail: presign.json?.message || '429' };
  }
  if (presign.status >= 400) {
    return { ok: false, code: 'PRESIGN', detail: `${presign.status} ${JSON.stringify(presign.json)}` };
  }

  const row = presign.json?.data?.[0];
  if (!row?.sas_url || !row?.video_id) {
    return { ok: false, code: 'PRESIGN_SHAPE', detail: JSON.stringify(presign.json) };
  }

  const chunkSize = row.recommended_chunk_size_bytes || 10 * 1024 * 1024;
  const blocks = [];
  try {
    for (let off = 0, i = 0; off < file.length; off += chunkSize, i++) {
      const slice = file.subarray(off, Math.min(off + chunkSize, file.length));
      const blockId = Buffer.from(String(i).padStart(6, '0')).toString('base64');
      await putBlock(row.sas_url, blockId, slice);
      blocks.push(blockId);
    }
    await putBlockList(row.sas_url, blocks);
  } catch (e) {
    return { ok: false, code: 'BLOB_UPLOAD', detail: e.message };
  }

  const fin = await api('PATCH', `/video/${row.video_id}/finalize`, {
    raw_video_url: row.blob_url,
    title,
    description: 'stress upload',
    category: 'General',
    video_type: 'long',
  }, token);
  if (fin.status >= 400) {
    return { ok: false, code: 'FINALIZE', detail: `${fin.status} ${JSON.stringify(fin.json)}` };
  }
  return { ok: true, video_id: row.video_id };
}

async function pool(total, concurrency, fn) {
  let i = 0;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (i < total) {
      const idx = i++;
      results[idx] = await fn(idx);
      process.stdout.write(`\r  done ${results.filter(Boolean).length}/${total}`);
    }
  }));
  return results;
}

if (USERS > 0) {
  console.log(`Seeding ${USERS} stress users + channels…`);
  const accounts = await ensureStressUsers(USERS);
  tokens = accounts.map((a) => a.token);
  console.log(`Logged in ${tokens.length} users.`);
} else if (TOKEN) {
  tokens = [TOKEN];
} else {
  console.error('Provide --token JWT  OR  --users N (seeds stress_u1@strug.ca …)');
  process.exit(1);
}

console.log(`Stress: ${COUNT} uploads concurrency=${CONCURRENCY} users=${tokens.length} size=${SIZE_KB}KB → ${BASE}`);
const t0 = Date.now();
const results = await pool(COUNT, CONCURRENCY, (idx) => uploadOne(idx, tokens[idx % tokens.length]));
console.log('\n');

const ok = results.filter((r) => r?.ok).length;
const bp = results.filter((r) => r?.code === 'BACKPRESSURE').length;
const userCap = results.filter((r) => r?.code === 'USER_CONCURRENCY').length;
const rate = results.filter((r) => r?.code === 'RATE_LIMIT').length;
const blobFail = results.filter((r) => r?.code === 'BLOB_UPLOAD').length;
const fail = results.filter((r) => r && !r.ok && !['BACKPRESSURE', 'USER_CONCURRENCY', 'RATE_LIMIT'].includes(r.code));
console.log(`OK=${ok}  BACKPRESSURE_429=${bp}  USER_CONCURRENCY_429=${userCap}  OTHER_429=${rate}  BLOB_FAIL=${blobFail}  FAIL=${fail.length}  elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (fail.length) {
  console.log('Sample failures:');
  for (const f of fail.slice(0, 8)) console.log(' ', f.code, f.detail);
}
process.exit(fail.length ? 1 : 0);
