// Integration-test DB helpers. Reuses the app's own Prisma singleton so seeded rows go
// through the same encryption/omit extensions the routes use (consistent read/write).
import prisma from '../../utils/prisma-client.js';

export const db = prisma;

let _tables = null;
async function publicTables() {
  if (_tables) return _tables;
  const rows = await db.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'`;
  _tables = rows.map((r) => r.tablename);
  return _tables;
}

/** Wipe every public table (FK-safe) and reset identity sequences. Call in beforeEach. */
export async function truncateAll() {
  const tables = await publicTables();
  if (!tables.length) return;
  const list = tables.map((t) => `"public"."${t}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

// Monotonic suffix so email/username/ref_code stay unique even across truncations.
let seq = 0;
export async function createUser(overrides = {}) {
  seq += 1;
  return db.user.create({
    data: {
      email: `it-user-${seq}@strug.test`,
      username: `it_user_${seq}`,
      name: `IT User ${seq}`,
      password: 'unused-tokens-are-minted',
      ...overrides,
    },
  });
}

/**
 * Seed a dispatch-eligible driver (is_online + fresh last_ping) on a fresh user, so
 * route availability guards (countCanonicalOnlineDrivers) pass. Returns the driver_profile.
 */
export async function seedOnlineDriver(overrides = {}) {
  const driver = await createUser();
  return db.driver_profile.create({
    data: {
      user_id: driver.user_id,
      is_online: true,
      last_ping: new Date(),
      ...overrides,
    },
  });
}

/** Disconnect the shared client. Call in afterAll so Vitest exits cleanly. */
export async function closeDb() {
  await db.$disconnect();
}
