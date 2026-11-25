#!/usr/bin/env node
/**
 * Bulk-create @strug-dummy.ca feed personas (user + social_profile) for cold-start engagement.
 *
 * Matches the convention used by reseed-dummy-avatars.mjs (plaintext email endsWith @strug-dummy.ca).
 * After --apply, run: node scripts/reseed-dummy-avatars.mjs --apply
 *
 * SAFE BY DEFAULT: dry-run. Pass --apply to write.
 *
 *   node scripts/seed-feed-users.mjs --count=100
 *   node scripts/seed-feed-users.mjs --count=50 --prefix=fan --apply
 *
 * Issue: #1220
 */
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import prisma from '../utils/prisma-client.js';
import {
  buildDummyEmail,
  buildDummyHandle,
  DUMMY_EMAIL_SUFFIX,
} from '../utils/seed-engagement.js';

const APPLY = process.argv.includes('--apply');
const countArg = process.argv.find((a) => a.startsWith('--count='));
const COUNT = Math.max(1, parseInt(countArg?.split('=')[1] || '10', 10) || 10);
const prefixArg = process.argv.find((a) => a.startsWith('--prefix='));
const PREFIX = prefixArg?.split('=')[1] || 'feedfan';

function displayName(handle) {
  return `${handle.replace(/_/g, ' ')} ( Fan )`.slice(0, 100);
}

async function main() {
  console.log(`[seed-feed-users] mode: ${APPLY ? 'COMMIT' : 'DRY RUN'}  count: ${COUNT}  prefix: ${PREFIX}`);

  const existing = await prisma.user.count({
    where: { email: { endsWith: DUMMY_EMAIL_SUFFIX } },
  });
  console.log(`[seed-feed-users] existing ${DUMMY_EMAIL_SUFFIX} accounts: ${existing}`);

  const planned = [];
  for (let i = 0; i < COUNT; i++) {
    const handle = buildDummyHandle(PREFIX, existing + i + 1);
    const email = buildDummyEmail(handle);
    planned.push({ handle, email, name: displayName(handle) });
  }

  for (const row of planned) {
    const collision = await prisma.social_profile.findUnique({ where: { handle: row.handle } });
    if (collision) {
      console.log(`  skip @${row.handle} — handle exists`);
      continue;
    }
    console.log(`  + @${row.handle}  ${row.email}`);
    if (!APPLY) continue;

    const refCode = `STRUG-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const password = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);

    await prisma.user.create({
      data: {
        name: row.name,
        email: row.email,
        password,
        ref_code: refCode,
        has_seen_welcome: true,
        social_profile: {
          create: {
            handle: row.handle,
            display_name: row.name,
            accepted_terms: true,
          },
        },
      },
    });
  }

  if (!APPLY) {
    console.log('\n[seed-feed-users] DRY RUN — pass --apply to create accounts.');
    console.log('[seed-feed-users] Then run: node scripts/reseed-dummy-avatars.mjs --apply');
  }
}

main()
  .catch((err) => {
    console.error('[seed-feed-users] fatal:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
