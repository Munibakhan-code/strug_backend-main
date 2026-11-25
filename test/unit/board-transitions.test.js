import { describe, it, expect } from 'vitest';
import { evaluateTransition, BOARD_STATUSES } from '../../utils/board-transitions.js';

// Member/task factories — only the fields evaluateTransition reads.
const member = (over = {}) => ({ member_id: 1, can_review: false, can_assign: false, ...over });
const task = (over = {}) => ({
  status: 'in_progress',
  assignee_id: null,
  reviewer_id: null,
  title: 'Task',
  board_pr_link: [],
  ...over,
});

describe('BOARD_STATUSES', () => {
  it('lists the full lifecycle', () => {
    expect(BOARD_STATUSES).toEqual([
      'backlog', 'in_progress', 'ready_for_review', 'changes_requested',
      'approved', 'on_staging', 'done', 'archived',
    ]);
  });
});

describe('evaluateTransition — guards', () => {
  it('rejects an unknown target status', () => {
    expect(evaluateTransition(member(), task(), 'nonsense'))
      .toEqual({ ok: false, status: 400, message: 'Unknown status "nonsense"' });
  });
  it('treats a same-status move as an allowed no-op', () => {
    expect(evaluateTransition(member(), task({ status: 'in_progress' }), 'in_progress'))
      .toEqual({ ok: true, sideEffects: {}, notify: null });
  });
  it('routes archive/unarchive through the dedicated action', () => {
    expect(evaluateTransition(member({ can_assign: true }), task({ status: 'in_progress' }), 'archived').status).toBe(400);
    expect(evaluateTransition(member({ can_assign: true }), task({ status: 'archived' }), 'backlog').status).toBe(400);
  });
});

describe('evaluateTransition — webhook-driven states', () => {
  it('forbids manually setting on_staging', () => {
    const r = evaluateTransition(member({ can_assign: true, can_review: true }), task(), 'on_staging');
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
  it('forbids marking a task with PR links Done (it is automatic)', () => {
    const r = evaluateTransition(
      member({ can_assign: true }),
      task({ status: 'approved', board_pr_link: [{ id: 1 }] }),
      'done',
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
  it('uses _prLinkCount as a fallback PR-link signal', () => {
    const r = evaluateTransition(
      member({ can_assign: true }),
      task({ status: 'approved', board_pr_link: undefined, _prLinkCount: 2 }),
      'done',
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
  it('allows manual Done for a no-PR task by assignee/assigner/reviewer', () => {
    const t = task({ status: 'approved', assignee_id: 1, board_pr_link: [] });
    expect(evaluateTransition(member({ member_id: 1 }), t, 'done'))
      .toEqual({ ok: true, sideEffects: {}, notify: null });
    expect(evaluateTransition(member({ member_id: 9, can_assign: true }), t, 'done').ok).toBe(true);
    expect(evaluateTransition(member({ member_id: 9, can_review: true }), t, 'done').ok).toBe(true);
  });
  it('forbids manual Done for an unrelated member', () => {
    const t = task({ status: 'approved', assignee_id: 1, board_pr_link: [] });
    expect(evaluateTransition(member({ member_id: 9 }), t, 'done'))
      .toEqual({ ok: false, status: 403, message: 'You cannot mark this task Done.' });
  });
});

describe('evaluateTransition — review (reviewer only, from ready_for_review)', () => {
  it('forbids a non-reviewer from reviewing', () => {
    expect(evaluateTransition(member({ member_id: 1 }), task({ status: 'ready_for_review', assignee_id: 1 }), 'approved'))
      .toEqual({ ok: false, status: 403, message: 'Only a reviewer can review tasks.' });
  });
  it('409 when reviewing a task that is not Ready for Review', () => {
    expect(evaluateTransition(member({ can_review: true }), task({ status: 'in_progress' }), 'approved').status).toBe(409);
    expect(evaluateTransition(member({ can_review: true }), task({ status: 'in_progress' }), 'changes_requested').status).toBe(409);
  });
  it('approves and notifies the assignee', () => {
    const r = evaluateTransition(
      member({ can_review: true }),
      task({ status: 'ready_for_review', assignee_id: 7, title: 'Ship it' }),
      'approved',
    );
    expect(r.ok).toBe(true);
    expect(r.notify).toEqual({ member_id: 7, type: 'approved', body: '"Ship it" was approved.' });
  });
  it('requires review notes to request changes', () => {
    const r = evaluateTransition(
      member({ can_review: true }),
      task({ status: 'ready_for_review', assignee_id: 7 }),
      'changes_requested',
      { review_notes: '   ' },
    );
    expect(r).toEqual({ ok: false, status: 400, message: 'Review notes are required when requesting changes.' });
  });
  it('records the trimmed note and notifies the assignee on changes_requested', () => {
    const r = evaluateTransition(
      member({ can_review: true }),
      task({ status: 'ready_for_review', assignee_id: 7, title: 'Fix me' }),
      'changes_requested',
      { review_notes: '  please add tests  ' },
    );
    expect(r.ok).toBe(true);
    expect(r.sideEffects).toEqual({ review_notes: 'please add tests' });
    expect(r.notify).toEqual({ member_id: 7, type: 'changes_requested', body: 'Changes requested on "Fix me".' });
  });
});

describe('evaluateTransition — assignee/assigner moves', () => {
  it('lets the assignee move to in_progress', () => {
    expect(evaluateTransition(member({ member_id: 5 }), task({ status: 'backlog', assignee_id: 5 }), 'in_progress'))
      .toEqual({ ok: true, sideEffects: {}, notify: null });
  });
  it('forbids an unrelated, non-supervisor member from moving the task', () => {
    expect(evaluateTransition(member({ member_id: 9 }), task({ status: 'backlog', assignee_id: 5 }), 'in_progress'))
      .toEqual({ ok: false, status: 403, message: 'Only the assignee or a supervisor can move this task.' });
  });
  it('requires an assignee before Ready for Review', () => {
    expect(evaluateTransition(member({ can_assign: true }), task({ status: 'in_progress', assignee_id: null }), 'ready_for_review'))
      .toEqual({ ok: false, status: 409, message: 'Assign the task before sending it for review.' });
  });
  it('sets ready_at and notifies the reviewer on Ready for Review', () => {
    const r = evaluateTransition(
      member({ member_id: 5 }),
      task({ status: 'in_progress', assignee_id: 5, reviewer_id: 3, title: 'Feature' }),
      'ready_for_review',
    );
    expect(r.ok).toBe(true);
    expect(r.sideEffects.ready_at).toBeInstanceOf(Date);
    expect(r.notify).toEqual({ member_id: 3, type: 'ready_for_review', body: '"Feature" is ready for review.' });
  });
});
