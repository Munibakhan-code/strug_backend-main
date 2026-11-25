// Map of Prisma model -> field encryption descriptors for the encryption middleware.
//
// Modes:
//   aead          — random IV per write (`encryptSecret`). Use for bank numbers and other
//                   non-lookup secrets. Never use for emails that must match findUnique.
//   deterministic — fixed-IV AES (`encrypt`). Only for fields that must stay equality-searchable
//                   after encrypting `where` clauses (login email stays app-layer today).
//
// #1295: bank + withdrawal account numbers, ads tax_id/brn, and emergency/guest phones.
// Email stays on auth write paths (`encryptEmailForStorage`), not this map.
// Ads billing routes write plaintext tax_id; middleware seals (do not pre-encrypt in routes).
//
// After deploy: run `node scripts/backfill-field-encryption.mjs` once so legacy plaintext rows
// are sealed. Reads decrypt both enc1.* and legacy plaintext via decryptSecret fallback.

export const encryptedFields = {
  bank_info: [
    { field: 'bank_account_number', mode: 'aead' },
  ],
  WithdrawalRequest: [
    { field: 'account_number', mode: 'aead' },
  ],
  ArtistWithdrawalRequest: [
    { field: 'account_number', mode: 'aead' },
  ],
  CelebrityWithdrawalRequest: [
    { field: 'account_number', mode: 'aead' },
  ],
  ads_account_profile: [
    { field: 'tax_id', mode: 'aead' },
    { field: 'brn', mode: 'aead' },
  ],
  driver_emergency_contact: [
    { field: 'phone', mode: 'aead' },
  ],
  emergency_contact: [
    { field: 'phone_number', mode: 'aead' },
  ],
  trip_sos_incident: [
    { field: 'contact_phone', mode: 'aead' },
  ],
  event_guest: [
    { field: 'phone', mode: 'aead' },
  ],
};
