-- Widen columns that store AEAD ciphertext (enc1.<iv>.<cipher>) for tax IDs and phones (#1295 follow-up).

ALTER TABLE "ads_account_profile" ALTER COLUMN "tax_id" TYPE VARCHAR(512);
ALTER TABLE "ads_account_profile" ALTER COLUMN "brn" TYPE VARCHAR(512);

ALTER TABLE "driver_emergency_contact" ALTER COLUMN "phone" TYPE VARCHAR(512);
ALTER TABLE "trip_sos_incident" ALTER COLUMN "contact_phone" TYPE VARCHAR(512);
ALTER TABLE "emergency_contact" ALTER COLUMN "phone_number" TYPE VARCHAR(512);
ALTER TABLE "event_guest" ALTER COLUMN "phone" TYPE VARCHAR(512);
