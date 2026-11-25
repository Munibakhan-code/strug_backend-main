/**
 * Seed a live_streamer_profile for test@strug.ca (local E2E).
 * Run: node scripts/seed-live-streamer.js
 */
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

const algorithm = 'aes-256-cbc';
const secretKey = Buffer.from(process.env.ENCRYPTION_KEY || '0'.repeat(64), 'hex');
const iv = Buffer.alloc(16, 0);

function encrypt(text) {
  if (!text) return text;
  const cipher = crypto.createCipheriv(algorithm, secretKey, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: encrypt('test@strug.ca') },
  });
  if (!user) {
    console.error('test@strug.ca not found — run prisma/seed.js first');
    process.exit(1);
  }

  const category = await prisma.live_stream_category.findFirst({
    where: { is_active: true },
    orderBy: { category_id: 'asc' },
  });
  if (!category) {
    console.error('No live_stream_category rows — run prisma/seed.js first');
    process.exit(1);
  }

  const handle = 'teststreamer';
  const profile = await prisma.live_streamer_profile.upsert({
    where: { user_id: user.user_id },
    update: {
      display_name: 'Test Streamer',
      description: 'Local dev streamer account',
      category_id: category.category_id,
      is_active: true,
    },
    create: {
      user_id: user.user_id,
      handle,
      display_name: 'Test Streamer',
      description: 'Local dev streamer account',
      category_id: category.category_id,
      is_active: true,
    },
  });

  console.log('live_streamer_profile ready:', {
    streamer_id: profile.streamer_id,
    handle: profile.handle,
    user_id: profile.user_id,
    category_id: profile.category_id,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
