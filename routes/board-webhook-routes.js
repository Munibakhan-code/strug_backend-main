// routes/board-webhook-routes.js
//
// GitHub webhook for the Task Board (M5). Closes the loop from PR merges to board state
// WITHOUT a human moving the card:
//   • PR merged into the staging branch (main): mark the task's matching board_pr_link
//     merged; once ALL of a task's PR links are merged, move the task → on_staging.
//   • PR merged into the prod branch (release): the promotion PR references TASK-<id>s
//     (and/or links PR urls) → move those tasks → done, and resolve any linked bug_report.
//
// Signature is verified over the RAW request bytes (X-Hub-Signature-256), so this router
// must be mounted with express.raw() BEFORE the global express.json() in index.js.
//
// Env:
//   GITHUB_WEBHOOK_SECRET   shared secret configured on the GitHub webhook/App (required)
//   BOARD_STAGING_BRANCH    branch whose merges mean "on staging" (default: main)
//   BOARD_PROD_BRANCH       branch whose merges mean "done in prod" (default: release)

import express from 'express';
import crypto from 'crypto';
import prisma from '../utils/prisma-client.js';

const router = express.Router();

const STAGING_BRANCH = process.env.BOARD_STAGING_BRANCH || 'main';
const PROD_BRANCH = process.env.BOARD_PROD_BRANCH || 'release';

function verifySignature(req) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return { ok: false, code: 503, message: 'Webhook secret not configured' };
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || typeof sig !== 'string') return { ok: false, code: 401, message: 'Missing signature' };
  // req.body is a Buffer (express.raw). HMAC over the exact bytes GitHub signed.
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, code: 401, message: 'Invalid signature' };
  }
  return { ok: true };
}

// Parse TASK-<id> references out of a PR's title + body.
function parseTaskRefs(text) {
  const ids = new Set();
  const re = /TASK-(\d+)/gi;
  let m;
  while ((m = re.exec(text || '')) !== null) ids.add(Number(m[1]));
  return [...ids];
}

function logActivity(taskId, action) {
  prisma.board_activity
    .create({ data: { task_id: taskId, actor_id: null, action } })
    .catch((e) => console.warn('[board-webhook] activity log failed:', e.message));
}

async function notify(memberId, type, body, taskId) {
  if (!memberId) return;
  await prisma.board_notification
    .create({ data: { member_id: memberId, task_id: taskId, type, body } })
    .catch((e) => console.warn('[board-webhook] notification failed:', e.message));
}

// A PR merged into the staging branch: mark its linked PRs merged, and advance any task
// whose PR links are now ALL merged to on_staging.
async function handleStagingMerge(prUrl, taskRefs) {
  // Mark every board_pr_link pointing at this PR url as merged.
  const links = await prisma.board_pr_link.findMany({ where: { url: prUrl } });
  if (links.length) {
    await prisma.board_pr_link.updateMany({ where: { url: prUrl }, data: { merged: true, merged_at: new Date() } });
  }

  // Tasks to re-evaluate: those owning a link to this PR, plus any TASK-<id> referenced.
  const taskIds = [...new Set([...links.map((l) => l.task_id), ...taskRefs])];
  const moved = [];
  for (const taskId of taskIds) {
    const task = await prisma.board_task.findUnique({ where: { task_id: taskId } });
    if (!task) continue;
    if (['done', 'archived', 'on_staging'].includes(task.status)) continue;

    const taskLinks = await prisma.board_pr_link.findMany({ where: { task_id: taskId } });
    // Advance only when there's at least one PR link and all of them are merged.
    const allMerged = taskLinks.length > 0 && taskLinks.every((l) => l.merged);
    if (!allMerged) continue;

    await prisma.board_task.update({ where: { task_id: taskId }, data: { status: 'on_staging' } });
    logActivity(taskId, 'moved to on_staging (all PRs merged to ' + STAGING_BRANCH + ')');
    await notify(task.assignee_id, 'on_staging', `"${task.title}" is on staging.`, taskId);
    moved.push(taskId);
  }
  return { markedLinks: links.length, movedToStaging: moved };
}

// A PR merged into the prod branch: referenced tasks are now live → done; resolve bugs.
async function handleProdMerge(prUrl, taskRefs) {
  const links = await prisma.board_pr_link.findMany({ where: { url: prUrl } });
  if (links.length) {
    await prisma.board_pr_link.updateMany({ where: { url: prUrl }, data: { merged: true, merged_at: new Date() } });
  }
  const taskIds = [...new Set([...links.map((l) => l.task_id), ...taskRefs])];
  const done = [];
  const resolvedBugs = [];
  for (const taskId of taskIds) {
    const task = await prisma.board_task.findUnique({ where: { task_id: taskId } });
    if (!task || ['done', 'archived'].includes(task.status)) continue;

    await prisma.board_task.update({ where: { task_id: taskId }, data: { status: 'done' } });
    logActivity(taskId, 'moved to done (promoted to ' + PROD_BRANCH + ')');
    await notify(task.assignee_id, 'done', `"${task.title}" shipped to production.`, taskId);
    done.push(taskId);

    // Mirror status onto a linked bug report.
    if (task.source_type === 'bug_report' && task.source_id) {
      await prisma.bug_report
        .update({ where: { bug_report_id: task.source_id }, data: { status: 'resolved' } })
        .then(() => resolvedBugs.push(task.source_id))
        .catch((e) => console.warn('[board-webhook] bug resolve failed:', e.message));
    }
  }
  return { movedToDone: done, resolvedBugs };
}

// POST /board/webhook/github  (router is mounted at that path; the handler is at '/')
router.post('/', async (req, res) => {
  const v = verifySignature(req);
  if (!v.ok) return res.status(v.code).json({ successful: false, message: v.message });

  const eventType = req.headers['x-github-event'];
  if (eventType === 'ping') return res.status(200).json({ successful: true, message: 'pong' });
  if (eventType !== 'pull_request') return res.status(200).json({ successful: true, ignored: eventType });

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ successful: false, message: 'Invalid JSON payload' });
  }

  const pr = event.pull_request;
  if (event.action !== 'closed' || !pr?.merged) {
    return res.status(200).json({ successful: true, ignored: 'not a merged PR' });
  }

  const baseRef = pr.base?.ref;
  const prUrl = pr.html_url;
  const taskRefs = parseTaskRefs(`${pr.title || ''}\n${pr.body || ''}`);

  try {
    if (baseRef === PROD_BRANCH) {
      const result = await handleProdMerge(prUrl, taskRefs);
      return res.status(200).json({ successful: true, target: 'prod', ...result });
    }
    if (baseRef === STAGING_BRANCH) {
      const result = await handleStagingMerge(prUrl, taskRefs);
      return res.status(200).json({ successful: true, target: 'staging', ...result });
    }
    // Merge into some other branch (feature→feature etc.): nothing to do.
    return res.status(200).json({ successful: true, ignored: `merge into ${baseRef}` });
  } catch (err) {
    console.error('[board-webhook] handler error:', err);
    return res.status(500).json({ successful: false, message: 'Webhook handler error' });
  }
});

export default router;
