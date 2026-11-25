/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  PR_REVIEW_SOURCE,
  hidePrReviewWhere,
  isHiddenPrReviewTask,
} from '../../utils/pr-review-source.js';

const superAdmin = { member_id: 2, is_super_admin: true };
const ordinary = { member_id: 7, is_super_admin: false };

describe('hidePrReviewWhere', () => {
  it('does not filter for a super-admin', () => {
    expect(hidePrReviewWhere(superAdmin)).toEqual({});
  });

  it('leaves existing callers alone when no member is passed', () => {
    expect(hidePrReviewWhere(undefined)).toEqual({});
    expect(hidePrReviewWhere(null)).toEqual({});
  });

  it('keeps NULL source_type rows visible to ordinary members', () => {
    // The whole point. board_task.source_type is nullable and almost every ordinary task
    // has it NULL. A bare { not: 'pr_review' } becomes SQL `!=`, which is never true for
    // NULL, so it would hide the entire board. The null branch must be present.
    const where = hidePrReviewWhere(ordinary);
    expect(where.OR).toBeDefined();
    expect(where.OR).toContainEqual({ source_type: null });
    expect(where.OR).toContainEqual({ source_type: { not: PR_REVIEW_SOURCE } });
  });

  it('is not the naive form that drops NULLs', () => {
    const where = hidePrReviewWhere(ordinary);
    // A regression guard: if someone "simplifies" this back to a bare not-filter, the
    // shared board silently empties for everyone who is not a super-admin.
    expect(where.source_type).toBeUndefined();
  });
});

describe('isHiddenPrReviewTask', () => {
  const reviewTask = { task_id: 1, source_type: PR_REVIEW_SOURCE };
  const bugTask = { task_id: 2, source_type: 'bug_report' };
  const plainTask = { task_id: 3, source_type: null };

  it('hides review tasks from ordinary members', () => {
    expect(isHiddenPrReviewTask(reviewTask, ordinary)).toBe(true);
  });

  it('shows review tasks to super-admins', () => {
    expect(isHiddenPrReviewTask(reviewTask, superAdmin)).toBe(false);
  });

  it('never hides ordinary or bug-derived tasks', () => {
    expect(isHiddenPrReviewTask(bugTask, ordinary)).toBe(false);
    expect(isHiddenPrReviewTask(plainTask, ordinary)).toBe(false);
  });

  it('is inert when no member is supplied', () => {
    expect(isHiddenPrReviewTask(reviewTask, undefined)).toBe(false);
    expect(isHiddenPrReviewTask(null, ordinary)).toBe(false);
  });
});
