// routes/board-pr-review-routes.js
//
// PR Review board — SUPER-ADMIN ONLY. Mounted at /board-pr-review.
//
// The workflow deliberately reuses board_task rather than reinventing it: one task per
// PR, source_type='pr_review', source_id=<round_id>. That gets the existing status flow
// (ready_for_review → approved | changes_requested), reviewer_id, review_notes, the
// board_comment thread, the board_activity audit trail, and — the useful one — the
// GitHub webhook, which marks board_pr_link rows merged and advances a task to
// on_staging / done on its own. Decisions therefore go through the EXISTING
// PATCH /board/tasks/:id, not through this file.
//
// These routes own only what board_task has nowhere to put: the round write-up and the
// per-PR review content (plain-English summary, expandable technical detail,
// before/after). See pr_review_round + pr_review_detail.
//
// Visibility: the tasks live on the shared board, so board-routes.js hides
// source_type='pr_review' rows from non-super-admins. Without that, every board member
// would see the PR titles on the main task board even though this dashboard is gated.

import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireSuperAdmin } from '../middleware/authenticate-board.js';
import { PR_REVIEW_SOURCE } from '../utils/pr-review-source.js';

const router = express.Router();
router.use(authenticateBoard, requireSuperAdmin);

const VERDICTS = ['merge_ready', 'minor_fixes', 'changes_requested', 'blocked'];
const RISK_LEVELS = ['none', 'mild', 'severe'];

const itemSchema = z.object({
  title: z.string().trim().min(1).max(255),
  repo: z.string().trim().max(120).optional().nullable(),
  pr_number: z.number().int().positive().optional().nullable(),
  pr_url: z.string().trim().max(500).optional().nullable(),
  pr_author: z.string().trim().max(120).optional().nullable(),
  branch: z.string().trim().max(200).optional().nullable(),
  verdict: z.enum(VERDICTS).optional().nullable(),
  tldr: z.string().max(2000).optional().nullable(),
  plain_summary: z.string().trim().min(1),
  technical_detail: z.string().optional().nullable(),
  before_text: z.string().optional().nullable(),
  after_text: z.string().optional().nullable(),
  before_code: z.string().optional().nullable(),
  after_code: z.string().optional().nullable(),
  code_lang: z.string().max(30).optional().nullable(),
  risk_note: z.string().optional().nullable(),
  risk_level: z.enum(RISK_LEVELS).optional().nullable(),
});

const roundSchema = z.object({
  title: z.string().trim().min(1).max(255),
  summary: z.string().trim().min(1),
  reviewed_at: z.string().datetime().optional(),
  items: z.array(itemSchema).min(1).max(50),
});

/** board_task.status → what the reviewer decided. */
function decisionOf(status) {
  if (status === 'approved' || status === 'on_staging' || status === 'done') return 'approved';
  if (status === 'changes_requested') return 'hold';
  return 'pending';
}

// GET /board-pr-review/rounds — newest first, with decision counts.
router.get('/rounds', async (_req, res) => {
  try {
    const rounds = await prisma.pr_review_round.findMany({
      orderBy: { reviewed_at: 'desc' },
      take: 100,
    });
    if (!rounds.length) return res.json({ successful: true, rounds: [] });

    const tasks = await prisma.board_task.findMany({
      where: {
        source_type: PR_REVIEW_SOURCE,
        source_id: { in: rounds.map((r) => r.round_id) },
      },
      select: { task_id: true, source_id: true, status: true },
    });

    const byRound = new Map();
    for (const t of tasks) {
      const bucket = byRound.get(t.source_id) || { total: 0, approved: 0, hold: 0, pending: 0 };
      bucket.total += 1;
      bucket[decisionOf(t.status)] += 1;
      byRound.set(t.source_id, bucket);
    }

    return res.json({
      successful: true,
      rounds: rounds.map((r) => ({
        ...r,
        counts: byRound.get(r.round_id) || { total: 0, approved: 0, hold: 0, pending: 0 },
      })),
    });
  } catch (err) {
    console.error('[board-pr-review] list rounds failed:', err);
    return res.status(500).json({ error: 'Could not load review rounds' });
  }
});

// GET /board-pr-review/items — every PR across every round, flattened, newest round first.
//
// The dashboard slices the same set several ways (awaiting decision, on hold, severe risk,
// by repo, merge state), and those cuts are all cross-round. Doing them client-side off
// /rounds/:id would mean one request per round and would get slower every week, so the
// join happens once here and the page filters in memory.
router.get('/items', async (_req, res) => {
  try {
    const tasks = await prisma.board_task.findMany({
      where: { source_type: PR_REVIEW_SOURCE },
      orderBy: [{ source_id: 'desc' }, { task_id: 'asc' }],
      take: 500,
    });
    if (!tasks.length) return res.json({ successful: true, items: [] });

    const taskIds = tasks.map((t) => t.task_id);
    const roundIds = [...new Set(tasks.map((t) => t.source_id).filter((id) => id != null))];

    const [rounds, details, prLinks, members] = await Promise.all([
      prisma.pr_review_round.findMany({ where: { round_id: { in: roundIds } } }),
      prisma.pr_review_detail.findMany({ where: { task_id: { in: taskIds } } }),
      prisma.board_pr_link.findMany({ where: { task_id: { in: taskIds } } }),
      prisma.board_member.findMany({ select: { member_id: true, name: true, email: true } }),
    ]);

    const roundById = new Map(rounds.map((r) => [r.round_id, r]));
    const detailByTask = new Map(details.map((d) => [d.task_id, d]));
    const memberById = new Map(members.map((m) => [m.member_id, m]));
    const linksByTask = new Map();
    for (const l of prLinks) {
      linksByTask.set(l.task_id, [...(linksByTask.get(l.task_id) || []), l]);
    }

    return res.json({
      successful: true,
      items: tasks.map((t) => {
        const round = roundById.get(t.source_id) || null;
        return {
          task_id: t.task_id,
          title: t.title,
          status: t.status,
          decision: decisionOf(t.status),
          review_notes: t.review_notes,
          reviewer: t.reviewer_id ? memberById.get(t.reviewer_id) || null : null,
          vertical: t.vertical,
          updated_at: t.updated_at,
          created_at: t.created_at,
          round: round
            ? { round_id: round.round_id, title: round.title, reviewed_at: round.reviewed_at }
            : null,
          detail: detailByTask.get(t.task_id) || null,
          pr_links: linksByTask.get(t.task_id) || [],
        };
      }),
    });
  } catch (err) {
    console.error('[board-pr-review] list items failed:', err);
    return res.status(500).json({ error: 'Could not load review items' });
  }
});

// GET /board-pr-review/rounds/:id — the round plus each PR: task state + review content
// + PR links. board_pr_link.merged is kept current by the GitHub webhook, so this is the
// live merge state without an outbound API call.
router.get('/rounds/:id', async (req, res) => {
  const roundId = Number(req.params.id);
  if (!Number.isInteger(roundId) || roundId < 1) {
    return res.status(400).json({ error: 'Invalid round id' });
  }
  try {
    const round = await prisma.pr_review_round.findUnique({ where: { round_id: roundId } });
    if (!round) return res.status(404).json({ error: 'Review round not found' });

    const tasks = await prisma.board_task.findMany({
      where: { source_type: PR_REVIEW_SOURCE, source_id: roundId },
      orderBy: { task_id: 'asc' },
    });
    const taskIds = tasks.map((t) => t.task_id);

    const [details, prLinks, members] = await Promise.all([
      prisma.pr_review_detail.findMany({ where: { round_id: roundId } }),
      taskIds.length
        ? prisma.board_pr_link.findMany({ where: { task_id: { in: taskIds } } })
        : Promise.resolve([]),
      prisma.board_member.findMany({ select: { member_id: true, name: true, email: true } }),
    ]);

    const detailByTask = new Map(details.map((d) => [d.task_id, d]));
    const linksByTask = new Map();
    for (const l of prLinks) {
      linksByTask.set(l.task_id, [...(linksByTask.get(l.task_id) || []), l]);
    }
    const memberById = new Map(members.map((m) => [m.member_id, m]));

    return res.json({
      successful: true,
      round,
      items: tasks.map((t) => ({
        task_id: t.task_id,
        title: t.title,
        status: t.status,
        decision: decisionOf(t.status),
        review_notes: t.review_notes,
        reviewer: t.reviewer_id ? memberById.get(t.reviewer_id) || null : null,
        vertical: t.vertical,
        updated_at: t.updated_at,
        detail: detailByTask.get(t.task_id) || null,
        pr_links: linksByTask.get(t.task_id) || [],
      })),
    });
  } catch (err) {
    console.error('[board-pr-review] get round failed:', err);
    return res.status(500).json({ error: 'Could not load review round' });
  }
});

// POST /board-pr-review/rounds — publish a round.
// One board_task per PR at ready_for_review (so the existing transitions drive the
// decision), one pr_review_detail per task, and a board_pr_link per PR url so the
// GitHub webhook can track its merge. Re-publishing the same PR into a NEW round makes
// a new task by design: a PR reviewed twice has two independent outcomes.
router.post('/rounds', async (req, res) => {
  const parsed = roundSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  const { title, summary, reviewed_at, items } = parsed.data;
  const actorId = req.member.member_id;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const round = await tx.pr_review_round.create({
        data: {
          title,
          summary,
          author_id: actorId,
          reviewed_at: reviewed_at ? new Date(reviewed_at) : new Date(),
          published_at: new Date(),
        },
      });

      const created = [];
      for (const item of items) {
        const task = await tx.board_task.create({
          data: {
            title: item.title,
            // The task description stays short and human; the real write-up lives in
            // pr_review_detail so the dashboard can render it in sections.
            description: item.tldr || item.plain_summary.slice(0, 500),
            assigner_id: actorId,
            reviewer_id: actorId,
            status: 'ready_for_review',
            ready_at: new Date(),
            priority: item.risk_level === 'severe' ? 'high' : 'medium',
            vertical: item.repo ?? null,
            source_type: PR_REVIEW_SOURCE,
            source_id: round.round_id,
          },
        });

        await tx.pr_review_detail.create({
          data: {
            task_id: task.task_id,
            round_id: round.round_id,
            repo: item.repo ?? null,
            pr_number: item.pr_number ?? null,
            pr_author: item.pr_author ?? null,
            branch: item.branch ?? null,
            verdict: item.verdict ?? null,
            tldr: item.tldr ?? null,
            plain_summary: item.plain_summary,
            technical_detail: item.technical_detail ?? null,
            before_text: item.before_text ?? null,
            after_text: item.after_text ?? null,
            before_code: item.before_code ?? null,
            after_code: item.after_code ?? null,
            code_lang: item.code_lang ?? null,
            risk_note: item.risk_note ?? null,
            risk_level: item.risk_level ?? null,
          },
        });

        if (item.pr_url) {
          await tx.board_pr_link.create({
            data: { task_id: task.task_id, url: item.pr_url, repo: item.repo ?? null },
          });
        }

        await tx.board_activity.create({
          data: { task_id: task.task_id, actor_id: actorId, action: `published in review round "${title}"` },
        });

        created.push(task.task_id);
      }

      return { round, taskIds: created };
    });

    return res.status(201).json({
      successful: true,
      round_id: result.round.round_id,
      task_ids: result.taskIds,
    });
  } catch (err) {
    console.error('[board-pr-review] publish round failed:', err);
    return res.status(500).json({ error: 'Could not publish review round' });
  }
});

// DELETE /board-pr-review/rounds/:id — remove a round and everything it created.
// pr_review_detail cascades off the round; the tasks are archived rather than deleted so
// any board_activity/board_comment history survives.
router.delete('/rounds/:id', async (req, res) => {
  const roundId = Number(req.params.id);
  if (!Number.isInteger(roundId) || roundId < 1) {
    return res.status(400).json({ error: 'Invalid round id' });
  }
  try {
    const round = await prisma.pr_review_round.findUnique({ where: { round_id: roundId } });
    if (!round) return res.status(404).json({ error: 'Review round not found' });

    await prisma.$transaction(async (tx) => {
      await tx.board_task.updateMany({
        where: { source_type: PR_REVIEW_SOURCE, source_id: roundId },
        data: { status: 'archived', archived_at: new Date() },
      });
      await tx.pr_review_round.delete({ where: { round_id: roundId } });
    });

    return res.json({ successful: true });
  } catch (err) {
    console.error('[board-pr-review] delete round failed:', err);
    return res.status(500).json({ error: 'Could not delete review round' });
  }
});

export default router;
