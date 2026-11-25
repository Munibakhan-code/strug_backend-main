// One-off backfill: bcrypt-hash any plaintext `password` values left in
// appointment_service_providers (the field is now hashed on create/update, but rows
// created before that fix are still cleartext). Idempotent — rows whose password already
// looks like a bcrypt hash ($2a$/$2b$/$2y$) are skipped.
//
// The column is write-only (never used for auth — no bcrypt.compare anywhere), so hashing
// is purely to stop storing the secret in the clear. Run with --dry to preview.
//
//   node scripts/backfill-provider-passwords.mjs --dry
//   node scripts/backfill-provider-passwords.mjs            # staging
//   (prod: run against ENV_PRODUCTION DB only with explicit per-action auth)
import 'dotenv/config';
import bcrypt from 'bcrypt';
import prisma from '../utils/prisma-client.js';

const dryRun = process.argv.includes('--dry');
const isBcrypt = (v) => typeof v === 'string' && /^\$2[aby]\$/.test(v);

try {
  const rows = await prisma.appointment_service_providers.findMany({
    select: { service_provider_id: true, password: true },
  });
  let hashed = 0, already = 0, empty = 0;
  for (const r of rows) {
    if (r.password == null || r.password === '') { empty++; continue; }
    if (isBcrypt(r.password)) { already++; continue; }
    if (!dryRun) {
      const hash = await bcrypt.hash(r.password, 10);
      await prisma.appointment_service_providers.update({
        where: { service_provider_id: r.service_provider_id },
        data: { password: hash },
      });
    }
    hashed++;
  }
  console.log(`${dryRun ? '[dry] ' : ''}providers: ${hashed} hashed, ${already} already-hashed, ${empty} empty (of ${rows.length})`);
} catch (err) {
  console.error('backfill failed:', err.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
