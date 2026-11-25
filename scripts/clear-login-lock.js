/**
 * Clear login rate-limit lock after too many failed attempts.
 * Usage: node scripts/clear-login-lock.js guest@strug.com
 */
import { clearRateLimit } from '../utils/rate-limiter.js';

const login = process.argv[2];
if (!login) {
  console.error('Usage: node scripts/clear-login-lock.js <email-or-username>');
  process.exit(1);
}

await clearRateLimit(`rl:login:${login}`);
console.log(`Cleared login lock for: ${login}`);
