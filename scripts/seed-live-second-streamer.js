/**
 * Ensure smoke-chat@strug.ca also has a live_streamer_profile (raid target).
 * Run after seed-test-user.js + seed-live-categories.js
 */
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();
const prisma = new PrismaClient();

function encrypt(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
}

async function main() {
  const cat = await prisma.live_stream_category.findFirst({ where: { is_active: true } });
  const viewer = await prisma.user.findUnique({ where: { email: encrypt('smoke-chat@strug.ca') } });
  if (!viewer) {
    console.error('smoke-chat@strug.ca not found — run seed-test-user.js first');
    process.exit(1);
  }
  const catId = cat?.category_id ?? 1;
  const p = await prisma.live_streamer_profile.upsert({
    where: { user_id: viewer.user_id },
    update: { display_name: 'Smoke Streamer', is_active: true, category_id: catId },
    create: {
      user_id: viewer.user_id,
      handle: 'smokechat',
      display_name: 'Smoke Streamer',
      description: 'Second streamer for raid / gift tests',
      category_id: catId,
      is_active: true,
    },
  });
  console.log('Second streamer ready:', { handle: p.handle, streamer_id: p.streamer_id, user_id: p.user_id });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
