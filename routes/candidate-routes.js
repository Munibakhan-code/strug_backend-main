// routes/candidate.js
import express from 'express';
import multer from 'multer';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { normalizeResumeJson, parseResumeJson } from '../utils/candidate-resume-json.js';
import {
  MAX_PORTFOLIO_ITEMS,
  normalizePortfolioItemInput,
  serializePortfolioItem,
} from '../utils/candidate-portfolio.js';
import {
  buildTalentPoolWhere,
  clampTalentPoolLimit,
  queryTalentPoolCandidates,
  serializeTalentPoolCandidate,
} from '../utils/candidate-talent-pool.js';
import {
  isTalentBoostActive,
  resolveTalentBoostPlan,
  computeBoostedUntil,
  TALENT_BOOST_PLANS,
} from '../utils/talent-pool-boost.js';
import {
  MAX_RESUME_VERSIONS,
  normalizeResumeVersionInput,
  serializeResumeVersion,
} from '../utils/candidate-resume-versions.js';
import { buildResumePdfBuffer } from '../utils/resume-pdf.js';
import { debitWorkWallet } from '../utils/work-wallet.js';
import { storeImageBuffer, sniffImageType, buildObjectName } from '../utils/image-upload.js';
import { hasResumeJsonContent } from '../utils/candidate-resume-json.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

function sniffPortfolioType(buf) {
  if (!buf || buf.length < 5) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'application/pdf';
  }
  return sniffImageType(buf);
}

// Editable job-seeker profile fields (candidate_user_id is derived from the token, never the body).
const PROFILE_FIELDS = [
  'headline',
  'bio',
  'skills',
  'resume_url',
  'resume_json',
  'location',
  'desired_salary',
  'years_experience',
  'discoverable',
];

function pickProfile(body) {
  const data = {};
  for (const key of PROFILE_FIELDS) {
    if (body[key] === undefined) continue;
    if (key === 'desired_salary') data[key] = body[key] != null ? Number(body[key]) : null;
    else if (key === 'years_experience') data[key] = body[key] != null ? parseInt(body[key], 10) : null;
    else if (key === 'resume_json') {
      data[key] = body[key] == null ? null : normalizeResumeJson(parseResumeJson(body[key]));
    } else if (key === 'discoverable') {
      data[key] = Boolean(body[key]);
    } else data[key] = body[key];
  }
  return data;
}

async function ensureOwnCandidate(userId) {
  let candidate = await prisma.candidate.findFirst({ where: { candidate_user_id: userId } });
  if (!candidate) {
    candidate = await prisma.candidate.create({ data: { candidate_user_id: userId } });
  }
  return candidate;
}

async function requireEmployerAgent(userId) {
  return prisma.agents.findFirst({ where: { agent_user_id: userId } });
}

/**
 * Get all candidates — admin only (Phase 2 privacy).
 * Seekers use GET /candidate/me; employers use GET /candidate/talent-pool.
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    if (!req.user?.is_admin && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Candidate directory is not public.' });
    }
    const candidates = await prisma.candidate.findMany({
      orderBy: { candidate_id: 'desc' },
      include: {
        user: true,
      },
    });

    res.json(candidates);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch candidates' });
  }
});

/**
 * Employer passive candidate search (Jobs Phase 4).
 * Only discoverable opt-in seekers. Must be before /:candidate_id.
 */
router.get('/talent-pool', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user.user_id);
    const agent = await requireEmployerAgent(userId);
    if (!agent && !req.user?.is_admin && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Employer company profile required to search the talent pool.' });
    }

    const limit = clampTalentPoolLimit(req.query.limit);
    const where = buildTalentPoolWhere(req.query);
    const include = {
      user: {
        select: {
          user_id: true,
          name: true,
          username: true,
          // Avatar lives on social_profile, not user (user has no profile_pic_url).
          social_profiles: { select: { profile_pic_url: true } },
        },
      },
      candidate_portfolio_item: {
        orderBy: [{ sort_order: 'asc' }, { portfolio_item_id: 'asc' }],
        take: 6,
      },
    };
    // Boosted seekers are fetched first so a paid boost is never dropped by an
    // experience-only pre-cut (then sorted with active boosts still first).
    const ranked = await queryTalentPoolCandidates(prisma, { where, limit, include });
    res.json({
      results: ranked.map(serializeTalentPoolCandidate),
      limit,
      count: ranked.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to search talent pool' });
  }
});

/**
 * Get (or lazily create) the caller's own candidate/seeker profile.
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user.user_id);
    let candidate = await prisma.candidate.findFirst({
      where: { candidate_user_id: userId },
      include: {
        user: true,
        candidate_portfolio_item: {
          orderBy: [{ sort_order: 'asc' }, { portfolio_item_id: 'asc' }],
        },
        candidate_resume: {
          orderBy: [{ is_default: 'desc' }, { updated_at: 'desc' }],
        },
      },
    });
    if (!candidate) {
      candidate = await prisma.candidate.create({
        data: { candidate_user_id: userId },
        include: {
          user: true,
          candidate_portfolio_item: true,
          candidate_resume: true,
        },
      });
    }
    res.json({
      ...candidate,
      portfolio: (candidate.candidate_portfolio_item || []).map(serializePortfolioItem),
      resumes: (candidate.candidate_resume || []).map(serializeResumeVersion),
      talent_boosted: isTalentBoostActive(candidate.talent_boosted_until),
      talent_boost_plans: Object.values(TALENT_BOOST_PLANS),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your profile' });
  }
});

/**
 * Update the caller's own candidate/seeker profile.
 */
router.put('/me', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user.user_id);
    const existing = await prisma.candidate.findFirst({ where: { candidate_user_id: userId } });
    const data = pickProfile(req.body);

    const candidate = existing
      ? await prisma.candidate.update({
          where: { candidate_id: existing.candidate_id },
          data,
          include: {
            user: true,
            candidate_portfolio_item: {
              orderBy: [{ sort_order: 'asc' }, { portfolio_item_id: 'asc' }],
            },
          },
        })
      : await prisma.candidate.create({
          data: { candidate_user_id: userId, ...data },
          include: {
            user: true,
            candidate_portfolio_item: true,
          },
        });

    res.json({
      ...candidate,
      portfolio: (candidate.candidate_portfolio_item || []).map(serializePortfolioItem),
      talent_boosted: isTalentBoostActive(candidate.talent_boosted_until),
      talent_boost_plans: Object.values(TALENT_BOOST_PLANS),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update your profile' });
  }
});

async function syncDefaultResumeToCandidate(tx, candidateId, version) {
  await tx.candidate.update({
    where: { candidate_id: candidateId },
    data: {
      resume_json: version.resume_json ?? null,
      resume_url: version.resume_url ?? null,
    },
  });
}

async function clearOtherDefaults(tx, candidateId, keepId) {
  await tx.candidate_resume.updateMany({
    where: {
      candidate_id: candidateId,
      ...(keepId ? { resume_version_id: { not: keepId } } : {}),
    },
    data: { is_default: false },
  });
}

/** List résumé versions. */
router.get('/me/resumes', authenticateToken, async (req, res) => {
  try {
    const candidate = await ensureOwnCandidate(Number(req.user.user_id));
    const rows = await prisma.candidate_resume.findMany({
      where: { candidate_id: candidate.candidate_id },
      orderBy: [{ is_default: 'desc' }, { updated_at: 'desc' }],
    });
    res.json(rows.map(serializeResumeVersion));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load résumé versions' });
  }
});

/** Create a named résumé version. */
router.post('/me/resumes', authenticateToken, async (req, res) => {
  try {
    const candidate = await ensureOwnCandidate(Number(req.user.user_id));
    const count = await prisma.candidate_resume.count({ where: { candidate_id: candidate.candidate_id } });
    if (count >= MAX_RESUME_VERSIONS) {
      return res.status(400).json({ error: `You can keep at most ${MAX_RESUME_VERSIONS} résumé versions.` });
    }
    const input = normalizeResumeVersionInput(req.body || {});
    const makeDefault = input.is_default === true || count === 0;
    const created = await prisma.$transaction(async (tx) => {
      if (makeDefault) await clearOtherDefaults(tx, candidate.candidate_id);
      const row = await tx.candidate_resume.create({
        data: {
          candidate_id: candidate.candidate_id,
          label: input.label,
          resume_json: input.resume_json === undefined ? candidate.resume_json : input.resume_json,
          resume_url: input.resume_url === undefined ? candidate.resume_url : input.resume_url,
          is_default: makeDefault,
        },
      });
      if (makeDefault) await syncDefaultResumeToCandidate(tx, candidate.candidate_id, row);
      return row;
    });
    res.status(201).json(serializeResumeVersion(created));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create résumé version' });
  }
});

/** Update a résumé version. */
router.patch('/me/resumes/:id', authenticateToken, async (req, res) => {
  try {
    const candidate = await ensureOwnCandidate(Number(req.user.user_id));
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid résumé id.' });
    const existing = await prisma.candidate_resume.findUnique({ where: { resume_version_id: id } });
    if (!existing || existing.candidate_id !== candidate.candidate_id) {
      return res.status(404).json({ error: 'Résumé version not found' });
    }
    const input = normalizeResumeVersionInput({
      label: req.body?.label ?? existing.label,
      resume_json: req.body?.resume_json === undefined ? existing.resume_json : req.body.resume_json,
      resume_url: req.body?.resume_url === undefined ? existing.resume_url : req.body.resume_url,
      is_default: req.body?.is_default,
    });
    const makeDefault = input.is_default === true;
    const updated = await prisma.$transaction(async (tx) => {
      if (makeDefault) await clearOtherDefaults(tx, candidate.candidate_id, id);
      const row = await tx.candidate_resume.update({
        where: { resume_version_id: id },
        data: {
          label: input.label,
          ...(req.body?.resume_json !== undefined ? { resume_json: input.resume_json } : {}),
          ...(req.body?.resume_url !== undefined ? { resume_url: input.resume_url } : {}),
          ...(req.body?.is_default !== undefined ? { is_default: Boolean(input.is_default) } : {}),
          updated_at: new Date(),
        },
      });
      if (row.is_default) await syncDefaultResumeToCandidate(tx, candidate.candidate_id, row);
      return row;
    });
    res.json(serializeResumeVersion(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update résumé version' });
  }
});

/** Delete a résumé version (cannot delete the only default without another). */
router.delete('/me/resumes/:id', authenticateToken, async (req, res) => {
  try {
    const candidate = await ensureOwnCandidate(Number(req.user.user_id));
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid résumé id.' });
    const existing = await prisma.candidate_resume.findUnique({ where: { resume_version_id: id } });
    if (!existing || existing.candidate_id !== candidate.candidate_id) {
      return res.status(404).json({ error: 'Résumé version not found' });
    }
    await prisma.candidate_resume.delete({ where: { resume_version_id: id } });
    if (existing.is_default) {
      const next = await prisma.candidate_resume.findFirst({
        where: { candidate_id: candidate.candidate_id },
        orderBy: { updated_at: 'desc' },
      });
      if (next) {
        await prisma.$transaction(async (tx) => {
          await clearOtherDefaults(tx, candidate.candidate_id);
          const row = await tx.candidate_resume.update({
            where: { resume_version_id: next.resume_version_id },
            data: { is_default: true },
          });
          await syncDefaultResumeToCandidate(tx, candidate.candidate_id, row);
        });
      }
    }
    res.json({ ok: true, resume_version_id: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete résumé version' });
  }
});

/**
 * Server-side PDF generation from structured résumé.
 * Body: { resume_version_id? } — defaults to active resume_json on profile.
 * Stores PDF and sets resume_url on the version (and candidate when default).
 */
router.post('/me/resume/pdf', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user.user_id);
    const candidate = await prisma.candidate.findFirst({
      where: { candidate_user_id: userId },
      include: { user: { select: { name: true, username: true } } },
    });
    if (!candidate) return res.status(404).json({ error: 'Create your seeker profile first.' });

    let version = null;
    const versionId = Number(req.body?.resume_version_id);
    if (Number.isFinite(versionId) && versionId > 0) {
      version = await prisma.candidate_resume.findUnique({ where: { resume_version_id: versionId } });
      if (!version || version.candidate_id !== candidate.candidate_id) {
        return res.status(404).json({ error: 'Résumé version not found' });
      }
    }

    const resumeJson = version?.resume_json ?? candidate.resume_json;
    if (!hasResumeJsonContent(resumeJson)) {
      return res.status(400).json({ error: 'Add summary, experience, or education before exporting.' });
    }

    const buffer = buildResumePdfBuffer(resumeJson, {
      name: candidate.user?.name || candidate.user?.username || 'Resume',
      headline: candidate.headline,
    });
    const objectName = buildObjectName('resume.pdf');
    const url = await storeImageBuffer({
      container: 'resumes',
      dirName: 'generated',
      objectName,
      buffer,
      contentType: 'application/pdf',
    });

    if (version) {
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.candidate_resume.update({
          where: { resume_version_id: version.resume_version_id },
          data: { resume_url: url, updated_at: new Date() },
        });
        if (row.is_default) await syncDefaultResumeToCandidate(tx, candidate.candidate_id, row);
        return row;
      });
      return res.status(201).json({ url, resume: serializeResumeVersion(updated) });
    }

    await prisma.candidate.update({
      where: { candidate_id: candidate.candidate_id },
      data: { resume_url: url },
    });
    res.status(201).json({ url });
  } catch (err) {
    console.error(err);
    const msg = err?.message?.includes('Add summary') ? err.message : 'Failed to generate résumé PDF';
    res.status(err?.message?.includes('Add summary') ? 400 : 500).json({ error: msg });
  }
});

/** Purchase / extend a paid talent-pool boost (wallet debit). */
router.post('/me/talent-boost', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.user.user_id);
    const plan = resolveTalentBoostPlan(req.body?.days);
    if (!plan) {
      return res.status(400).json({
        error: 'Choose a boost plan of 7, 14, or 30 days.',
        plans: Object.values(TALENT_BOOST_PLANS),
      });
    }
    const candidate = await ensureOwnCandidate(userId);
    if (!candidate.discoverable) {
      return res.status(400).json({ error: 'Turn on talent-pool visibility before buying a boost.' });
    }

    // Debit + grant must share one transaction so a failed candidate update never
    // keeps a committed wallet charge without an active boost.
    const outcome = await prisma.$transaction(async (tx) => {
      const debit = await debitWorkWallet(
        userId,
        plan.amountCad,
        'jobs_talent_boost',
        `Talent pool boost (${plan.label})`,
        tx,
      );
      if (!debit.ok) {
        return { status: 'insufficient', balance: debit.balance };
      }
      const until = computeBoostedUntil(candidate.talent_boosted_until, plan.days);
      const updated = await tx.candidate.update({
        where: { candidate_id: candidate.candidate_id },
        data: { talent_boosted_until: until, discoverable: true },
      });
      return {
        status: 'ok',
        updated,
        balance: debit.balance,
      };
    });

    if (outcome.status === 'insufficient') {
      return res.status(402).json({
        error: 'Insufficient wallet balance for this boost.',
        required: plan.amountCad,
        balance: outcome.balance,
      });
    }

    res.json({
      ok: true,
      plan,
      talent_boosted_until: outcome.updated.talent_boosted_until,
      talent_boosted: true,
      balance: outcome.balance,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to purchase talent-pool boost' });
  }
});

/** List own portfolio items. */
router.get('/me/portfolio', authenticateToken, async (req, res) => {
  try {
    const candidate = await ensureOwnCandidate(Number(req.user.user_id));
    const items = await prisma.candidate_portfolio_item.findMany({
      where: { candidate_id: candidate.candidate_id },
      orderBy: [{ sort_order: 'asc' }, { portfolio_item_id: 'asc' }],
    });
    res.json(items.map(serializePortfolioItem));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load portfolio' });
  }
});

/** Add portfolio item by URL (JSON). */
router.post('/me/portfolio', authenticateToken, async (req, res) => {
  try {
    const candidate = await ensureOwnCandidate(Number(req.user.user_id));
    const count = await prisma.candidate_portfolio_item.count({
      where: { candidate_id: candidate.candidate_id },
    });
    if (count >= MAX_PORTFOLIO_ITEMS) {
      return res.status(400).json({ error: `Portfolio is limited to ${MAX_PORTFOLIO_ITEMS} items.` });
    }

    const parsed = normalizePortfolioItemInput(req.body || {});
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const created = await prisma.candidate_portfolio_item.create({
      data: {
        candidate_id: candidate.candidate_id,
        ...parsed.item,
      },
    });
    res.status(201).json(serializePortfolioItem(created));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add portfolio item' });
  }
});

/** Upload portfolio image/PDF → create item. */
router.post('/me/portfolio/upload', authenticateToken, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg =
        err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
          ? 'File exceeds the 8 MB limit.'
          : 'Portfolio upload failed.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });

    const contentType = sniffPortfolioType(req.file.buffer);
    if (!contentType) {
      return res.status(400).json({ error: 'Unsupported file. Upload a PDF or image.' });
    }

    try {
      const candidate = await ensureOwnCandidate(Number(req.user.user_id));
      const count = await prisma.candidate_portfolio_item.count({
        where: { candidate_id: candidate.candidate_id },
      });
      if (count >= MAX_PORTFOLIO_ITEMS) {
        return res.status(400).json({ error: `Portfolio is limited to ${MAX_PORTFOLIO_ITEMS} items.` });
      }

      const objectName = buildObjectName(req.file.originalname);
      const url = await storeImageBuffer({
        container: 'resumes',
        dirName: 'portfolio',
        objectName,
        buffer: req.file.buffer,
        contentType,
      });

      const media_type = contentType === 'application/pdf' ? 'pdf' : 'image';
      const title = String(req.body?.title ?? '').trim().slice(0, 120) || null;
      const created = await prisma.candidate_portfolio_item.create({
        data: {
          candidate_id: candidate.candidate_id,
          title,
          url,
          media_type,
          sort_order: count,
        },
      });
      res.status(201).json(serializePortfolioItem(created));
    } catch (e) {
      console.error('Portfolio store failed:', e.message);
      res.status(500).json({ error: 'Failed to store portfolio file.' });
    }
  });
});

/** Delete own portfolio item. */
router.delete('/me/portfolio/:item_id', authenticateToken, async (req, res) => {
  try {
    const candidate = await ensureOwnCandidate(Number(req.user.user_id));
    const itemId = Number(req.params.item_id);
    if (!Number.isFinite(itemId)) return res.status(400).json({ error: 'Invalid portfolio item id.' });

    const existing = await prisma.candidate_portfolio_item.findUnique({
      where: { portfolio_item_id: itemId },
    });
    if (!existing || existing.candidate_id !== candidate.candidate_id) {
      return res.status(404).json({ error: 'Portfolio item not found' });
    }

    await prisma.candidate_portfolio_item.delete({ where: { portfolio_item_id: itemId } });
    res.json({ ok: true, portfolio_item_id: itemId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete portfolio item' });
  }
});

/**
 * Get single candidate by candidate_id — self, employer with application, or talent-pool discoverable.
 */
router.get('/:candidate_id', authenticateToken, async (req, res) => {
  try {
    const candidate = await prisma.candidate.findUnique({
      where: { candidate_id: Number(req.params.candidate_id) },
      include: {
        user: true,
        candidate_portfolio_item: {
          orderBy: [{ sort_order: 'asc' }, { portfolio_item_id: 'asc' }],
        },
      },
    });

    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

    const userId = Number(req.user.user_id);
    if (candidate.candidate_user_id === userId || req.user?.is_admin || req.user?.role === 'admin') {
      return res.json({
        ...candidate,
        portfolio: (candidate.candidate_portfolio_item || []).map(serializePortfolioItem),
      });
    }

    const agent = await prisma.agents.findFirst({ where: { agent_user_id: userId } });
    if (agent) {
      const linked = await prisma.job_application.findFirst({
        where: {
          candidate_id: candidate.candidate_id,
          jobs: { agent_id: agent.agent_id },
        },
      });
      if (linked || candidate.discoverable) {
        return res.json(serializeTalentPoolCandidate(candidate));
      }
    }

    return res.status(403).json({ error: 'Not authorised to view this candidate' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch candidate' });
  }
});

/**
 * Create new candidate — for the caller (candidate_user_id comes from the token).
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const userId = Number(req.user.user_id);

    const existing = await prisma.candidate.findFirst({ where: { candidate_user_id: userId } });
    if (existing) return res.status(200).json(existing);

    const newCandidate = await prisma.candidate.create({
      data: {
        candidate_user_id: userId,
        ...pickProfile(req.body),
      },
    });

    io?.emit('candidate-created', newCandidate);

    res.status(201).json(newCandidate);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create candidate' });
  }
});

/**
 * Update candidate — only the owner may edit.
 */
router.put('/:candidate_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { candidate_id } = req.params;

    const existing = await prisma.candidate.findUnique({
      where: { candidate_id: Number(candidate_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Candidate not found' });
    if (existing.candidate_user_id !== Number(req.user.user_id)) {
      return res.status(403).json({ error: 'Not authorised to edit this profile' });
    }

    const updatedCandidate = await prisma.candidate.update({
      where: { candidate_id: Number(candidate_id) },
      data: pickProfile(req.body),
    });

    io?.emit('candidate-updated', updatedCandidate);

    res.json(updatedCandidate);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update candidate' });
  }
});

/**
 * Delete candidate — only the owner may delete.
 */
router.delete('/:candidate_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const existing = await prisma.candidate.findUnique({
      where: { candidate_id: Number(req.params.candidate_id) },
    });
    if (!existing) return res.status(404).json({ error: 'Candidate not found' });
    if (existing.candidate_user_id !== Number(req.user.user_id)) {
      return res.status(403).json({ error: 'Not authorised to delete this profile' });
    }

    const deleted = await prisma.candidate.delete({
      where: { candidate_id: Number(req.params.candidate_id) },
    });

    io?.emit('candidate-deleted', { candidate_id: deleted.candidate_id });

    res.json({ message: 'Candidate deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete candidate' });
  }
});

export default router;
