// scripts/seed-board-roles.js
//
// Seeds the built-in RBAC v2 roles (board_role) and backfills every existing board_member
// with a best-fit role derived from their legacy can_* flags — so the flag→role cutover is
// zero-disruption. Idempotent: re-running upserts the built-ins in place and only assigns a
// role to members that don't have one yet (never clobbers a hand-picked role/override).
//
// Runs on every prod deploy (deploy.yml) alongside seed-board-members.js.
//
// Usage: node scripts/seed-board-roles.js

import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { BUILTIN_ROLES, legacyRoleKey } from '../services/board-rbac.js';

dotenv.config();

const prisma = new PrismaClient();

async function seedRoles() {
  const byKey = new Map();
  for (const r of BUILTIN_ROLES) {
    const data = {
      name: r.name,
      description: r.description,
      is_builtin: true,
      access: r.access ?? {},
      manage_members: !!r.manage_members,
      review_tasks: !!r.review_tasks,
      assign_tasks: !!r.assign_tasks,
      is_super_admin: !!r.is_super_admin,
      can_create_channels: !!r.can_create_channels,
    };
    const role = await prisma.board_role.upsert({
      where: { key: r.key },
      update: data, // keep built-ins in sync with code (names/descriptions/access maps)
      create: { key: r.key, ...data },
    });
    byKey.set(r.key, role);
    console.log(`✔ role ${r.key} (id ${role.role_id})`);
  }
  return byKey;
}

async function backfillMembers(byKey) {
  const members = await prisma.board_member.findMany({
    where: { role_id: null },
    // opt out of the password column via select of only what we need for legacyRoleKey
    select: {
      member_id: true, email: true, is_super_admin: true,
      can_manage_members: true, can_access_restricted: true,
      can_assign: true, can_review: true, can_view_users: true,
    },
  });
  for (const m of members) {
    const key = legacyRoleKey(m);
    const role = byKey.get(key);
    if (!role) continue;
    await prisma.board_member.update({
      where: { member_id: m.member_id },
      data: { role_id: role.role_id },
    });
    console.log(`→ ${m.email} → role "${key}"`);
  }
  if (members.length === 0) console.log('No members needed a role backfill.');
}

async function main() {
  const byKey = await seedRoles();
  await backfillMembers(byKey);
  console.log('\nBoard roles seeded.');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
