/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeJobReportReason,
  findBlockedJobContent,
  salaryDisclosureNudge,
  isModerationStatus,
  publicJobVisible,
} from '../../utils/job-moderation.js';

describe('job-moderation', () => {
  it('normalizes report reasons', () => {
    expect(normalizeJobReportReason('scam')).toBe('scam');
    expect(normalizeJobReportReason('NOPE')).toBeNull();
  });

  it('flags light blocked phrases and keeps salary soft', () => {
    expect(findBlockedJobContent('Pay to apply now')).toMatch(/pay to apply/i);
    expect(findBlockedJobContent('Backend engineer')).toBeNull();
    expect(salaryDisclosureNudge({})).toMatch(/Salary not listed/);
    expect(salaryDisclosureNudge({ salary_min: 80000 })).toBeNull();
  });

  it('treats removed/suspended as non-public', () => {
    expect(isModerationStatus('removed')).toBe(true);
    expect(publicJobVisible('open')).toBe(true);
    expect(publicJobVisible('removed')).toBe(false);
  });
});
