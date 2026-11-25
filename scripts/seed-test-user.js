import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

const PASSWORD = 'Strug2026!';
const OFFICIAL_EMAIL = 'official-local@strug.ca';
const OFFICIAL_HANDLE = 'strug';

const DEV_ACCOUNTS = [
  { email: 'test@strug.ca', name: 'Test User', handle: 'testuser', is_seller: true, is_creator: true },
  { email: 'smoke-chat@strug.ca', name: 'Smoke User B', handle: 'smokechat', is_seller: true },
];

function isProductionLikeDatabaseUrl(url) {
  return /\bprod(?:uction)?\b|strug-prod|postgres\.database\.azure\.com/i.test(url || '');
}

function assertNonProductionSeed() {
  const appEnv = String(process.env.APP_ENV || process.env.NODE_ENV || '').toLowerCase();
  const dbUrl = process.env.DATABASE_URL || '';
  const explicitlyAllowed = process.env.ALLOW_TEST_USER_SEED === 'true';
  const safeLocalDb = !dbUrl || /localhost|127\.0\.0\.1|strug_test|test/i.test(dbUrl);
  if (explicitlyAllowed || (safeLocalDb && !['production', 'prod'].includes(appEnv) && !isProductionLikeDatabaseUrl(dbUrl))) {
    return;
  }
  throw new Error('Refusing to run seed-test-user.js outside a local/test database. Set ALLOW_TEST_USER_SEED=true only for an approved non-production target.');
}

function randomRefCode(prefix) {
  return `${prefix}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function encryptEmail(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return enc;
}

async function upsertOwnedProfile({ handle, userId, displayName, isVerified = false }) {
  const existing = await prisma.social_profile.findUnique({ where: { handle } });
  if (!existing) {
    return prisma.social_profile.create({
      data: {
        user_id: userId,
        handle,
        display_name: displayName,
        accepted_terms: true,
        is_verified: isVerified,
      },
    });
  }
  if (existing.user_id === userId) {
    return prisma.social_profile.update({
      where: { handle },
      data: {
        display_name: displayName,
        accepted_terms: true,
        is_verified: isVerified || existing.is_verified,
      },
    });
  }
  console.warn(`Handle @${handle} already belongs to user ${existing.user_id}; leaving ownership unchanged.`);
  return existing;
}

async function upsertOwnedChannel({ handle, userId, displayName }) {
  const existing = await prisma.channel.findUnique({ where: { handle } });
  if (!existing) {
    return prisma.channel.create({
      data: {
        user_id: userId,
        handle,
        display_name: displayName,
        description: 'Local development channel',
        is_active: true,
      },
    });
  }
  if (existing.user_id === userId) {
    return prisma.channel.update({
      where: { handle },
      data: { display_name: displayName, is_active: true },
    });
  }
  console.warn(`Channel @${handle} already belongs to user ${existing.user_id}; leaving ownership unchanged.`);
  return existing;
}

async function upsertDevAccount({ email, name, handle, is_seller, is_creator }) {
  const encryptedEmail = encryptEmail(email);

  // Remove any stale plaintext record from a previous seed attempt.
  await prisma.user.deleteMany({ where: { email } });

  const hashed = await bcrypt.hash(PASSWORD, 10);
  const existing = await prisma.user.findUnique({ where: { email: encryptedEmail } });
  const user = existing
    ? await prisma.user.update({
        where: { user_id: existing.user_id },
        data: {
          name,
          password: hashed,
          is_seller: !!is_seller,
          is_creator: !!is_creator,
          country: 'Canada',
          currency: 'CAD',
          has_seen_welcome: true,
        },
      })
    : await prisma.user.create({
        data: {
          name,
          email: encryptedEmail,
          password: hashed,
          ref_code: randomRefCode('TEST'),
          is_seller: !!is_seller,
          is_creator: !!is_creator,
          country: 'Canada',
          currency: 'CAD',
          has_seen_welcome: true,
        },
      });

  // Prefer upsert by user_id: a user can already have a profile under a different handle,
  // and upserting only by `handle` then fails on the unique(user_id) constraint.
  const byUser = await prisma.social_profile.findUnique({ where: { user_id: user.user_id } });
  let profile;
  if (byUser) {
    if (byUser.handle !== handle) {
      const handleTaken = await prisma.social_profile.findUnique({ where: { handle } });
      if (handleTaken && handleTaken.user_id !== user.user_id) {
        await prisma.social_profile.update({
          where: { profile_id: handleTaken.profile_id },
          data: { handle: `${handle}_old_${handleTaken.user_id}` },
        });
      }
    }
    profile = await prisma.social_profile.update({
      where: { user_id: user.user_id },
      data: { handle, display_name: name, accepted_terms: true },
    });
  } else {
    const handleTaken = await prisma.social_profile.findUnique({ where: { handle } });
    if (handleTaken) {
      await prisma.social_profile.update({
        where: { profile_id: handleTaken.profile_id },
        data: { handle: `${handle}_old_${handleTaken.user_id}` },
      });
    }
    profile = await prisma.social_profile.create({
      data: {
        user_id: user.user_id,
        handle,
        display_name: name,
        accepted_terms: true,
      },
    });
  }
  const channel = await upsertOwnedChannel({ handle, userId: user.user_id, displayName: name });

  console.log(`✓ ${existing ? 'Reset' : 'Created'} ${email} (user_id: ${user.user_id}, @${profile.handle}, channel @${channel.handle})`);
  return user;
}

async function upsertOfficialAccount() {
  const hashed = await bcrypt.hash(PASSWORD, 10);
  const encryptedEmail = encryptEmail(OFFICIAL_EMAIL);
  const official = await prisma.user.upsert({
    where: { email: encryptedEmail },
    update: {
      name: 'Strug',
      is_creator: true,
      country: 'Canada',
      currency: 'CAD',
      has_seen_welcome: true,
    },
    create: {
      name: 'Strug',
      email: encryptedEmail,
      password: hashed,
      ref_code: randomRefCode('STRUG'),
      is_creator: true,
      country: 'Canada',
      currency: 'CAD',
      has_seen_welcome: true,
    },
  });
  const profile = await upsertOwnedProfile({
    handle: OFFICIAL_HANDLE,
    userId: official.user_id,
    displayName: 'Strug',
    isVerified: true,
  });
  console.log(`✓ Official local account ready (@${profile.handle})`);
}

async function main() {
  assertNonProductionSeed();
  for (const account of DEV_ACCOUNTS) {
    await upsertDevAccount(account);
  }
  await upsertOfficialAccount();
  console.log(`\nDev login password for all accounts above: ${PASSWORD}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
