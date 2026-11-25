// utils/board-transitions.js
//
// Server-enforced status-transition policy for the Task Board. Kept separate from the
// route so the rules are unit-testable in isolation — this is the security-critical core
// (a dev must not be able to mark their own work "done", etc.).
//
// Status flow:
//   backlog → in_progress → ready_for_review → (changes_requested ↔ in_progress) → approved
//                                                                        → on_staging → done
//   archived is a side-state reached via the dedicated /archive endpoint.
//
// Roles (a member may hold several):
//   assignee  — task.assignee_id === member.member_id (does the work)
//   reviewer  — member.can_review (reviews / approves)
//   assigner  — member.can_assign (supervisor; creates & assigns)

export const BOARD_STATUSES = [
  'backlog',
  'in_progress',
  'ready_for_review',
  'changes_requested',
  'approved',
  'on_staging',
  'done',
  'archived',
];

// Statuses a member with the given relationship may MOVE A TASK INTO via PATCH /:id.
// on_staging + done are intentionally absent here — they're webhook-driven (M5), with a
// single hand-coded exception for non-code tasks (see evaluateTransition).
const ASSIGNEE_TARGETS = new Set(['backlog', 'in_progress', 'ready_for_review']);

/**
 * Decide whether `member` may move `task` from its current status to `target`.
 *
 * @returns {{ ok: true, sideEffects: object, notify: object|null } | { ok: false, status: number, message: string }}
 *   sideEffects — extra columns to set (e.g. ready_at).
 *   notify      — { member_id, type, body } notification to queue, or null.
 */
export function evaluateTransition(member, task, target, body = {}) {
  if (!BOARD_STATUSES.includes(target)) {
    return { ok: false, status: 400, message: `Unknown status "${target}"` };
  }
  if (target === task.status) {
    return { ok: true, sideEffects: {}, notify: null }; // no-op
  }
  // Archiving has its own endpoint so archived_at is always set consistently.
  if (target === 'archived' || task.status === 'archived') {
    return { ok: false, status: 400, message: 'Use the archive action to archive/unarchive a task' };
  }

  const isAssignee = task.assignee_id != null && task.assignee_id === member.member_id;
  const isReviewer = !!member.can_review;
  const isAssigner = !!member.can_assign;

  // on_staging is only ever set by the GitHub webhook.
  if (target === 'on_staging') {
    return { ok: false, status: 403, message: 'A task moves to On Staging automatically when its PRs merge.' };
  }

  // done: webhook-driven for code tasks; manual only for tasks with NO PR links.
  if (target === 'done') {
    const hasPrLinks = (task.board_pr_link?.length ?? task._prLinkCount ?? 0) > 0;
    if (hasPrLinks) {
      return { ok: false, status: 403, message: 'A task is marked Done automatically when its promotion PR merges.' };
    }
    if (isAssignee || isAssigner || isReviewer) {
      return { ok: true, sideEffects: {}, notify: null };
    }
    return { ok: false, status: 403, message: 'You cannot mark this task Done.' };
  }

  // changes_requested / approved — reviewer only, from ready_for_review.
  if (target === 'changes_requested' || target === 'approved') {
    if (!isReviewer) {
      return { ok: false, status: 403, message: 'Only a reviewer can review tasks.' };
    }
    if (task.status !== 'ready_for_review') {
      return { ok: false, status: 409, message: `Can only ${target === 'approved' ? 'approve' : 'request changes on'} a task that is Ready for Review.` };
    }
    if (target === 'changes_requested') {
      const note = typeof body.review_notes === 'string' ? body.review_notes.trim() : '';
      if (!note) {
        return { ok: false, status: 400, message: 'Review notes are required when requesting changes.' };
      }
      return {
        ok: true,
        sideEffects: { review_notes: note },
        notify: task.assignee_id
          ? { member_id: task.assignee_id, type: 'changes_requested', body: `Changes requested on "${task.title}".` }
          : null,
      };
    }
    // approved
    return {
      ok: true,
      sideEffects: {},
      notify: task.assignee_id
        ? { member_id: task.assignee_id, type: 'approved', body: `"${task.title}" was approved.` }
        : null,
    };
  }

  // backlog / in_progress / ready_for_review — assignee or assigner drive these.
  if (ASSIGNEE_TARGETS.has(target)) {
    if (!(isAssignee || isAssigner)) {
      return { ok: false, status: 403, message: 'Only the assignee or a supervisor can move this task.' };
    }
    if (target === 'ready_for_review') {
      if (task.assignee_id == null) {
        return { ok: false, status: 409, message: 'Assign the task before sending it for review.' };
      }
      return {
        ok: true,
        sideEffects: { ready_at: new Date() },
        notify: task.reviewer_id
          ? { member_id: task.reviewer_id, type: 'ready_for_review', body: `"${task.title}" is ready for review.` }
          : null,
      };
    }
    return { ok: true, sideEffects: {}, notify: null };
  }

  return { ok: false, status: 403, message: `You can't move this task to "${target}".` };
}
