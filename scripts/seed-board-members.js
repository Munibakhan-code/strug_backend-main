// scripts/seed-board-members.js
//
// Seeds the two bootstrap accounts for the internal Task Board (strug.ca/board).
// These are the ONLY board members that are not self-registered + human-approved:
//
//   • Supervisor (Codezero) — can_assign + can_manage_members
//   • Senior dev  (you)      — can_review + can_manage_members
//
// Everyone else signs up at /board/signup (must be @strug.ca) and is approved by one
// of these two. Idempotent: re-running updates the capabilities/password in place.
//
// Usage:
//   node scripts/seed-board-members.js
// Override the defaults via env (recommended for prod):
//   BOARD_SUPERVISOR_EMAIL, BOARD_SUPERVISOR_NAME, BOARD_SUPERVISOR_PASSWORD
//   BOARD_REVIEWER_EMAIL,   BOARD_REVIEWER_NAME,   BOARD_REVIEWER_PASSWORD

import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

const SUPERVISOR = {
  name: process.env.BOARD_SUPERVISOR_NAME || 'Codezero',
  email: (process.env.BOARD_SUPERVISOR_EMAIL || 'codezero@strug.ca').toLowerCase(),
  password: process.env.BOARD_SUPERVISOR_PASSWORD || 'Board2026!',
  can_assign: true,
  can_review: false,
  can_manage_members: true,
};

const REVIEWER = {
  name: process.env.BOARD_REVIEWER_NAME || 'Senu',
  email: (process.env.BOARD_REVIEWER_EMAIL || 'senudak@strug.ca').toLowerCase(),
  password: process.env.BOARD_REVIEWER_PASSWORD || 'Board2026!',
  can_assign: false,
  can_review: true,
  can_manage_members: true,
};

async function seedMember(m) {
  if (!m.email.endsWith('@strug.ca')) {
    throw new Error(`Seed email must end with @strug.ca: ${m.email}`);
  }
  const hashed = await bcrypt.hash(m.password, 10);
  const member = await prisma.board_member.upsert({
    where: { email: m.email },
    // NON-CLOBBERING on update: deliberately do NOT reset `password` for an existing
    // member. This script runs on every prod deploy (deploy.yml) to self-heal a
    // wiped board_member table, so it must never overwrite a rotated/real password
    // with the env/default one. The password is only set on `create` (fresh DB).
    update: {
      name: m.name,
      status: 'approved',
      can_assign: m.can_assign,
      can_review: m.can_review,
      can_manage_members: m.can_manage_members,
      approved_at: new Date(),
    },
    create: {
      name: m.name,
      email: m.email,
      password: hashed,
      status: 'approved',
      can_assign: m.can_assign,
      can_review: m.can_review,
      can_manage_members: m.can_manage_members,
      approved_at: new Date(),
    },
  });
  const caps = [
    m.can_assign && 'assign',
    m.can_review && 'review',
    m.can_manage_members && 'manage_members',
  ].filter(Boolean).join(', ');
  console.log(`✔ ${m.email} (id: ${member.member_id}) — approved [${caps}]`);
}

async function main() {
  await seedMember(SUPERVISOR);
  await seedMember(REVIEWER);
  const usingDefaultPw =
    !process.env.BOARD_SUPERVISOR_PASSWORD || !process.env.BOARD_REVIEWER_PASSWORD;
  if (usingDefaultPw) {
    console.warn(
      '\n⚠  One or both accounts use the default password "Board2026!".\n' +
      '   Set BOARD_SUPERVISOR_PASSWORD / BOARD_REVIEWER_PASSWORD before seeding production.',
    );
  }
  console.log('\nBoard members seeded.');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
