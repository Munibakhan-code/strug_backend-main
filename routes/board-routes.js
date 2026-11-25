// routes/board-routes.js
//
// Task CRUD + role-enforced status transitions for the internal Task Board.
// Mounted at /board/tasks; every route requires an approved board member.
// See task-board-implementation-plan.md (M3). Transition policy lives in
// utils/board-transitions.js (unit-tested separately).
//
//   GET    /board/tasks               list (filters: status, assignee, vertical)
//   GET    /board/tasks/members       approved members (for assignment dropdowns)
//   POST   /board/tasks               create                         (requireAssign)
//   PATCH  /board/tasks/:id           edit fields / move status (role + transition enforced)
//   POST   /board/tasks/:id/reopen    follow-up task linked to this one (requireAssign)
//   PATCH  /board/tasks/:id/archive   archive                        (requireAssign)
//   POST   /board/tasks/:id/subtasks  add subtask        (assignee or assigner)
//   PATCH  /board/tasks/subtasks/:sid update/toggle subtask
//   DELETE /board/tasks/subtasks/:sid delete subtask
//   POST   /board/tasks/:id/pr-links  add PR link        (assignee or assigner)
//   DELETE /board/tasks/pr-links/:plid delete PR link

import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireAssign } from '../middleware/authenticate-board.js';
import { evaluateTransition } from '../utils/board-transitions.js';
import { hidePrReviewWhere, isHiddenPrReviewTask } from '../utils/pr-review-source.js';

const router = express.Router();
router.use(authenticateBoard);

// ---- helpers --------------------------------------------------------------

function logActivity(taskId, actorId, action) {
  // Fire-and-forget; activity is a best-effort audit trail, never blocks the response.
  prisma.board_activity
    .create({ data: { task_id: taskId, actor_id: actorId ?? null, action } })
    .catch((e) => console.warn('[board] activity log failed:', e.message));
}

async function notify(memberId, type, body, taskId) {
  if (!memberId) return;
  try {
    await prisma.board_notification.create({ data: { member_id: memberId, task_id: taskId ?? null, type, body } });
  } catch (e) {
    console.warn('[board] notification failed:', e.message);
  }
}

// Enrich a set of tasks with member display names, subtasks, and PR links in bulk.
async function enrichTasks(tasks) {
  if (tasks.length === 0) return [];
  const taskIds = tasks.map((t) => t.task_id);
  const memberIds = [
    ...new Set(tasks.flatMap((t) => [t.assigner_id, t.assignee_id, t.reviewer_id]).filter((x) => x != null)),
  ];

  const [members, subtasks, prLinks] = await Promise.all([
    memberIds.length
      ? prisma.board_member.findMany({ where: { member_id: { in: memberIds } }, select: { member_id: true, name: true, email: true } })
      : [],
    prisma.board_subtask.findMany({ where: { task_id: { in: taskIds } }, orderBy: [{ position: 'asc' }, { subtask_id: 'asc' }] }),
    prisma.board_pr_link.findMany({ where: { task_id: { in: taskIds } }, orderBy: { pr_link_id: 'asc' } }),
  ]);

  const nameOf = new Map(members.map((m) => [m.member_id, m.name]));
  const subsByTask = new Map();
  for (const s of subtasks) (subsByTask.get(s.task_id) ?? subsByTask.set(s.task_id, []).get(s.task_id)).push(s);
  const prsByTask = new Map();
  for (const p of prLinks) (prsByTask.get(p.task_id) ?? prsByTask.set(p.task_id, []).get(p.task_id)).push(p);

  return tasks.map((t) => {
    const subs = subsByTask.get(t.task_id) ?? [];
    const prs = prsByTask.get(t.task_id) ?? [];
    return {
      ...t,
      assigner_name: nameOf.get(t.assigner_id) ?? null,
      assignee_name: t.assignee_id != null ? nameOf.get(t.assignee_id) ?? null : null,
      reviewer_name: t.reviewer_id != null ? nameOf.get(t.reviewer_id) ?? null : null,
      subtasks: subs,
      pr_links: prs,
      subtask_done: subs.filter((s) => s.is_done).length,
      subtask_total: subs.length,
      pr_count: prs.length,
    };
  });
}

async function enrichOne(task) {
  const [enriched] = await enrichTasks([task]);
  return enriched;
}

// `member` is optional so existing callers keep working; pass req.member to enforce the
// PR-review gate. Every per-task route funnels through here, so gating once covers
// read, patch, archive, reopen, subtasks, PR links and comments in one place.
async function loadTask(id, res, member) {
  const taskId = Number(id);
  if (!Number.isInteger(taskId)) {
    res.status(400).json({ successful: false, message: 'Invalid task id' });
    return null;
  }
  const task = await prisma.board_task.findUnique({ where: { task_id: taskId } });
  if (!task) {
    res.status(404).json({ successful: false, message: 'Task not found' });
    return null;
  }
  // PR-review tasks belong to the super-admin-only dashboard. 404 rather than 403 so a
  // non-super-admin cannot probe for which task ids exist.
  if (isHiddenPrReviewTask(task, member)) {
    res.status(404).json({ successful: false, message: 'Task not found' });
    return null;
  }
  return task;
}

// Assignee or any supervisor may edit a task's subtasks / PR links.
function canWorkOn(member, task) {
  return member.can_assign || (task.assignee_id != null && task.assignee_id === member.member_id);
}

// Validate an assignee/reviewer id references an approved member.
async function assertApprovedMember(id) {
  if (id == null) return true;
  const m = await prisma.board_member.findUnique({ where: { member_id: id }, select: { status: true } });
  return m?.status === 'approved';
}

// ---- validation -----------------------------------------------------------

const isoDate = z.string().datetime().optional().nullable();
const docLinks = z.array(z.string().url().max(500)).max(20).optional().nullable();

const createSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(20000).default(''),
  assignee_id: z.number().int().positive().optional().nullable(),
  reviewer_id: z.number().int().positive().optional().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  vertical: z.string().max(80).optional().nullable(),
  deadline: isoDate,
  doc_links: docLinks,
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(20000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  vertical: z.string().max(80).optional().nullable(),
  deadline: isoDate,
  doc_links: docLinks,
  assignee_id: z.number().int().positive().optional().nullable(),
  reviewer_id: z.number().int().positive().optional().nullable(),
  status: z.enum(['backlog', 'in_progress', 'ready_for_review', 'changes_requested', 'approved', 'on_staging', 'done', 'archived']).optional(),
  review_notes: z.string().max(20000).optional(),
});

const META_FIELDS = ['title', 'description', 'priority', 'vertical', 'deadline', 'doc_links', 'assignee_id', 'reviewer_id'];

// ---- routes ---------------------------------------------------------------

// GET /board/tasks  (?status= &assignee= &vertical= &include_archived=)
router.get('/', async (req, res) => {
  try {
    const where = {};
    const { status, assignee, vertical, include_archived } = req.query;
    if (status) where.status = String(status);
    if (assignee) where.assignee_id = Number(assignee) || -1;
    if (vertical) where.vertical = String(vertical);
    if (!status && include_archived !== 'true') where.status = { not: 'archived' };
    // PR-review rounds live on this board as tasks so they inherit the status flow,
    // audit trail and GitHub webhook — but that dashboard is super-admin only, so their
    // titles must not surface here for anyone else. See hidePrReviewWhere for why the
    // filter needs an explicit null branch.
    Object.assign(where, hidePrReviewWhere(req.member));

    const tasks = await prisma.board_task.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { created_at: 'desc' }],
    });
    return res.status(200).json({ successful: true, tasks: await enrichTasks(tasks) });
  } catch (err) {
    console.error('[board] list error:', err);
    return res.status(500).json({ successful: false, message: 'Could not load tasks' });
  }
});

// GET /board/tasks/members — approved members for assignment dropdowns.
router.get('/members', async (_req, res) => {
  try {
    const members = await prisma.board_member.findMany({
      where: { status: 'approved' },
      select: { member_id: true, name: true, email: true, can_assign: true, can_review: true },
      orderBy: { name: 'asc' },
    });
    return res.status(200).json({ successful: true, members });
  } catch (err) {
    console.error('[board] members error:', err);
    return res.status(500).json({ successful: false, message: 'Could not load members' });
  }
});

// POST /board/tasks  (requireAssign)
router.post('/', requireAssign, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  const d = parsed.data;
  try {
    if (!(await assertApprovedMember(d.assignee_id))) {
      return res.status(400).json({ successful: false, message: 'Assignee must be an approved member' });
    }
    if (!(await assertApprovedMember(d.reviewer_id))) {
      return res.status(400).json({ successful: false, message: 'Reviewer must be an approved member' });
    }

    const task = await prisma.board_task.create({
      data: {
        title: d.title,
        description: d.description ?? '',
        assigner_id: req.member.member_id,
        assignee_id: d.assignee_id ?? null,
        reviewer_id: d.reviewer_id ?? null,
        priority: d.priority ?? 'medium',
        vertical: d.vertical ?? null,
        deadline: d.deadline ? new Date(d.deadline) : null,
        doc_links: d.doc_links ?? undefined,
        status: 'backlog',
      },
    });

    logActivity(task.task_id, req.member.member_id, `created task "${task.title}"`);
    if (task.assignee_id) {
      await notify(task.assignee_id, 'assigned', `You were assigned "${task.title}".`, task.task_id);
    }
    return res.status(201).json({ successful: true, task: await enrichOne(task) });
  } catch (err) {
    console.error('[board] create error:', err);
    return res.status(500).json({ successful: false, message: 'Could not create task' });
  }
});

// POST /board/tasks/backfill  (requireAssign) — bulk-import existing/in-flight work onto
// the board (M6). Unlike POST /, this records a task DIRECTLY in a given column (it's
// recording reality, not driving the workflow), and stays silent (no assignment pings) so
// importing a backlog doesn't spam everyone. ready_at is stamped for ready_for_review rows.
const BACKFILL_STATUSES = ['backlog', 'in_progress', 'ready_for_review', 'approved', 'on_staging', 'done'];
const backfillItemSchema = z.object({
  title: z.string().trim().min(1).max(255),
  assignee_id: z.number().int().positive().optional().nullable(),
  reviewer_id: z.number().int().positive().optional().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  status: z.enum(BACKFILL_STATUSES).optional(),
  vertical: z.string().max(80).optional().nullable(),
});
const backfillSchema = z.object({ tasks: z.array(backfillItemSchema).min(1).max(50) });

router.post('/backfill', requireAssign, async (req, res) => {
  const parsed = backfillSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  try {
    // Validate all referenced members up front.
    const memberIds = [
      ...new Set(parsed.data.tasks.flatMap((t) => [t.assignee_id, t.reviewer_id]).filter((x) => x != null)),
    ];
    for (const id of memberIds) {
      if (!(await assertApprovedMember(id))) {
        return res.status(400).json({ successful: false, message: `Member ${id} is not an approved board member` });
      }
    }

    const created = [];
    for (const t of parsed.data.tasks) {
      const status = t.status ?? 'in_progress';
      const task = await prisma.board_task.create({
        data: {
          title: t.title,
          description: '',
          assigner_id: req.member.member_id,
          assignee_id: t.assignee_id ?? null,
          reviewer_id: t.reviewer_id ?? null,
          priority: t.priority ?? 'medium',
          vertical: t.vertical ?? null,
          status,
          ready_at: status === 'ready_for_review' ? new Date() : null,
        },
      });
      logActivity(task.task_id, req.member.member_id, `backfilled (${status})`);
      created.push(task);
    }
    return res.status(201).json({ successful: true, count: created.length, tasks: await enrichTasks(created) });
  } catch (err) {
    console.error('[board] backfill error:', err);
    return res.status(500).json({ successful: false, message: 'Could not backfill tasks' });
  }
});

// PATCH /board/tasks/:id — field edits (requireAssign) and/or a status transition.
router.patch('/:id', async (req, res) => {
  const task = await loadTask(req.params.id, res, req.member);
  if (!task) return;

  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  const body = parsed.data;
  const data = {};
  const notifications = [];
  const activities = [];

  // --- metadata edits: supervisor (can_assign) only ---
  const editsMeta = META_FIELDS.some((f) => f in body);
  if (editsMeta) {
    if (!req.member.can_assign) {
      return res.status(403).json({ successful: false, message: 'Only a supervisor can edit task details.' });
    }
    if ('assignee_id' in body && !(await assertApprovedMember(body.assignee_id))) {
      return res.status(400).json({ successful: false, message: 'Assignee must be an approved member' });
    }
    if ('reviewer_id' in body && !(await assertApprovedMember(body.reviewer_id))) {
      return res.status(400).json({ successful: false, message: 'Reviewer must be an approved member' });
    }
    for (const f of ['title', 'description', 'priority', 'vertical']) {
      if (f in body) data[f] = body[f];
    }
    if ('deadline' in body) data.deadline = body.deadline ? new Date(body.deadline) : null;
    if ('doc_links' in body) data.doc_links = body.doc_links ?? undefined;
    if ('reviewer_id' in body) data.reviewer_id = body.reviewer_id ?? null;
    if ('assignee_id' in body && body.assignee_id !== task.assignee_id) {
      data.assignee_id = body.assignee_id ?? null;
      if (body.assignee_id) {
        notifications.push({ member_id: body.assignee_id, type: 'assigned', body: `You were assigned "${task.title}".` });
      }
      activities.push('reassigned task');
    }
  }

  // --- status transition: role + transition enforced ---
  if (body.status && body.status !== task.status) {
    const prCount = await prisma.board_pr_link.count({ where: { task_id: task.task_id } });
    const verdict = evaluateTransition(req.member, { ...task, _prLinkCount: prCount }, body.status, body);
    if (!verdict.ok) {
      return res.status(verdict.status).json({ successful: false, message: verdict.message });
    }
    data.status = body.status;
    Object.assign(data, verdict.sideEffects);
    if (verdict.notify) notifications.push(verdict.notify);
    activities.push(`moved ${task.status} → ${body.status}`);
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ successful: false, message: 'Nothing to update' });
  }

  try {
    const updated = await prisma.board_task.update({ where: { task_id: task.task_id }, data });
    for (const a of activities) logActivity(task.task_id, req.member.member_id, a);
    for (const n of notifications) await notify(n.member_id, n.type, n.body, task.task_id);
    return res.status(200).json({ successful: true, task: await enrichOne(updated) });
  } catch (err) {
    console.error('[board] update error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update task' });
  }
});

// POST /board/tasks/:id/reopen — create a follow-up task linked to the original.
router.post('/:id/reopen', requireAssign, async (req, res) => {
  const task = await loadTask(req.params.id, res, req.member);
  if (!task) return;
  const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : `Follow-up: ${task.title}`;
  try {
    const followUp = await prisma.board_task.create({
      data: {
        title: title.slice(0, 255),
        description: req.body?.description ?? `Follow-up to task #${task.task_id}.`,
        assigner_id: req.member.member_id,
        assignee_id: task.assignee_id ?? null,
        reviewer_id: task.reviewer_id ?? null,
        priority: task.priority,
        vertical: task.vertical,
        source_type: task.source_type ?? null,
        source_id: task.source_id ?? null,
        reopened_from: task.task_id,
        status: 'backlog',
      },
    });
    logActivity(task.task_id, req.member.member_id, `reopened as follow-up task #${followUp.task_id}`);
    if (followUp.assignee_id) await notify(followUp.assignee_id, 'assigned', `You were assigned "${followUp.title}".`, followUp.task_id);
    return res.status(201).json({ successful: true, task: await enrichOne(followUp) });
  } catch (err) {
    console.error('[board] reopen error:', err);
    return res.status(500).json({ successful: false, message: 'Could not reopen task' });
  }
});

// POST /board/tasks/from-bug/:bugId  (requireAssign)
// Create a task from a bug report, prefilled + linked back. The board then owns execution
// status; the bug is moved to in_progress and resolves automatically when the task ships
// (see board-webhook-routes.js). See task-board-implementation-plan.md (M5 / C2).
const SEVERITY_TO_PRIORITY = { critical: 'urgent', high: 'high', medium: 'medium', low: 'low' };

router.post('/from-bug/:bugId', requireAssign, async (req, res) => {
  const bugId = Number(req.params.bugId);
  if (!Number.isInteger(bugId)) {
    return res.status(400).json({ successful: false, message: 'Invalid bug id' });
  }
  try {
    const bug = await prisma.bug_report.findUnique({ where: { bug_report_id: bugId } });
    if (!bug) return res.status(404).json({ successful: false, message: 'Bug report not found' });

    // Don't create a second task for the same bug.
    const existing = await prisma.board_task.findFirst({
      where: { source_type: 'bug_report', source_id: bugId, status: { not: 'archived' } },
    });
    if (existing) {
      return res.status(409).json({ successful: false, message: 'A task already exists for this bug', task_id: existing.task_id });
    }

    const descParts = [bug.description];
    if (bug.page_url) descParts.push(`\nReported on: ${bug.page_url}`);
    descParts.push(`\n— from bug report #${bugId}`);

    const assigneeId = Number.isInteger(req.body?.assignee_id) ? req.body.assignee_id : null;
    if (assigneeId && !(await assertApprovedMember(assigneeId))) {
      return res.status(400).json({ successful: false, message: 'Assignee must be an approved member' });
    }

    const task = await prisma.board_task.create({
      data: {
        title: `[Bug] ${bug.title}`.slice(0, 255),
        description: descParts.join('\n'),
        assigner_id: req.member.member_id,
        assignee_id: assigneeId,
        priority: SEVERITY_TO_PRIORITY[bug.severity] || 'medium',
        source_type: 'bug_report',
        source_id: bugId,
        status: 'backlog',
      },
    });

    // The board now tracks this bug; reflect that on the bug unless it's already closed out.
    if (['open'].includes(bug.status)) {
      await prisma.bug_report
        .update({ where: { bug_report_id: bugId }, data: { status: 'in_progress' } })
        .catch((e) => console.warn('[board] bug status sync failed:', e.message));
    }

    logActivity(task.task_id, req.member.member_id, `created from bug report #${bugId}`);
    if (task.assignee_id) await notify(task.assignee_id, 'assigned', `You were assigned "${task.title}".`, task.task_id);
    return res.status(201).json({ successful: true, task: await enrichOne(task) });
  } catch (err) {
    console.error('[board] from-bug error:', err);
    return res.status(500).json({ successful: false, message: 'Could not create task from bug' });
  }
});

// PATCH /board/tasks/:id/archive  (requireAssign)
router.patch('/:id/archive', requireAssign, async (req, res) => {
  const task = await loadTask(req.params.id, res, req.member);
  if (!task) return;
  try {
    const updated = await prisma.board_task.update({
      where: { task_id: task.task_id },
      data: { status: 'archived', archived_at: new Date() },
    });
    logActivity(task.task_id, req.member.member_id, 'archived task');
    return res.status(200).json({ successful: true, task: await enrichOne(updated) });
  } catch (err) {
    console.error('[board] archive error:', err);
    return res.status(500).json({ successful: false, message: 'Could not archive task' });
  }
});

// ---- subtasks -------------------------------------------------------------

const subtaskCreateSchema = z.object({ label: z.string().trim().min(1).max(255), pr_link: z.string().url().max(500).optional().nullable() });

router.post('/:id/subtasks', async (req, res) => {
  const task = await loadTask(req.params.id, res, req.member);
  if (!task) return;
  if (!canWorkOn(req.member, task)) {
    return res.status(403).json({ successful: false, message: 'Only the assignee or a supervisor can edit subtasks.' });
  }
  const parsed = subtaskCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    const max = await prisma.board_subtask.aggregate({ where: { task_id: task.task_id }, _max: { position: true } });
    const subtask = await prisma.board_subtask.create({
      data: { task_id: task.task_id, label: parsed.data.label, pr_link: parsed.data.pr_link ?? null, position: (max._max.position ?? -1) + 1 },
    });
    return res.status(201).json({ successful: true, subtask });
  } catch (err) {
    console.error('[board] subtask create error:', err);
    return res.status(500).json({ successful: false, message: 'Could not add subtask' });
  }
});

const subtaskUpdateSchema = z.object({
  label: z.string().trim().min(1).max(255).optional(),
  is_done: z.boolean().optional(),
  pr_link: z.string().url().max(500).optional().nullable(),
  position: z.number().int().min(0).optional(),
});

router.patch('/subtasks/:sid', async (req, res) => {
  const sid = Number(req.params.sid);
  if (!Number.isInteger(sid)) return res.status(400).json({ successful: false, message: 'Invalid subtask id' });
  const parsed = subtaskUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ successful: false, message: 'Invalid input' });
  try {
    const subtask = await prisma.board_subtask.findUnique({ where: { subtask_id: sid } });
    if (!subtask) return res.status(404).json({ successful: false, message: 'Subtask not found' });
    const task = await prisma.board_task.findUnique({ where: { task_id: subtask.task_id } });
    if (!canWorkOn(req.member, task)) {
      return res.status(403).json({ successful: false, message: 'Only the assignee or a supervisor can edit subtasks.' });
    }
    const data = {};
    for (const f of ['label', 'is_done', 'position']) if (f in parsed.data) data[f] = parsed.data[f];
    if ('pr_link' in parsed.data) data.pr_link = parsed.data.pr_link ?? null;
    const updated = await prisma.board_subtask.update({ where: { subtask_id: sid }, data });
    return res.status(200).json({ successful: true, subtask: updated });
  } catch (err) {
    console.error('[board] subtask update error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update subtask' });
  }
});

router.delete('/subtasks/:sid', async (req, res) => {
  const sid = Number(req.params.sid);
  if (!Number.isInteger(sid)) return res.status(400).json({ successful: false, message: 'Invalid subtask id' });
  try {
    const subtask = await prisma.board_subtask.findUnique({ where: { subtask_id: sid } });
    if (!subtask) return res.status(404).json({ successful: false, message: 'Subtask not found' });
    const task = await prisma.board_task.findUnique({ where: { task_id: subtask.task_id } });
    if (!canWorkOn(req.member, task)) {
      return res.status(403).json({ successful: false, message: 'Only the assignee or a supervisor can edit subtasks.' });
    }
    await prisma.board_subtask.delete({ where: { subtask_id: sid } });
    return res.status(200).json({ successful: true });
  } catch (err) {
    console.error('[board] subtask delete error:', err);
    return res.status(500).json({ successful: false, message: 'Could not delete subtask' });
  }
});

// ---- PR links -------------------------------------------------------------

const prLinkSchema = z.object({ url: z.string().url().max(500), repo: z.string().max(120).optional().nullable() });

router.post('/:id/pr-links', async (req, res) => {
  const task = await loadTask(req.params.id, res, req.member);
  if (!task) return;
  if (!canWorkOn(req.member, task)) {
    return res.status(403).json({ successful: false, message: 'Only the assignee or a supervisor can edit PR links.' });
  }
  const parsed = prLinkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    const prLink = await prisma.board_pr_link.create({
      data: { task_id: task.task_id, url: parsed.data.url, repo: parsed.data.repo ?? null },
    });
    return res.status(201).json({ successful: true, pr_link: prLink });
  } catch (err) {
    console.error('[board] pr-link create error:', err);
    return res.status(500).json({ successful: false, message: 'Could not add PR link' });
  }
});

router.delete('/pr-links/:plid', async (req, res) => {
  const plid = Number(req.params.plid);
  if (!Number.isInteger(plid)) return res.status(400).json({ successful: false, message: 'Invalid PR link id' });
  try {
    const prLink = await prisma.board_pr_link.findUnique({ where: { pr_link_id: plid } });
    if (!prLink) return res.status(404).json({ successful: false, message: 'PR link not found' });
    const task = await prisma.board_task.findUnique({ where: { task_id: prLink.task_id } });
    if (!canWorkOn(req.member, task)) {
      return res.status(403).json({ successful: false, message: 'Only the assignee or a supervisor can edit PR links.' });
    }
    await prisma.board_pr_link.delete({ where: { pr_link_id: plid } });
    return res.status(200).json({ successful: true });
  } catch (err) {
    console.error('[board] pr-link delete error:', err);
    return res.status(500).json({ successful: false, message: 'Could not delete PR link' });
  }
});

// ---- comments (M4) --------------------------------------------------------

// GET /board/tasks/:id/comments — thread for a task, with author display names.
router.get('/:id/comments', async (req, res) => {
  const task = await loadTask(req.params.id, res, req.member);
  if (!task) return;
  try {
    const comments = await prisma.board_comment.findMany({
      where: { task_id: task.task_id },
      orderBy: { created_at: 'asc' },
    });
    const authorIds = [...new Set(comments.map((c) => c.author_id))];
    const authors = authorIds.length
      ? await prisma.board_member.findMany({ where: { member_id: { in: authorIds } }, select: { member_id: true, name: true } })
      : [];
    const nameOf = new Map(authors.map((a) => [a.member_id, a.name]));
    return res.status(200).json({
      successful: true,
      comments: comments.map((c) => ({ ...c, author_name: nameOf.get(c.author_id) ?? null })),
    });
  } catch (err) {
    console.error('[board] comments list error:', err);
    return res.status(500).json({ successful: false, message: 'Could not load comments' });
  }
});

const commentSchema = z.object({ body: z.string().trim().min(1, 'Comment cannot be empty').max(5000) });

// POST /board/tasks/:id/comments — any board member on the task may comment; the other
// stakeholders (assignee / reviewer / assigner, minus the author) get a 'comment' ping.
router.post('/:id/comments', async (req, res) => {
  const task = await loadTask(req.params.id, res, req.member);
  if (!task) return;
  const parsed = commentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  }
  try {
    const comment = await prisma.board_comment.create({
      data: { task_id: task.task_id, author_id: req.member.member_id, body: parsed.data.body },
    });

    // Ping the other people on the card (deduped, never the author).
    const recipients = [...new Set([task.assignee_id, task.reviewer_id, task.assigner_id])]
      .filter((id) => id != null && id !== req.member.member_id);
    for (const memberId of recipients) {
      await notify(memberId, 'comment', `${req.member.name} commented on "${task.title}".`, task.task_id);
    }
    logActivity(task.task_id, req.member.member_id, 'commented');

    return res.status(201).json({ successful: true, comment: { ...comment, author_name: req.member.name } });
  } catch (err) {
    console.error('[board] comment create error:', err);
    return res.status(500).json({ successful: false, message: 'Could not add comment' });
  }
});

export default router;
