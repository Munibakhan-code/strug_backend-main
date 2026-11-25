import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../app.js';
import { db, truncateAll, closeDb } from '../helpers/db.js';

// The PR Review board is super-admin only, but its tasks live on the SHARED board_task
// table so they inherit the status flow, audit trail and GitHub webhook. That makes the
// visibility boundary the thing most worth locking down: without it, every board member
// would see the PR titles on the main task board even though the dashboard is gated.
//
// This exercises the real Express app, not the helper in isolation.

function boardHeader(member) {
  const token = jwt.sign(
    { permission: 'board', member_id: member.member_id },
    process.env.ACCESS_TOKEN_KEY,
    { expiresIn: '1h' },
  );
  return { Authorization: `Bearer ${token}` };
}

let seq = 0;
async function createBoardMember(overrides = {}) {
  seq += 1;
  return db.board_member.create({
    data: {
      name: 'Board Member',
      email: `prreview-${Date.now()}-${seq}@strug.ca`,
      password: 'hashed-unused',
      status: 'approved',
      can_review: true,
      can_assign: true,
      ...overrides,
    },
  });
}

describe('PR review board access', () => {
  let superAdmin, ordinary, round, reviewTask, ordinaryTask;

  beforeEach(async () => {
    await truncateAll();
    superAdmin = await createBoardMember({ is_super_admin: true });
    ordinary = await createBoardMember({ is_super_admin: false });

    round = await db.pr_review_round.create({
      data: { title: 'Round 1', summary: 'Nothing promoted.', author_id: superAdmin.member_id },
    });

    reviewTask = await db.board_task.create({
      data: {
        title: '#1113 Live platform health',
        description: 'Do not merge.',
        assigner_id: superAdmin.member_id,
        status: 'ready_for_review',
        source_type: 'pr_review',
        source_id: round.round_id,
      },
    });
    await db.pr_review_detail.create({
      data: {
        task_id: reviewTask.task_id,
        round_id: round.round_id,
        plain_summary: 'Socket chat is broken on this branch.',
      },
    });

    // An ordinary task with source_type NULL — the case the naive filter would have eaten.
    ordinaryTask = await db.board_task.create({
      data: {
        title: 'Fix the courier fare rounding',
        description: 'Ordinary work.',
        assigner_id: superAdmin.member_id,
        status: 'backlog',
      },
    });
  });

  afterAll(async () => { await truncateAll(); await closeDb(); });

  it('refuses the review dashboard to a non-super-admin', async () => {
    const res = await request(app).get('/board-pr-review/rounds').set(boardHeader(ordinary));
    expect(res.status).toBe(403);
  });

  it('serves the review dashboard to a super-admin', async () => {
    const res = await request(app).get('/board-pr-review/rounds').set(boardHeader(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body.rounds).toHaveLength(1);
    expect(res.body.rounds[0].counts.total).toBe(1);
    expect(res.body.rounds[0].counts.pending).toBe(1);
  });

  it('hides review tasks from the shared board for a non-super-admin', async () => {
    const res = await request(app).get('/board/tasks').set(boardHeader(ordinary));
    expect(res.status).toBe(200);
    const titles = res.body.tasks.map((t) => t.title);
    expect(titles).not.toContain('#1113 Live platform health');
  });

  it('still shows ordinary NULL-source_type tasks to a non-super-admin', async () => {
    // The regression that matters. board_task.source_type is nullable and almost every
    // real task has it NULL; a bare `{ not: 'pr_review' }` is SQL `!=`, never true for
    // NULL, so it would empty the entire board for everyone who is not a super-admin.
    const res = await request(app).get('/board/tasks').set(boardHeader(ordinary));
    expect(res.status).toBe(200);
    const titles = res.body.tasks.map((t) => t.title);
    expect(titles).toContain('Fix the courier fare rounding');
    expect(res.body.tasks).toHaveLength(1);
  });

  it('shows both tasks to a super-admin', async () => {
    const res = await request(app).get('/board/tasks').set(boardHeader(superAdmin));
    expect(res.status).toBe(200);
    const titles = res.body.tasks.map((t) => t.title);
    expect(titles).toContain('#1113 Live platform health');
    expect(titles).toContain('Fix the courier fare rounding');
  });

  it('404s a review task by id for a non-super-admin, without confirming it exists', async () => {
    const res = await request(app)
      .get(`/board/tasks/${reviewTask.task_id}/comments`)
      .set(boardHeader(ordinary));
    expect(res.status).toBe(404);
  });

  it('refuses a non-super-admin moving a review task through the workflow', async () => {
    const res = await request(app)
      .patch(`/board/tasks/${reviewTask.task_id}`)
      .set(boardHeader(ordinary))
      .send({ status: 'approved' });
    expect(res.status).toBe(404);

    const after = await db.board_task.findUnique({ where: { task_id: reviewTask.task_id } });
    expect(after.status).toBe('ready_for_review');
  });

  it('leaves ordinary tasks reachable by id for a non-super-admin', async () => {
    const res = await request(app)
      .get(`/board/tasks/${ordinaryTask.task_id}/comments`)
      .set(boardHeader(ordinary));
    expect(res.status).toBe(200);
  });

  it('publishes a round and links each PR for the webhook to track', async () => {
    const res = await request(app)
      .post('/board-pr-review/rounds')
      .set(boardHeader(superAdmin))
      .send({
        title: 'Round 2',
        summary: 'One PR.',
        items: [{
          title: '#1116 jobs alerts fix',
          repo: 'strug_backend-main',
          pr_number: 1116,
          pr_url: 'https://github.com/strug-org/strug_backend-main/pull/1116',
          verdict: 'merge_ready',
          plain_summary: 'Stops alerts under-matching.',
        }],
      });
    expect(res.status).toBe(201);

    const taskId = res.body.task_ids[0];
    const task = await db.board_task.findUnique({ where: { task_id: taskId } });
    expect(task.status).toBe('ready_for_review');
    expect(task.source_type).toBe('pr_review');
    expect(task.source_id).toBe(res.body.round_id);

    const links = await db.board_pr_link.findMany({ where: { task_id: taskId } });
    expect(links).toHaveLength(1);
    expect(links[0].merged).toBe(false);
  });

  it('refuses the flattened item feed to a non-super-admin', async () => {
    const res = await request(app).get('/board-pr-review/items').set(boardHeader(ordinary));
    expect(res.status).toBe(403);
  });

  it('serves every PR across rounds, each carrying its round and review detail', async () => {
    await request(app)
      .post('/board-pr-review/rounds')
      .set(boardHeader(superAdmin))
      .send({
        title: 'Round 2',
        summary: 'Two PRs, one of them risky.',
        items: [
          {
            title: '#2001 safe change',
            repo: 'strug_backend-main',
            pr_url: 'https://github.com/strug-org/strug_backend-main/pull/2001',
            verdict: 'merge_ready',
            risk_level: 'none',
            plain_summary: 'Nothing alarming.',
          },
          {
            title: '#2002 risky change',
            repo: 'strug-final-frontend',
            pr_url: 'https://github.com/strug-org/strug-final-frontend/pull/2002',
            verdict: 'blocked',
            risk_level: 'severe',
            plain_summary: 'Charges the wrong amount.',
          },
        ],
      });

    const res = await request(app).get('/board-pr-review/items').set(boardHeader(superAdmin));
    expect(res.status).toBe(200);
    // The seeded round's single PR plus the two just published.
    expect(res.body.items).toHaveLength(3);

    const risky = res.body.items.find((i) => i.title === '#2002 risky change');
    expect(risky.decision).toBe('pending');
    expect(risky.detail.risk_level).toBe('severe');
    expect(risky.detail.repo).toBe('strug-final-frontend');
    expect(risky.round.title).toBe('Round 2');
    expect(risky.pr_links).toHaveLength(1);

    // Newest round first, so nothing from round 2 may appear after a round 1 item.
    const roundIds = res.body.items.map((i) => i.round.round_id);
    expect(roundIds).toEqual([...roundIds].sort((a, b) => b - a));
  });

  it('refuses publishing to a non-super-admin', async () => {
    const res = await request(app)
      .post('/board-pr-review/rounds')
      .set(boardHeader(ordinary))
      .send({ title: 'x', summary: 'y', items: [{ title: 'z', plain_summary: 'w' }] });
    expect(res.status).toBe(403);
    expect(await db.pr_review_round.count()).toBe(1); // only the one from beforeEach
  });
});
