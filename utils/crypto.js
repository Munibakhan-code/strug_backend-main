import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const algorithm = "aes-256-cbc";
const ENCRYPTION_KEY_ERR =
  "ENCRYPTION_KEY must be a 64-char hex string (32 bytes for aes-256-cbc)";
// NOTE: fixed IV is historical — changing it would make every stored email unreadable.
// New writes still use it for lookup compatibility; normalize email case instead.
const iv = Buffer.alloc(16, 0);

let secretKeyCache;

function getSecretKey() {
  if (secretKeyCache) return secretKeyCache;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(String(raw))) {
    throw new Error(ENCRYPTION_KEY_ERR);
  }
  secretKeyCache = Buffer.from(raw, "hex");
  return secretKeyCache;
}

export function encrypt(text) {
  if (!text) return text;
  const cipher = crypto.createCipheriv(algorithm, getSecretKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
}

export function decrypt(encrypted) {
  if (!encrypted) return encrypted;
  const decipher = crypto.createDecipheriv(algorithm, getSecretKey(), iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

const AEAD_PREFIX = "enc1.";

/**
 * Non-lookup secrets (bank numbers, etc.): random IV per write so identical
 * plaintexts do not collide in ciphertext. Format: enc1.<ivHex>.<cipherHex>
 */
export function encryptSecret(text) {
  if (text == null || text === "") return text;
  const plain = String(text);
  if (plain.startsWith(AEAD_PREFIX)) return plain; // already sealed
  const rowIv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, getSecretKey(), rowIv);
  let encrypted = cipher.update(plain, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${AEAD_PREFIX}${rowIv.toString("hex")}.${encrypted}`;
}

export function decryptSecret(payload) {
  if (payload == null || payload === "") return payload;
  const raw = String(payload);
  if (!raw.startsWith(AEAD_PREFIX)) {
    // Legacy plaintext, or older deterministic hex. Only attempt fixed-IV decrypt on hex-looking values.
    if (/^[0-9a-f]+$/i.test(raw) && raw.length >= 32 && raw.length % 2 === 0) {
      try {
        return decrypt(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  }
  const rest = raw.slice(AEAD_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) throw new Error("Invalid enc1 payload");
  const rowIv = Buffer.from(rest.slice(0, dot), "hex");
  const cipherHex = rest.slice(dot + 1);
  const decipher = crypto.createDecipheriv(algorithm, getSecretKey(), rowIv);
  let decrypted = decipher.update(cipherHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export function isAeadCiphertext(value) {
  return typeof value === "string" && value.startsWith(AEAD_PREFIX);
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/** Encrypt for deterministic email lookup. Prefer normalized form for new writes. */
export function encryptSearch(text) {
  if (!text) return text;
  return encrypt(text);
}

/** Ciphertexts to try when looking up an email (normalized + legacy as-typed). */
export function emailSearchCiphertexts(email) {
  const raw = String(email || "").trim();
  if (!raw) return [];
  const norm = raw.toLowerCase();
  const keys = [encrypt(norm)];
  if (raw !== norm) keys.push(encrypt(raw));
  return [...new Set(keys)];
}

/** Ciphertext to STORE for new accounts — always lowercase to prevent case-duplicates. */
export function encryptEmailForStorage(email) {
  return encrypt(normalizeEmail(email));
}
