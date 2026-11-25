// The board_task.source_type marking a task as belonging to the super-admin-only
// PR Review dashboard. Lives here rather than in either route file because both
// board-routes.js (which hides these rows from non-super-admins) and
// board-pr-review-routes.js (which creates them) need it, and a route importing a
// route to get one string is a cycle waiting to happen.
export const PR_REVIEW_SOURCE = 'pr_review';

/**
 * Prisma `where` fragment that hides PR-review tasks from everyone except super-admins.
 * Returns `{}` for a super-admin (see everything) and for a missing member (callers that
 * don't pass one keep their old behaviour).
 *
 * The explicit null branch is load-bearing. `board_task.source_type` is nullable and
 * almost every ordinary task has it NULL. Prisma compiles `{ not: 'pr_review' }` to SQL
 * `source_type != 'pr_review'`, and a comparison against NULL is never true — so the
 * naive form hides the ENTIRE board from non-super-admins rather than just the review
 * rows. Same family as the `notIn`-drops-NULLs and nullable-relation-filter traps.
 */
export function hidePrReviewWhere(member) {
  if (!member || member.is_super_admin) return {};
  return { OR: [{ source_type: null }, { source_type: { not: PR_REVIEW_SOURCE } }] };
}

/** True when a task belongs to the PR-review dashboard and this member may not see it. */
export function isHiddenPrReviewTask(task, member) {
  if (!task || task.source_type !== PR_REVIEW_SOURCE) return false;
  if (!member) return false;
  return !member.is_super_admin;
}
