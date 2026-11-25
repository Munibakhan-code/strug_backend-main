/**
 * Shared password rules — keep register / reset / change-password identical.
 */
export const PASSWORD_MAX_LENGTH = 200;

export function validatePasswordStrength(password) {
  const pwd = typeof password === 'string' ? password : '';
  const errors = [];
  if (pwd.length < 8) errors.push('at least 8 characters');
  if (pwd.length > PASSWORD_MAX_LENGTH) errors.push(`at most ${PASSWORD_MAX_LENGTH} characters`);
  if (!/[A-Z]/.test(pwd)) errors.push('an uppercase letter');
  if (!/[a-z]/.test(pwd)) errors.push('a lowercase letter');
  if (!/[0-9]/.test(pwd)) errors.push('a number');
  return errors;
}
