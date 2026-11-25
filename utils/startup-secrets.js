/**
 * Fail-loud checks for secrets that otherwise crash later with opaque errors
 * (crypto.js Buffer.from(undefined), jwt.verify with an empty key).
 */
const MIN_JWT_SECRET_LEN = 16;

function jwtSecretOk(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length >= MIN_JWT_SECRET_LEN;
}

export function inspectCriticalSecrets(env = process.env) {
  const issues = [];
  const key = env.ENCRYPTION_KEY;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(String(key))) {
    issues.push('ENCRYPTION_KEY must be a 64-char hex string (32 bytes for aes-256-cbc)');
  }
  if (!jwtSecretOk(env.ACCESS_TOKEN_KEY)) {
    issues.push(`ACCESS_TOKEN_KEY is missing or shorter than ${MIN_JWT_SECRET_LEN} characters`);
  }
  if (!jwtSecretOk(env.REFRESH_TOKEN_KEY)) {
    issues.push(`REFRESH_TOKEN_KEY is missing or shorter than ${MIN_JWT_SECRET_LEN} characters`);
  }
  return issues;
}

export function logCriticalSecrets(env = process.env, log = console) {
  const issues = inspectCriticalSecrets(env);
  if (!issues.length) {
    log.log('[startup] ✓ ENCRYPTION_KEY, ACCESS_TOKEN_KEY, and REFRESH_TOKEN_KEY look valid');
    return { ok: true, issues };
  }
  for (const issue of issues) {
    log.error(`[startup] ${issue}`);
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(`Refusing to start: ${issues.join('; ')}`);
  }
  return { ok: false, issues };
}
