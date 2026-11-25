/**
 * One-shot backfill for #1295 at-rest AEAD encryption on bank / withdrawal /
 * ads tax IDs / emergency + guest phones.
 *
 * Usage (from backend/):
 *   node scripts/backfill-field-encryption.mjs
 *   node scripts/backfill-field-encryption.mjs --dry-run
 *
 * Safe to re-run: rows already prefixed with enc1. are skipped.
 */
import 'dotenv/config';
import prisma from '../utils/prisma-client.js';
import { encryptSecret, isAeadCiphertext } from '../utils/crypto.js';

const dryRun = process.argv.includes('--dry-run');

const TARGETS = [
  { model: 'bank_info', id: 'bank_info_id', field: 'bank_account_number' },
  { model: 'withdrawalRequest', id: 'id', field: 'account_number' },
  { model: 'artistWithdrawalRequest', id: 'id', field: 'account_number' },
  { model: 'celebrityWithdrawalRequest', id: 'id', field: 'account_number' },
  { model: 'ads_account_profile', id: 'profile_id', field: 'tax_id' },
  { model: 'ads_account_profile', id: 'profile_id', field: 'brn' },
  { model: 'driver_emergency_contact', id: 'driver_profile_id', field: 'phone' },
  { model: 'emergency_contact', id: 'emergency_contact_id', field: 'phone_number' },
  { model: 'trip_sos_incident', id: 'incident_id', field: 'contact_phone' },
  { model: 'event_guest', id: 'event_guest_id', field: 'phone' },
];

async function backfillTable({ model, id, field }) {
  const delegate = prisma[model];
  if (!delegate?.findMany) {
    console.warn(`skip ${model}: delegate missing`);
    return { model, field, scanned: 0, updated: 0 };
  }

  const rows = await delegate.findMany({
    select: { [id]: true, [field]: true },
  });

  let updated = 0;
  for (const row of rows) {
    const value = row[field];
    if (value == null || value === '') continue;
    if (isAeadCiphertext(value)) continue;

    const sealed = encryptSecret(value);
    if (dryRun) {
      console.log(`[dry-run] ${model}.${field} ${row[id]}`);
      updated += 1;
      continue;
    }
    await delegate.update({
      where: { [id]: row[id] },
      data: { [field]: sealed },
    });
    updated += 1;
  }
  return { model, field, scanned: rows.length, updated };
}

async function main() {
  console.log(dryRun ? 'Backfill dry-run' : 'Backfill writing ciphertext');
  for (const t of TARGETS) {
    // Avoid double-encryption via middleware: write with a short-circuit by using
    // encryptSecret here; middleware will see enc1. and leave it (encryptSecret is idempotent).
    const result = await backfillTable(t);
    console.log(result);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
