/**
 * Jobs Phase 8 — report reasons, light content policy, moderation helpers (pure).
 */

export const JOB_REPORT_REASONS = [
  'scam',
  'misleading_pay',
  'fake_employer',
  'inappropriate',
  'spam',
  'other',
];

export const JOB_REPORT_STATUSES = ['pending', 'reviewed', 'actioned', 'dismissed'];

export const JOB_MODERATION_ACTIONS = ['remove', 'suspend', 'dismiss'];

/** Employer-editable listing statuses (not admin moderation). */
export const JOB_LISTING_STATUSES = ['open', 'closed', 'draft'];

/** Admin takedown statuses — excluded from public browse / apply. */
export const JOB_MODERATION_STATUSES = ['removed', 'suspended'];

const BLOCKED_PHRASE = /\b(guaranteed\s+income|wire\s+transfer\s+fee|crypto\s+investment\s+job|pay\s+to\s+apply)\b/i;

/** Soft salary policy: missing pay is allowed; callers may surface a UX nudge. */
export function salaryDisclosureNudge(jobOrForm = {}) {
  const lo = jobOrForm.salary_min;
  const hi = jobOrForm.salary_max;
  const hasPay = (lo != null && lo !== '') || (hi != null && hi !== '');
  if (hasPay) return null;
  return 'Salary not listed is allowed, but roles with a pay range usually get more applicants.';
}

/** Light deny-list for create/update — not a full filter engine. */
export function findBlockedJobContent(...parts) {
  const text = parts.filter((p) => p != null && p !== '').map(String).join('\n');
  if (!text.trim()) return null;
  const m = text.match(BLOCKED_PHRASE);
  return m ? m[0] : null;
}

export function isModerationStatus(status) {
  return JOB_MODERATION_STATUSES.includes(String(status || ''));
}

export function normalizeJobReportReason(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return JOB_REPORT_REASONS.includes(v) ? v : null;
}

export function publicJobVisible(status) {
  const s = String(status || 'open');
  return s === 'open';
}
