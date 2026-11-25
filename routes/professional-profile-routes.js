import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { applyVerticalIdentity, verticalIdentityUserInclude } from '../utils/vertical-identity.js';

const router = express.Router();

// A professional (worker) shown in the work vertical displays their `work` identity.
// NOTE: select (not include) — a bare `include: { user: true }` returns every user
// scalar including the password hash + email. Only expose safe display fields plus the
// vertical-identity relations applyVerticalIdentity needs.
const workerUserInclude = {
    select: {
        user_id: true,
        name: true,
        username: true,
        ...verticalIdentityUserInclude,
    },
};

// Lightweight validation/normalization for create + update payloads.
function parseProfileBody(body) {
    const errors = [];
    const data = {};

    if (body.headline !== undefined) {
        if (typeof body.headline !== 'string' || body.headline.length > 200) {
            errors.push('headline must be a string up to 200 characters');
        } else {
            data.headline = body.headline.trim();
        }
    }
    if (body.resume_url !== undefined) {
        if (body.resume_url !== null && (typeof body.resume_url !== 'string' || body.resume_url.length > 2000)) {
            errors.push('resume_url must be a string up to 2000 characters');
        } else {
            data.resume_url = body.resume_url;
        }
    }
    if (body.open_to_work !== undefined) {
        if (typeof body.open_to_work !== 'boolean') {
            errors.push('open_to_work must be a boolean');
        } else {
            data.open_to_work = body.open_to_work;
        }
    }
    if (body.platform_type_id !== undefined) {
        const pt = Number(body.platform_type_id);
        if (Number.isNaN(pt)) {
            errors.push('platform_type_id must be a number');
        } else {
            data.platform_type_id = pt;
        }
    }
    return { data, errors };
}

/* GET ALL PROFESSIONAL PROFILES */
router.get('/', async (_req, res) => {
    try {
        const profiles = await prisma.professional_profile.findMany({
            orderBy: { prof_id: 'desc' },
            include: {
                user: workerUserInclude,
                platform_type: true
            },
        });
        profiles.forEach((p) => applyVerticalIdentity(p.user, 'work'));
        res.json(profiles);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch professional profiles' });
    }
});

/* GET PROFESSIONAL PROFILE BY ID */
router.get('/:prof_id', async (req, res) => {
    try {
        const prof_id = Number(req.params.prof_id);
        if (Number.isNaN(prof_id)) return res.status(400).json({ error: 'prof_id must be a number' });

        const profile = await prisma.professional_profile.findUnique({
            where: { prof_id },
            include: {
                user: workerUserInclude,
                platform_type: true
            },
        });

        if (!profile) return res.status(404).json({ error: 'Professional profile not found' });
        applyVerticalIdentity(profile.user, 'work');
        res.json(profile);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch professional profile' });
    }
});

/* GET PROFESSIONAL PROFILE BY USER ID */
router.get('/user/:user_id', async (req, res) => {
    try {
        const user_id = Number(req.params.user_id);
        if (Number.isNaN(user_id)) return res.status(400).json({ error: 'user_id must be a number' });

        const profile = await prisma.professional_profile.findFirst({
            where: { user_id },
            include: {
                user: workerUserInclude,
                platform_type: true
            },
        });
        if (!profile) return res.status(404).json({ error: 'Professional profile not found' });
        // Bleed fix: surface the worker's `work` vertical identity, not their main identity.
        applyVerticalIdentity(profile.user, 'work');
        res.json(profile);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch user professional profile' });
    }
});

/* CREATE PROFESSIONAL PROFILE */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { data, errors } = parseProfileBody(req.body);
        if (errors.length) return res.status(400).json({ error: errors.join('; ') });

        const profile = await prisma.professional_profile.create({
            data: {
                // Ownership is server-derived; never trust a body user_id.
                user_id: req.user.user_id,
                headline: data.headline ?? null,
                resume_url: data.resume_url ?? null,
                open_to_work: data.open_to_work ?? false,
                platform_type_id: data.platform_type_id ?? null,
                created_at: new Date(),
            },
            include: {
                user: workerUserInclude,
                platform_type: true
            },
        });
        applyVerticalIdentity(profile.user, 'work');
        res.status(201).json(profile);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create professional profile' });
    }
});

/* UPDATE PROFESSIONAL PROFILE */
router.put('/:prof_id', authenticateToken, async (req, res) => {
    try {
        const prof_id = Number(req.params.prof_id);
        if (Number.isNaN(prof_id)) return res.status(400).json({ error: 'prof_id must be a number' });

        const existing = await prisma.professional_profile.findUnique({ where: { prof_id } });
        if (!existing) return res.status(404).json({ error: 'Professional profile not found' });
        if (existing.user_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Not authorized to modify this profile' });
        }

        const { data, errors } = parseProfileBody(req.body);
        if (errors.length) return res.status(400).json({ error: errors.join('; ') });

        const updated = await prisma.professional_profile.update({
            where: { prof_id },
            data: {
                // user_id is immutable — ownership cannot be reassigned.
                headline: data.headline ?? existing.headline,
                resume_url: data.resume_url ?? existing.resume_url,
                open_to_work: data.open_to_work ?? existing.open_to_work,
                platform_type_id: data.platform_type_id ?? existing.platform_type_id,
            },
            include: {
                user: workerUserInclude,
                platform_type: true
            },
        });
        applyVerticalIdentity(updated.user, 'work');
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update professional profile' });
    }
});

/* DELETE PROFESSIONAL PROFILE */
router.delete('/:prof_id', authenticateToken, async (req, res) => {
    try {
        const prof_id = Number(req.params.prof_id);
        if (Number.isNaN(prof_id)) return res.status(400).json({ error: 'prof_id must be a number' });

        const existing = await prisma.professional_profile.findUnique({ where: { prof_id } });
        if (!existing) return res.status(404).json({ error: 'Professional profile not found' });
        if (existing.user_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Not authorized to delete this profile' });
        }

        await prisma.professional_profile.delete({ where: { prof_id } });
        res.json({ message: 'Professional profile deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete professional profile' });
    }
});

export default router;
