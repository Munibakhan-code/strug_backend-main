import express from 'express';
import multer from 'multer';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import { rateLimit } from '../middleware/rate-limit.js';
import mailerEvents from '../utils/mailer-event.js';
import { decrypt } from '../utils/crypto.js';
import { selectBestAd } from '../utils/ads-delivery-engine.js';
import { storeImageBuffer, sniffImageType, buildObjectName } from '../utils/image-upload.js';
import notify from '../services/notify.js';
import { recordActivity } from '../services/activity-log.js';
import {
  buildPublicJobWhere,
  normalizeJobSavedSearchFrequency,
  stripPagingFromSeekerFilters,
} from '../utils/job-filters.js';
import { runJobSavedSearchAlerts } from '../utils/job-saved-search-cron.js';
import {
  buildRecommendSignals,
  hasRecommendSignals,
  rankRecommendedJobs,
} from '../utils/job-recommend.js';
import {
  JOB_LISTING_STATUSES,
  JOB_MODERATION_ACTIONS,
  JOB_REPORT_STATUSES,
  findBlockedJobContent,
  isModerationStatus,
  normalizeJobReportReason,
} from '../utils/job-moderation.js';
import { checkRiderAnalyticsGuard } from '../utils/rider-analytics-guard.js';

const router = express.Router();

// Pipeline the employer can move an application through.
const APPLICATION_STATUSES = ['applied', 'reviewed', 'shortlisted', 'rejected', 'hired'];
const PIPELINE_ACTIONS = APPLICATION_STATUSES.filter((s) => s !== 'applied');
const JOB_STATUSES = JOB_LISTING_STATUSES;
const jobPostLimiter = rateLimit({ windowSec: 3600, max: 10, keyPrefix: 'job-post' });
const jobApplyLimiter = rateLimit({ windowSec: 3600, max: 30, keyPrefix: 'job-apply' });
const jobReportLimiter = rateLimit({ windowSec: 3600, max: 15, keyPrefix: 'job-report' });
const EMPLOYER_NOTE_MAX = 4000;
const INTERVIEW_NOTE_MAX = 2000;
const BULK_STATUS_MAX = 50;

/** Seeker funnel: view → apply (status changes are logged on the status route). */
const JOB_ANALYTICS_EVENTS = new Set(['job_viewed', 'job_applied']);

function safeJobAnalyticsMetadata(body) {
  const metadata = {};
  const rawJobId = body?.job_id;
  const jobId = typeof rawJobId === 'string' && /^\d+$/.test(rawJobId)
    ? Number(rawJobId)
    : rawJobId;
  if (Number.isSafeInteger(jobId) && jobId > 0) metadata.job_id = jobId;
  const rawAppId = body?.job_application_id;
  const appId = typeof rawAppId === 'string' && /^\d+$/.test(rawAppId)
    ? Number(rawAppId)
    : rawAppId;
  if (Number.isSafeInteger(appId) && appId > 0) metadata.job_application_id = appId;
  return metadata;
}

function asBool(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  return Boolean(v);
}

// ---- helpers -------------------------------------------------------------

/** The agents row (employer profile) owned by this user, or null. */
async function myAgent(userId) {
  return prisma.agents.findFirst({ where: { agent_user_id: Number(userId) } });
}

async function logApplicationEvent({
  job_application_id,
  from_status = null,
  to_status = null,
  event_type = 'status',
  note = null,
  actor_user_id = null,
}) {
  return prisma.job_application_event.create({
    data: {
      job_application_id: Number(job_application_id),
      from_status,
      to_status,
      event_type,
      note,
      actor_user_id: actor_user_id != null ? Number(actor_user_id) : null,
    },
  });
}

/** Load application + ensure caller owns the hiring agent profile. */
async function loadOwnedApplication(applicationId, userId) {
  const application = await prisma.job_application.findUnique({
    where: { job_application_id: Number(applicationId) },
    include: {
      jobs: { include: { agents: true } },
      candidate: { include: { user: { select: { user_id: true, name: true, email: true, language: true } } } },
    },
  });
  if (!application) return { ok: false, code: 404, error: 'Job application not found', application: null };
  if (application.jobs?.agents?.agent_user_id !== Number(userId)) {
    return { ok: false, code: 403, error: 'Only the hiring employer can update this application', application };
  }
  return { ok: true, code: 200, error: null, application };
}

async function notifySeekerStatus(io, application, status) {
  const seekerUser = application.candidate?.user;
  const jobName = application.jobs?.job_name || 'a job';
  if (!seekerUser?.user_id) return;
  try {
    await notify(io, {
      userId: seekerUser.user_id,
      vertical: 'jobs',
      type: 'job.application.status',
      title: `Application update: ${status}`,
      body: `Your application for ${jobName} is now "${status}".`,
      entityType: 'job_application',
      entityId: application.job_application_id,
      actionUrl: 'jobs',
    });
  } catch (e) {
    console.error('Seeker notify failed:', e.message);
  }
  try {
    recordActivity(seekerUser.user_id, 'jobs.application_status_changed', {
      metadata: {
        job_application_id: application.job_application_id,
        job_id: application.job_id,
        status,
      },
    });
  } catch { /* never block status path */ }
  if (seekerUser.email) {
    try {
      mailerEvents.emit('send_email', {
        templateName: 'job-application-status',
        variables: {
          candidate_name: seekerUser.name || 'there',
          job_title: jobName,
          status,
          status_label: status.charAt(0).toUpperCase() + status.slice(1),
          is_rejected: status === 'rejected',
          is_hired: status === 'hired',
        },
        to: decrypt(seekerUser.email),
        subjectKey: 'emails.job_status.subject',
        user: seekerUser,
      });
    } catch (mailErr) {
      console.error('Seeker status email failed:', mailErr.message);
    }
  }
}

/** The candidate row (seeker profile) owned by this user. Optionally create on first use. */
async function myCandidate(userId, { create = false } = {}) {
  const existing = await prisma.candidate.findFirst({ where: { candidate_user_id: Number(userId) } });
  if (existing || !create) return existing;
  return prisma.candidate.create({ data: { candidate_user_id: Number(userId) } });
}

/** True if the user owns the agents row that posted the given job. */
async function ownsJob(userId, jobId) {
  const job = await prisma.jobs.findUnique({
    where: { job_id: Number(jobId) },
    include: { agents: true },
  });
  if (!job) return { ok: false, code: 404, job: null };
  if (!job.agents || job.agents.agent_user_id !== Number(userId)) {
    return { ok: false, code: 403, job };
  }
  return { ok: true, code: 200, job };
}

const JOB_INCLUDE = {
  job_categories: true,
  agents: { include: { user: true } },
};

// ---- résumé upload (PDF or image) ---------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
});

// %PDF magic bytes; falls back to image sniffing (scanned résumés).
function sniffDocType(buf) {
  if (!buf || buf.length < 5) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  return sniffImageType(buf);
}

/* UPLOAD RÉSUMÉ — returns { url } for use as candidate.resume_url / application.cv_url */
router.post('/resume', authenticateToken, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? 'Résumé exceeds the 8 MB limit.'
        : 'Résumé upload failed.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });

    const contentType = sniffDocType(req.file.buffer);
    if (!contentType) {
      return res.status(400).json({ error: 'Unsupported file. Upload a PDF or image résumé.' });
    }
    try {
      const objectName = buildObjectName(req.file.originalname);
      const url = await storeImageBuffer({
        container: 'resumes',
        dirName: 'resumes',
        objectName,
        buffer: req.file.buffer,
        contentType,
      });
      res.status(201).json({ url });
    } catch (e) {
      console.error('Résumé store failed:', e.message);
      res.status(500).json({ error: 'Failed to store résumé.' });
    }
  });
});

//======================================================================================================
//========================================== JOB APPLICATIONS ==========================================
//======================================================================================================

/* SEEKER — my own applications */
router.get('/applications/mine', authenticateToken, async (req, res) => {
  try {
    const cand = await myCandidate(req.user.user_id);
    if (!cand) return res.json([]);
    const applications = await prisma.job_application.findMany({
      where: { candidate_id: cand.candidate_id },
      orderBy: { job_application_id: 'desc' },
      take: Math.min(Math.max(Number(req.query.limit) || 50, 1), 100),
      include: { jobs: { include: JOB_INCLUDE } },
    });
    res.json(applications);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your applications' });
  }
});

/* SCOPED LIST — employer sees applicants to their jobs; seeker sees their own.
   (Replaces the previous unauthenticated endpoint that leaked all candidate PII.) */
router.get('/applications', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const [agent, cand] = await Promise.all([myAgent(userId), myCandidate(userId)]);
    const or = [];
    if (agent) or.push({ jobs: { agent_id: agent.agent_id } });
    if (cand) or.push({ candidate_id: cand.candidate_id });
    if (or.length === 0) return res.json([]);

    const applications = await prisma.job_application.findMany({
      where: { OR: or },
      orderBy: { job_application_id: 'desc' },
      take: Math.min(Math.max(Number(req.query.limit) || 50, 1), 100),
      include: {
        jobs: { include: JOB_INCLUDE },
        candidate: { include: { user: true } },
      },
    });
    res.json(applications);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch job applications' });
  }
});

/* SINGLE APPLICATION — only the applicant or the hiring employer may view */
router.get('/applications/:id', authenticateToken, async (req, res) => {
  try {
    const application = await prisma.job_application.findUnique({
      where: { job_application_id: parseInt(req.params.id) },
      include: {
        jobs: { include: JOB_INCLUDE },
        candidate: { include: { user: true } },
      },
    });
    if (!application) return res.status(404).json({ error: 'Job application not found' });

    const userId = Number(req.user.user_id);
    const isApplicant = application.candidate?.candidate_user_id === userId;
    const isEmployer = application.jobs?.agents?.agent_user_id === userId;
    if (!isApplicant && !isEmployer) {
      return res.status(403).json({ error: 'Not authorised to view this application' });
    }
    res.json(application);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch job application' });
  }
});

/* CREATE JOB APPLICATION — seeker applies (notifies the hiring employer) */
router.post('/applications', authenticateToken, jobApplyLimiter, async (req, res) => {
  try {
    const { job_id, cv_url, cover_letter } = req.body;
    if (!job_id) {
      return res.status(400).json({ successful: false, message: 'Job ID is required to apply.' });
    }

    const jobRow = await prisma.jobs.findUnique({ where: { job_id: parseInt(job_id) } });
    if (!jobRow) {
      return res.status(404).json({ successful: false, message: 'Job not found.' });
    }
    if ((jobRow.status || 'open') !== 'open' || isModerationStatus(jobRow.status)) {
      return res.status(409).json({ successful: false, message: 'This job is no longer accepting applications.' });
    }
    if (jobRow.deadline && new Date(jobRow.deadline).getTime() < Date.now()) {
      return res.status(409).json({ successful: false, message: 'The application deadline has passed.' });
    }

    // The applicant is the caller — resolve/create their candidate profile, never trust a body id.
    const cand = await myCandidate(req.user.user_id, { create: true });

    // Guard against duplicate applications to the same job.
    const dup = await prisma.job_application.findFirst({
      where: { job_id: parseInt(job_id), candidate_id: cand.candidate_id },
    });
    if (dup) {
      return res.status(409).json({ successful: false, message: 'You have already applied to this job.' });
    }

    const application = await prisma.job_application.create({
      data: {
        job_id: parseInt(job_id),
        candidate_id: cand.candidate_id,
        cv_url: cv_url || cand.resume_url || null,
        cover_letter: cover_letter || null,
        status: 'applied',
        application_date: new Date(),
        updated_at: new Date(),
      },
      include: {
        jobs: {
          include: {
            agents: { include: { user: { select: { user_id: true, name: true, email: true, language: true } } } },
          },
        },
        candidate: { include: { user: { select: { name: true, email: true, language: true } } } },
      },
    });

    try {
      await logApplicationEvent({
        job_application_id: application.job_application_id,
        from_status: null,
        to_status: 'applied',
        event_type: 'status',
        actor_user_id: req.user.user_id,
      });
    } catch (e) {
      console.error('Application timeline seed failed:', e.message);
    }

    // Ad lead signal — best-effort; ad plumbing must never fail the application.
    // The advertiser is the campaign's wallet owner (ads_campaign has no advertiser_id column).
    const advertiserId = application.jobs?.agents?.user?.user_id;
    if (advertiserId) {
      try {
        const activeAd = await prisma.ads_campaign.findFirst({
          where: { status: 'ACTIVE', ads_wallet: { user_id: advertiserId } },
        });
        if (activeAd) {
          const io = req.app.get('io');
          io?.to(`user-${advertiserId}`).emit(`ads-lead-generated-${advertiserId}`, {
            campaign_id: activeAd.campaign_id,
            lead_type: 'JOB_APPLICATION',
            user_id: req.user.user_id,
            job_title: application.jobs.job_name,
            candidate_name: application.candidate?.user?.name,
          });
        }
      } catch (adErr) {
        console.error('Ad lead emit skipped:', adErr.message);
      }
    }

    // Email the hiring employer.
    const agentUser = application.jobs?.agents?.user;
    if (agentUser?.email) {
      try {
        mailerEvents.emit('send_email', {
          templateName: 'job-application-alert',
          variables: {
            job_title: application.jobs.job_name || 'Job Opportunity',
            candidate_name: application.candidate?.user?.name || 'A new candidate',
            order_id: application.job_application_id,
          },
          to: decrypt(agentUser.email),
          subjectKey: 'emails.job_alert.subject',
          user: agentUser,
        });
      } catch (mailErr) {
        console.error('Employer alert email failed:', mailErr.message);
      }
    }

    // In-app notification to the employer.
    if (advertiserId) {
      try {
        await notify(req.app.get('io'), {
          userId: advertiserId,
          vertical: 'jobs',
          type: 'job.application.received',
          title: 'New job application',
          body: `${application.candidate?.user?.name || 'A candidate'} applied for ${application.jobs.job_name || 'your job'}.`,
          entityType: 'job_application',
          entityId: application.job_application_id,
          actionUrl: 'employer',
        });
      } catch (e) {
        console.error('Employer notify failed:', e.message);
      }
    }

    try {
      recordActivity(req.user.user_id, 'jobs.job_applied', {
        metadata: {
          job_id: application.job_id,
          job_application_id: application.job_application_id,
        },
      });
    } catch { /* never block apply path */ }

    res.status(201).json({
      successful: true,
      message: 'Application submitted successfully! The hiring team has been notified.',
      data: application,
    });
  } catch (err) {
    console.error('Job Application Error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* SEEKER — update own application (cv / cover letter) */
router.put('/applications/:id', authenticateToken, async (req, res) => {
  try {
    const application = await prisma.job_application.findUnique({
      where: { job_application_id: parseInt(req.params.id) },
      include: { candidate: true },
    });
    if (!application) return res.status(404).json({ error: 'Job application not found' });
    if (application.candidate?.candidate_user_id !== Number(req.user.user_id)) {
      return res.status(403).json({ error: 'Not authorised to edit this application' });
    }

    const { cv_url, cover_letter } = req.body;
    const updated = await prisma.job_application.update({
      where: { job_application_id: parseInt(req.params.id) },
      data: {
        cv_url: cv_url ?? application.cv_url,
        cover_letter: cover_letter ?? application.cover_letter,
        updated_at: new Date(),
      },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update job application' });
  }
});

/* EMPLOYER — move an application through the pipeline (notifies the seeker) */
router.patch('/applications/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    if (!APPLICATION_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${APPLICATION_STATUSES.join(', ')}` });
    }
    const owned = await loadOwnedApplication(req.params.id, req.user.user_id);
    if (!owned.ok) return res.status(owned.code).json({ error: owned.error });
    const application = owned.application;
    const fromStatus = application.status || 'applied';

    const updated = await prisma.job_application.update({
      where: { job_application_id: application.job_application_id },
      data: { status, updated_at: new Date() },
    });

    try {
      await logApplicationEvent({
        job_application_id: application.job_application_id,
        from_status: fromStatus,
        to_status: status,
        event_type: 'status',
        actor_user_id: req.user.user_id,
      });
    } catch (e) {
      console.error('Application timeline event failed:', e.message);
    }

    await notifySeekerStatus(req.app.get('io'), application, status);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update application status' });
  }
});

/* EMPLOYER — save private hiring notes on an application */
router.patch('/applications/:id/notes', authenticateToken, async (req, res) => {
  try {
    const raw = req.body?.employer_notes;
    if (raw != null && String(raw).length > EMPLOYER_NOTE_MAX) {
      return res.status(400).json({ error: `Notes must be ${EMPLOYER_NOTE_MAX} characters or fewer.` });
    }
    const owned = await loadOwnedApplication(req.params.id, req.user.user_id);
    if (!owned.ok) return res.status(owned.code).json({ error: owned.error });

    const employer_notes = raw == null || !String(raw).trim() ? null : String(raw).trim();
    const updated = await prisma.job_application.update({
      where: { job_application_id: owned.application.job_application_id },
      data: { employer_notes, updated_at: new Date() },
    });
    try {
      await logApplicationEvent({
        job_application_id: owned.application.job_application_id,
        event_type: 'note',
        note: employer_notes ? 'Employer notes updated' : 'Employer notes cleared',
        actor_user_id: req.user.user_id,
      });
    } catch (e) {
      console.error('Note timeline event failed:', e.message);
    }
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save employer notes' });
  }
});

/* EMPLOYER — schedule interview (datetime + notes) and notify seeker */
router.patch('/applications/:id/interview', authenticateToken, async (req, res) => {
  try {
    const { interview_at, interview_notes } = req.body || {};
    let interviewAt = null;
    if (interview_at) {
      interviewAt = new Date(interview_at);
      if (Number.isNaN(interviewAt.getTime())) {
        return res.status(400).json({ error: 'Interview time is invalid.' });
      }
    }
    if (interview_notes != null && String(interview_notes).length > INTERVIEW_NOTE_MAX) {
      return res.status(400).json({ error: `Interview notes must be ${INTERVIEW_NOTE_MAX} characters or fewer.` });
    }
    const owned = await loadOwnedApplication(req.params.id, req.user.user_id);
    if (!owned.ok) return res.status(owned.code).json({ error: owned.error });

    const notes = interview_notes == null || !String(interview_notes).trim()
      ? null
      : String(interview_notes).trim();
    const updated = await prisma.job_application.update({
      where: { job_application_id: owned.application.job_application_id },
      data: {
        interview_at: interviewAt,
        interview_notes: notes,
        updated_at: new Date(),
      },
    });

    try {
      await logApplicationEvent({
        job_application_id: owned.application.job_application_id,
        event_type: 'interview',
        note: interviewAt
          ? `Interview scheduled for ${interviewAt.toISOString()}`
          : 'Interview cleared',
        actor_user_id: req.user.user_id,
      });
    } catch (e) {
      console.error('Interview timeline event failed:', e.message);
    }

    const seekerUser = owned.application.candidate?.user;
    const jobName = owned.application.jobs?.job_name || 'a job';
    if (seekerUser?.user_id && interviewAt) {
      try {
        await notify(req.app.get('io'), {
          userId: seekerUser.user_id,
          vertical: 'jobs',
          type: 'job.application.interview',
          title: `Interview scheduled: ${jobName}`,
          body: notes
            ? `Interview set for ${interviewAt.toISOString()}. ${notes}`
            : `Interview set for ${interviewAt.toISOString()}.`,
          entityType: 'job_application',
          entityId: owned.application.job_application_id,
          actionUrl: 'jobs',
        });
      } catch (e) {
        console.error('Interview notify failed:', e.message);
      }
    }

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save interview' });
  }
});

/* EMPLOYER — status-change / note / interview timeline */
router.get('/applications/:id/timeline', authenticateToken, async (req, res) => {
  try {
    const owned = await loadOwnedApplication(req.params.id, req.user.user_id);
    if (!owned.ok) return res.status(owned.code).json({ error: owned.error });
    const events = await prisma.job_application_event.findMany({
      where: { job_application_id: owned.application.job_application_id },
      orderBy: [{ created_at: 'asc' }, { event_id: 'asc' }],
    });
    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load application timeline' });
  }
});

/* EMPLOYER — bulk pipeline move (shortlist / reject / …) */
router.post('/applications/bulk-status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body || {};
    const ids = [...new Set((req.body?.ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (!PIPELINE_ACTIONS.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${PIPELINE_ACTIONS.join(', ')}` });
    }
    if (!ids.length) return res.status(400).json({ error: 'Select at least one applicant.' });
    if (ids.length > BULK_STATUS_MAX) {
      return res.status(400).json({ error: `You can update at most ${BULK_STATUS_MAX} applicants at once.` });
    }

    const agent = await myAgent(req.user.user_id);
    if (!agent) return res.status(403).json({ error: 'Employer profile required' });

    const rows = await prisma.job_application.findMany({
      where: {
        job_application_id: { in: ids },
        jobs: { agent_id: agent.agent_id },
      },
      include: {
        jobs: { include: { agents: true } },
        candidate: { include: { user: { select: { user_id: true, name: true, email: true, language: true } } } },
      },
    });
    if (!rows.length) return res.status(404).json({ error: 'No matching applications found for your jobs.' });

    const updated = [];
    for (const application of rows) {
      const fromStatus = application.status || 'applied';
      const row = await prisma.job_application.update({
        where: { job_application_id: application.job_application_id },
        data: { status, updated_at: new Date() },
      });
      try {
        await logApplicationEvent({
          job_application_id: application.job_application_id,
          from_status: fromStatus,
          to_status: status,
          event_type: 'status',
          actor_user_id: req.user.user_id,
          note: 'Bulk status update',
        });
      } catch (e) {
        console.error('Bulk timeline event failed:', e.message);
      }
      await notifySeekerStatus(req.app.get('io'), application, status);
      updated.push(row);
    }

    res.json({ updated: updated.length, skipped: ids.length - updated.length, applications: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to bulk-update application status' });
  }
});

/* SEEKER — withdraw own application */
router.delete('/applications/:id', authenticateToken, async (req, res) => {
  try {
    const application = await prisma.job_application.findUnique({
      where: { job_application_id: parseInt(req.params.id) },
      include: { candidate: true },
    });
    if (!application) return res.status(404).json({ error: 'Job application not found' });
    if (application.candidate?.candidate_user_id !== Number(req.user.user_id)) {
      return res.status(403).json({ error: 'Not authorised to withdraw this application' });
    }
    await prisma.job_application.delete({ where: { job_application_id: parseInt(req.params.id) } });
    res.json({ message: 'Application withdrawn successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to withdraw job application' });
  }
});

//======================================================================================================
//========================================== JOB CATEGORIES ============================================
//======================================================================================================

router.get('/categories', async (_req, res) => {
  try {
    const categories = await prisma.job_categories.findMany({ orderBy: { job_category_id: 'desc' } });
    res.json(categories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch job categories' });
  }
});

router.get('/categories/:id', async (req, res) => {
  try {
    const category = await prisma.job_categories.findUnique({
      where: { job_category_id: parseInt(req.params.id) },
    });
    if (!category) return res.status(404).json({ error: 'Job category not found' });
    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch job category' });
  }
});

router.post('/categories', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { job_category_name, job_category_image_url } = req.body;
    const category = await prisma.job_categories.create({ data: { job_category_name, job_category_image_url } });
    res.status(201).json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create job category' });
  }
});

router.put('/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { job_category_name, job_category_image_url } = req.body;
    const category = await prisma.job_categories.update({
      where: { job_category_id: parseInt(req.params.id) },
      data: { job_category_name, job_category_image_url },
    });
    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update job category' });
  }
});

router.delete('/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.job_categories.delete({ where: { job_category_id: parseInt(req.params.id) } });
    res.json({ message: 'Job category deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete job category' });
  }
});

//======================================================================================================
//================================================ JOBS ================================================
//======================================================================================================

/* EMPLOYER — my posted jobs (with applicant counts) */
router.get('/my/posted', authenticateToken, async (req, res) => {
  try {
    const agent = await myAgent(req.user.user_id);
    if (!agent) return res.json([]);
    const jobs = await prisma.jobs.findMany({
      where: { agent_id: agent.agent_id },
      orderBy: { job_id: 'desc' },
      include: {
        job_categories: true,
        _count: { select: { job_application: true } },
      },
    });
    res.json(jobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your job postings' });
  }
});

/* EMPLOYER — applications funnel by status (job board, not work-jobs) */
/**
 * POST /job/analytics — seeker funnel events (job_viewed, job_applied).
 * Mirrors rideshare: allowlisted events, light throttle/dedupe, never blocks UX.
 */
router.post('/analytics', authenticateToken, async (req, res) => {
  const userId = Number(req.user?.user_id);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(401).json({ successful: false, message: 'Unauthorized' });
  }
  const { event } = req.body ?? {};
  if (!JOB_ANALYTICS_EVENTS.has(event)) {
    return res.status(400).json({ successful: false, message: 'Unknown jobs analytics event' });
  }
  const metadata = safeJobAnalyticsMetadata(req.body);
  const fingerprint = JSON.stringify([event, metadata.job_id ?? null, metadata.job_application_id ?? null]);
  const guard = checkRiderAnalyticsGuard(userId, fingerprint);
  if (guard.throttled) {
    return res.set('Retry-After', String(guard.retryAfterSeconds)).status(429).json({
      successful: false,
      message: 'Too many analytics events',
    });
  }
  if (guard.duplicate) return res.status(202).json({ successful: true });
  try {
    recordActivity(userId, `jobs.${event}`, { metadata });
  } catch (err) {
    console.error('[job] analytics record failed:', err?.message || err);
  }
  return res.status(202).json({ successful: true });
});

router.get('/my/analytics', authenticateToken, async (req, res) => {
  try {
    const agent = await myAgent(req.user.user_id);
    if (!agent) {
      return res.json({
        total: 0,
        jobs: 0,
        by_status: Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0])),
      });
    }
    const apps = await prisma.job_application.findMany({
      where: { jobs: { agent_id: agent.agent_id } },
      select: { status: true },
    });
    const jobsCount = await prisma.jobs.count({ where: { agent_id: agent.agent_id } });
    const by_status = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0]));
    for (const a of apps) {
      const s = APPLICATION_STATUSES.includes(a.status) ? a.status : 'applied';
      by_status[s] += 1;
    }
    res.json({ total: apps.length, jobs: jobsCount, by_status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load hiring analytics' });
  }
});

//======================================================================================================
//======================================= SEEKER SAVED SEARCHES ========================================
//======================================================================================================

router.get('/saved-searches', authenticateToken, async (req, res) => {
  try {
    const rows = await prisma.job_saved_search.findMany({
      where: { user_id: req.user.user_id },
      orderBy: { created_at: 'desc' },
    });
    res.json({ successful: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to fetch saved searches' });
  }
});

router.post('/saved-searches', authenticateToken, async (req, res) => {
  try {
    const { name, filters, alert_enabled, frequency } = req.body || {};
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
      return res.status(400).json({ successful: false, message: 'filters object required' });
    }
    const now = new Date();
    const row = await prisma.job_saved_search.create({
      data: {
        user_id: req.user.user_id,
        name: name ? String(name).slice(0, 120) : null,
        filters: stripPagingFromSeekerFilters(filters),
        alert_enabled: asBool(alert_enabled, true),
        frequency: normalizeJobSavedSearchFrequency(frequency),
        last_notified_at: now,
      },
    });
    res.status(201).json({ successful: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to save search' });
  }
});

router.patch('/saved-searches/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.job_saved_search.findUnique({ where: { saved_search_id: id } });
    if (!existing || existing.user_id !== req.user.user_id) {
      return res.status(404).json({ successful: false, message: 'Saved search not found' });
    }
    const { name, filters, alert_enabled, frequency } = req.body || {};
    const data = {};
    if (name !== undefined) data.name = name ? String(name).slice(0, 120) : null;
    if (filters !== undefined) {
      if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
        return res.status(400).json({ successful: false, message: 'filters must be an object' });
      }
      data.filters = stripPagingFromSeekerFilters(filters);
    }
    if (alert_enabled !== undefined) data.alert_enabled = asBool(alert_enabled, existing.alert_enabled);
    if (frequency !== undefined) data.frequency = normalizeJobSavedSearchFrequency(frequency);
    const row = await prisma.job_saved_search.update({
      where: { saved_search_id: id },
      data,
    });
    res.json({ successful: true, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to update saved search' });
  }
});

router.post('/saved-searches/run-alerts', authenticateToken, async (req, res) => {
  try {
    const io = req.app.get('io');
    const result = await runJobSavedSearchAlerts(io, { userId: req.user.user_id });
    res.json({ successful: true, data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to run saved-search alerts' });
  }
});

router.delete('/saved-searches/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.job_saved_search.findUnique({ where: { saved_search_id: id } });
    if (!existing || existing.user_id !== req.user.user_id) {
      return res.status(404).json({ successful: false, message: 'Saved search not found' });
    }
    await prisma.job_saved_search.delete({ where: { saved_search_id: id } });
    res.json({ successful: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to delete saved search' });
  }
});

/* ADMIN — job report queue */
router.get('/admin/reports', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const where = status === 'all' ? {} : { status };
    const rows = await prisma.job_report.findMany({
      where,
      include: {
        jobs: {
          select: {
            job_id: true,
            job_name: true,
            status: true,
            location: true,
            agent_id: true,
            agents: { select: { company_name: true, agent_user_id: true } },
          },
        },
        reporter: { select: { user_id: true, name: true, email: true } },
      },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    res.json({ successful: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to list job reports' });
  }
});

router.patch('/admin/reports/:report_id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const report_id = Number(req.params.report_id);
    if (!Number.isFinite(report_id) || report_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid report id' });
    }
    const action = String(req.body?.action || '').trim().toLowerCase();
    const statusBody = req.body?.status != null ? String(req.body.status) : null;
    if (action && !JOB_MODERATION_ACTIONS.includes(action)) {
      return res.status(400).json({
        successful: false,
        message: `action must be one of: ${JOB_MODERATION_ACTIONS.join(', ')}`,
      });
    }
    if (statusBody && !JOB_REPORT_STATUSES.includes(statusBody)) {
      return res.status(400).json({ successful: false, message: 'Invalid status' });
    }

    const report = await prisma.job_report.findUnique({ where: { report_id } });
    if (!report) return res.status(404).json({ successful: false, message: 'Report not found' });

    let nextStatus = statusBody || 'reviewed';
    let actionTaken = 'none';
    if (action === 'remove') {
      await prisma.jobs.update({
        where: { job_id: report.job_id },
        data: { status: 'removed' },
      });
      nextStatus = 'actioned';
      actionTaken = 'removed';
    } else if (action === 'suspend') {
      await prisma.jobs.update({
        where: { job_id: report.job_id },
        data: { status: 'suspended' },
      });
      nextStatus = 'actioned';
      actionTaken = 'suspended';
    } else if (action === 'dismiss') {
      nextStatus = 'dismissed';
      actionTaken = 'dismissed';
    }

    const note = req.body?.note != null ? String(req.body.note).trim().slice(0, 2000) : null;
    const updated = await prisma.job_report.update({
      where: { report_id },
      data: {
        status: nextStatus,
        action_taken: actionTaken,
        resolution_note: note,
        resolved_by: req.user.user_id,
      },
    });
    res.json({ successful: true, data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to update job report' });
  }
});

/* SEEKER — report a job listing */
router.post('/:id/report', authenticateToken, jobReportLimiter, async (req, res) => {
  try {
    const job_id = Number(req.params.id);
    if (!Number.isFinite(job_id) || job_id <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid job id' });
    }
    const job = await prisma.jobs.findUnique({
      where: { job_id },
      include: { agents: { select: { agent_user_id: true } } },
    });
    if (!job) return res.status(404).json({ successful: false, message: 'Job not found' });
    if (job.agents?.agent_user_id === req.user.user_id) {
      return res.status(400).json({ successful: false, message: 'You cannot report your own job listing' });
    }

    const reason = normalizeJobReportReason(req.body?.reason);
    if (!reason) {
      return res.status(400).json({
        successful: false,
        message: 'reason must be one of: scam, misleading_pay, fake_employer, inappropriate, spam, other',
      });
    }
    const details = req.body?.details != null ? String(req.body.details).trim().slice(0, 2000) : null;

    const existing = await prisma.job_report.findFirst({
      where: { job_id, reporter_id: req.user.user_id, status: 'pending' },
    });
    if (existing) {
      return res.status(409).json({ successful: false, message: 'You already have a pending report for this job' });
    }

    const report = await prisma.job_report.create({
      data: {
        job_id,
        reporter_id: req.user.user_id,
        reason,
        details,
      },
    });
    res.status(201).json({ successful: true, message: 'Report submitted for review.', data: report });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to submit report' });
  }
});

/* RECOMMENDED — auth seeker; heuristic rank from profile + recent apps. No ads. */
router.get('/recommended', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 24);
    const cand = await myCandidate(req.user.user_id);
    let recentJobs = [];
    let appliedIds = [];
    if (cand) {
      const apps = await prisma.job_application.findMany({
        where: { candidate_id: cand.candidate_id },
        orderBy: [{ application_date: 'desc' }, { job_application_id: 'desc' }],
        take: 25,
        include: {
          jobs: { select: { job_id: true, job_name: true, job_category_id: true } },
        },
      });
      recentJobs = apps.map((a) => a.jobs).filter(Boolean);
      appliedIds = apps.map((a) => a.job_id).filter((id) => id != null);
    }

    const signals = buildRecommendSignals({ candidate: cand, recentJobs });
    // Nothing to personalise on yet — don't hand back newest-first and call it a match.
    if (!hasRecommendSignals(signals)) return res.json([]);

    const poolTake = Math.min(Math.max(limit * 15, 80), 200);
    const where = {
      status: 'open',
      ...(appliedIds.length ? { job_id: { notIn: appliedIds } } : {}),
    };
    const pool = await prisma.jobs.findMany({
      where,
      orderBy: [{ posted_date: 'desc' }, { job_id: 'desc' }],
      take: poolTake,
      include: JOB_INCLUDE,
    });

    const ranked = rankRecommendedJobs(pool, signals, { limit });
    res.json(ranked);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load recommended jobs' });
  }
});

/* SEARCH / LIST — public, filterable. Defaults to open postings. */
router.get('/', async (req, res) => {
  try {
    const {
      category, location, is_remote, employment_type, salary_min, salary_max,
      keyword, status, sort,
    } = req.query;

    const where = buildPublicJobWhere({
      category, location, is_remote, employment_type, salary_min, salary_max, keyword, status,
      agent_id: req.query.agent_id,
    });

    const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const skip = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    let orderBy = { job_id: 'desc' };
    if (sort === 'salary_desc') orderBy = [{ salary_max: 'desc' }, { salary_min: 'desc' }, { job_id: 'desc' }];
    else if (sort === 'salary_asc') orderBy = [{ salary_min: 'asc' }, { salary_max: 'asc' }, { job_id: 'desc' }];
    else if (sort === 'newest') orderBy = [{ posted_date: 'desc' }, { job_id: 'desc' }];

    const [jobs, activeAd] = await Promise.all([
      prisma.jobs.findMany({ where, orderBy, take, skip, include: JOB_INCLUDE }),
      selectBestAd(req.adContext).catch(() => null),
    ]);

    const filtered = jobs;

    // Sponsored slot only on the first page — avoid repeating the ad on every offset page.
    if (activeAd && skip === 0) {
      const adJob = await prisma.jobs.findFirst({
        where: { agents: { agent_user_id: activeAd.advertiser_id } },
        include: JOB_INCLUDE,
      });
      if (adJob) {
        filtered.unshift({
          ...adJob,
          job_name: activeAd.headline || adJob.job_name,
          description: activeAd.description || adJob.description,
          is_ad: true,
          campaign_id: activeAd.campaign_id,
          target_url: activeAd.target_url,
          cta_text: activeAd.cta_text || 'APPLY_NOW',
          sponsored: true,
          is_generic_ad: false,
        });
      } else {
        filtered.unshift({
          job_id: `ad_${activeAd.campaign_id}`,
          job_name: activeAd.headline || activeAd.title,
          description: activeAd.description,
          job_category_id: null,
          posted_date: new Date(),
          deadline: null,
          agent_id: null,
          is_ad: true,
          campaign_id: activeAd.campaign_id,
          target_url: activeAd.target_url,
          cta_text: activeAd.cta_text || 'LEARN_MORE',
          sponsored: true,
          is_generic_ad: true,
          job_categories: null,
          agents: {
            agent_id: `agent_${activeAd.campaign_id}`,
            company_name: activeAd.headline || activeAd.title,
            company_web_url: activeAd.target_url,
            user: { name: activeAd.headline || activeAd.title },
          },
          job_application: [],
        });
      }
    }

    res.json(filtered);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

/* EMPLOYER — applicants for one of my jobs */
router.get('/:id/applications', authenticateToken, async (req, res) => {
  try {
    const owns = await ownsJob(req.user.user_id, req.params.id);
    if (!owns.ok) {
      return res.status(owns.code).json({ error: owns.code === 404 ? 'Job not found' : 'Not authorised' });
    }
    const applications = await prisma.job_application.findMany({
      where: { job_id: parseInt(req.params.id) },
      orderBy: { job_application_id: 'desc' },
      include: {
        candidate: {
          include: {
            user: true,
            candidate_portfolio_item: {
              orderBy: [{ sort_order: 'asc' }, { portfolio_item_id: 'asc' }],
              take: 12,
            },
          },
        },
      },
    });
    res.json(applications);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch applicants' });
  }
});

/* GET JOB BY ID — public */
router.get('/:id', async (req, res) => {
  try {
    const job = await prisma.jobs.findUnique({
      where: { job_id: parseInt(req.params.id) },
      include: {
        ...JOB_INCLUDE,
        _count: { select: { job_application: true } },
      },
    });
    if (!job || isModerationStatus(job.status)) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

/* CREATE JOB — employer only (posted under the caller's agents profile) */
router.post('/', authenticateToken, jobPostLimiter, async (req, res) => {
  try {
    const agent = await myAgent(req.user.user_id);
    if (!agent) {
      return res.status(403).json({ error: 'Create an employer profile before posting jobs.' });
    }
    const {
      job_name, description, job_category_id, deadline, location, is_remote,
      employment_type, salary_min, salary_max, salary_period, experience_level, status,
    } = req.body;

    if (!job_name) return res.status(400).json({ error: 'job_name is required' });

    const blocked = findBlockedJobContent(job_name, description);
    if (blocked) {
      return res.status(400).json({
        error: `Listing text looks like blocked content ("${blocked}"). Remove it and try again.`,
      });
    }

    const job = await prisma.jobs.create({
      data: {
        job_name,
        description,
        job_category_id: job_category_id ? parseInt(job_category_id) : null,
        posted_date: new Date(),
        deadline: deadline ? new Date(deadline) : null,
        agent_id: agent.agent_id,
        location: location || null,
        is_remote: typeof is_remote === 'boolean' ? is_remote : null,
        employment_type: employment_type || null,
        salary_min: salary_min != null ? Number(salary_min) : null,
        salary_max: salary_max != null ? Number(salary_max) : null,
        salary_period: salary_period || null,
        experience_level: experience_level || null,
        status: JOB_STATUSES.includes(status) ? status : 'open',
      },
      include: JOB_INCLUDE,
    });
    res.status(201).json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

/* UPDATE JOB — employer only, ownership enforced */
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const owns = await ownsJob(req.user.user_id, req.params.id);
    if (!owns.ok) {
      return res.status(owns.code).json({ error: owns.code === 404 ? 'Job not found' : 'Not authorised' });
    }
    const {
      job_name, description, job_category_id, deadline, location, is_remote,
      employment_type, salary_min, salary_max, salary_period, experience_level, status,
    } = req.body;

    const blocked = findBlockedJobContent(
      job_name ?? owns.job?.job_name,
      description ?? owns.job?.description,
    );
    if (blocked) {
      return res.status(400).json({
        error: `Listing text looks like blocked content ("${blocked}"). Remove it and try again.`,
      });
    }

    const job = await prisma.jobs.update({
      where: { job_id: parseInt(req.params.id) },
      data: {
        job_name: job_name ?? undefined,
        description: description ?? undefined,
        job_category_id: job_category_id != null ? parseInt(job_category_id) : undefined,
        deadline: deadline ? new Date(deadline) : undefined,
        location: location ?? undefined,
        is_remote: typeof is_remote === 'boolean' ? is_remote : undefined,
        employment_type: employment_type ?? undefined,
        salary_min: salary_min != null ? Number(salary_min) : undefined,
        salary_max: salary_max != null ? Number(salary_max) : undefined,
        salary_period: salary_period ?? undefined,
        experience_level: experience_level ?? undefined,
        status: JOB_STATUSES.includes(status) ? status : undefined,
      },
      include: JOB_INCLUDE,
    });
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update job' });
  }
});

/* CHANGE JOB STATUS — employer only (open / closed / draft) */
router.patch('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    if (!JOB_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${JOB_STATUSES.join(', ')}` });
    }
    const owns = await ownsJob(req.user.user_id, req.params.id);
    if (!owns.ok) {
      return res.status(owns.code).json({ error: owns.code === 404 ? 'Job not found' : 'Not authorised' });
    }
    const job = await prisma.jobs.update({
      where: { job_id: parseInt(req.params.id) },
      data: { status },
    });
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update job status' });
  }
});

/* DELETE JOB — employer only, ownership enforced */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const owns = await ownsJob(req.user.user_id, req.params.id);
    if (!owns.ok) {
      return res.status(owns.code).json({ error: owns.code === 404 ? 'Job not found' : 'Not authorised' });
    }
    // Remove dependent applications first (no cascade on the FK).
    await prisma.job_application.deleteMany({ where: { job_id: parseInt(req.params.id) } });
    await prisma.jobs.delete({ where: { job_id: parseInt(req.params.id) } });
    res.json({ message: 'Job deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

export default router;
