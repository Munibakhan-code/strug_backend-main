/**
 * #1295 / #1296: AEAD field encryption + driver_document soft-delete helpers.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PRISMA_CLIENT_OMIT } from '../../utils/prisma-client.js';
import { encryptedFields } from '../../utils/encryption-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('at-rest encryption config (#1295)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
  });

  it('configures AEAD for bank, withdrawal, ads tax, and emergency/guest phones', () => {
    expect(encryptedFields.bank_info).toEqual([
      expect.objectContaining({ field: 'bank_account_number', mode: 'aead' }),
    ]);
    expect(encryptedFields.WithdrawalRequest[0].field).toBe('account_number');
    expect(encryptedFields.ArtistWithdrawalRequest[0].mode).toBe('aead');
    expect(encryptedFields.CelebrityWithdrawalRequest[0].mode).toBe('aead');
    expect(encryptedFields.ads_account_profile).toEqual([
      expect.objectContaining({ field: 'tax_id', mode: 'aead' }),
      expect.objectContaining({ field: 'brn', mode: 'aead' }),
    ]);
    expect(encryptedFields.driver_emergency_contact[0].field).toBe('phone');
    expect(encryptedFields.emergency_contact[0].field).toBe('phone_number');
    expect(encryptedFields.trip_sos_incident[0].field).toBe('contact_phone');
    expect(encryptedFields.event_guest[0]).toEqual(
      expect.objectContaining({ field: 'phone', mode: 'aead' }),
    );
  });

  it('encryptSecret uses random IV and round-trips; plaintext passthrough on decrypt', async () => {
    const { encryptSecret, decryptSecret, isAeadCiphertext } = await import('../../utils/crypto.js');
    const a = encryptSecret('123456789');
    const b = encryptSecret('123456789');
    expect(isAeadCiphertext(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('123456789');
    expect(decryptSecret('plaintext-account')).toBe('plaintext-account');
    expect(encryptSecret(a)).toBe(a);
  });
});

describe('driver_document soft-delete (#1296)', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const migration = fs.readFileSync(
    path.join(__dirname, '../../prisma/migrations/20260905180000_driver_document_soft_delete/migration.sql'),
    'utf8',
  );
  const profileSrc = fs.readFileSync(
    path.join(__dirname, '../../routes/driver-profile-routes.js'),
    'utf8',
  );
  const docSrc = fs.readFileSync(
    path.join(__dirname, '../../routes/driver-document-routes.js'),
    'utf8',
  );

  it('schema uses SetNull + deleted_at instead of Cascade wipe', () => {
    expect(schema).toMatch(/model driver_document[\s\S]*?deleted_at\s+DateTime\?/);
    expect(schema).toMatch(/onDelete:\s*SetNull/);
    expect(schema).not.toMatch(/driver_document[\s\S]{0,400}onDelete:\s*Cascade/);
  });

  it('migration adds partial unique for active docs and SET NULL FK', () => {
    expect(migration).toMatch(/deleted_at/);
    expect(migration).toMatch(/driver_document_active_profile_type_key/);
    expect(migration).toMatch(/ON DELETE SET NULL/i);
  });

  it('profile delete soft-archives documents before delete', () => {
    expect(profileSrc).toMatch(/deleted_at:\s*new Date\(\)/);
    expect(profileSrc).toMatch(/driver_document\.updateMany/);
  });

  it('document list excludes soft-deleted rows', () => {
    expect(docSrc).toMatch(/deleted_at:\s*null/);
  });

  it('omit still strips document_url and document_name', () => {
    expect(PRISMA_CLIENT_OMIT.driver_document.document_url).toBe(true);
    expect(PRISMA_CLIENT_OMIT.driver_document.document_name).toBe(true);
  });
});

describe('flo_user unique owner (#1293)', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const migration = fs.readFileSync(
    path.join(__dirname, '../../prisma/migrations/20260905140000_flo_user_unique_health_fks/migration.sql'),
    'utf8',
  );
  const floSrc = fs.readFileSync(
    path.join(__dirname, '../../routes/flo-user-routes.js'),
    'utf8',
  );

  it('schema requires unique flo_user.user_id and required child FKs', () => {
    expect(schema).toMatch(/model flo_user[\s\S]*?user_id\s+Int\b/);
    expect(schema).toMatch(/model flo_user[\s\S]*?@@unique\(\[user_id\]\)/);
    expect(schema).toMatch(/model period[\s\S]*?flo_user_id\s+Int\b/);
    expect(schema).toMatch(/model symptom_log[\s\S]*?flo_user_id\s+Int\b/);
    expect(schema).toMatch(/model cycle_prediction[\s\S]*?flo_user_id\s+Int\b/);
  });

  it('migration dedupes then enforces NOT NULL + unique user_id', () => {
    expect(migration).toMatch(/flo_user_user_id_key/);
    expect(migration).toMatch(/ALTER COLUMN "user_id" SET NOT NULL/);
    expect(migration).toMatch(/ALTER COLUMN "flo_user_id" SET NOT NULL/);
  });

  it('create rejects duplicate flo profile for the same account', () => {
    expect(floSrc).toMatch(/Flo profile already exists for this account/);
    expect(floSrc).toMatch(/P2002/);
    expect(floSrc).toMatch(/user_id:\s*req\.user\.user_id/);
  });
});
