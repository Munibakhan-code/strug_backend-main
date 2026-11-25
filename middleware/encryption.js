import { encrypt, decrypt, encryptSecret, decryptSecret } from "../utils/crypto.js";
import { encryptedFields } from "../utils/encryption-config.js";

function fieldSpecsForModel(model) {
  const raw = encryptedFields?.[model];
  if (!raw) return [];
  // Support legacy string[] and new { field, mode }[] shapes.
  return raw.map((entry) => (
    typeof entry === "string" ? { field: entry, mode: "deterministic" } : entry
  ));
}

function sealValue(value, mode) {
  if (value == null || value === "") return value;
  if (mode === "aead") return encryptSecret(value);
  return encrypt(value);
}

function openValue(value, mode) {
  if (value == null || value === "") return value;
  if (mode === "aead") return decryptSecret(value);
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

function encryptDataObject(data, specs) {
  if (!data || typeof data !== "object") return;
  for (const { field, mode } of specs) {
    if (data[field] != null && data[field] !== "") {
      data[field] = sealValue(data[field], mode);
    }
  }
}

/**
 * Encrypt equality lookups for deterministic fields only (AEAD cannot round-trip where).
 */
function encryptWhereObject(where, specs) {
  if (!where || typeof where !== "object") return;
  const deterministic = specs.filter((s) => s.mode === "deterministic");
  if (!deterministic.length) return;

  for (const { field } of deterministic) {
    if (where[field] != null && typeof where[field] === "string") {
      where[field] = encrypt(where[field]);
    } else if (where[field]?.equals != null && typeof where[field].equals === "string") {
      where[field].equals = encrypt(where[field].equals);
    } else if (Array.isArray(where[field]?.in)) {
      where[field].in = where[field].in.map((v) => (typeof v === "string" ? encrypt(v) : v));
    }
  }
  if (Array.isArray(where.AND)) where.AND.forEach((w) => encryptWhereObject(w, specs));
  if (Array.isArray(where.OR)) where.OR.forEach((w) => encryptWhereObject(w, specs));
  if (where.NOT) {
    if (Array.isArray(where.NOT)) where.NOT.forEach((w) => encryptWhereObject(w, specs));
    else encryptWhereObject(where.NOT, specs);
  }
}

export const encryptionMiddleware = async (params, next) => {
  const model = params.model;
  const action = params.action;
  const fieldMap = encryptedFields || {};
  const configuredModels = Object.keys(fieldMap);
  if (configuredModels.length === 0) {
    return next(params);
  }

  const specs = fieldSpecsForModel(model);
  if (specs.length && ["create", "update", "upsert"].includes(action)) {
    if (params.args?.data) {
      if (action === "upsert") {
        encryptDataObject(params.args.data.create, specs);
        encryptDataObject(params.args.data.update, specs);
        // Prisma upsert also uses top-level create/update keys:
        encryptDataObject(params.args.create, specs);
        encryptDataObject(params.args.update, specs);
      } else {
        encryptDataObject(params.args.data, specs);
      }
    }
  }

  if (specs.length && params.args?.where) {
    encryptWhereObject(params.args.where, specs);
  }

  const result = await next(params);

  const allSpecs = Object.values(fieldMap).flat().map((entry) => (
    typeof entry === "string" ? { field: entry, mode: "deterministic" } : entry
  ));
  if (!allSpecs.length) return result;

  const byField = new Map(allSpecs.map((s) => [s.field, s.mode]));

  const recursiveDecrypt = (data) => {
    if (!data || typeof data !== "object") return data;

    if (Array.isArray(data)) {
      return data.map((item) => recursiveDecrypt(item));
    }

    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object") {
        data[key] = recursiveDecrypt(value);
        continue;
      }

      if (byField.has(key) && value !== null && value !== undefined) {
        try {
          data[key] = openValue(value, byField.get(key));
        } catch {
          /* leave ciphertext if key/env mismatch */
        }
      }
    }

    return data;
  };

  return recursiveDecrypt(result);
};
