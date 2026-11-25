// community-route
import express from 'express';
import multer from 'multer';
import path from 'path';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';
import { uploadPublicBlob } from '../utils/azure-storage.js';
import { getModContext, isBanned, MOD_PERMISSIONS } from '../utils/community-mod.js';

const router = express.Router();

const COMMUNITY_TYPES = ['public', 'restricted', 'private'];
const POST_TYPES = ['text', 'link', 'image', 'poll'];

// Slugify a community name into a URL handle. Strips a leading "s/", lowercases,
// collapses non-alphanumerics to a single hyphen, trims stray hyphens.
function slugify(name) {
    return String(name || '')
        .replace(/^s\//i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 30);
}

// Validate a user-supplied handle. Letters/numbers/underscore/hyphen, 3-30 chars, must
// start + end alphanumeric. Hyphens are allowed because slugify() produces them from names.
function normalizeHandle(raw) {
    const h = String(raw || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$/.test(h)) return null;
    return h;
}

// Find a free handle starting from `base`, appending -2, -3… on collision.
async function uniqueHandle(base) {
    let candidate = base || `c-${Math.random().toString(36).slice(2, 8)}`;
    if (candidate.length < 3) candidate = `c-${candidate}`;
    for (let i = 0; i < 25; i++) {
        const suffix = i === 0 ? '' : `-${i + 1}`;
        const tryHandle = `${candidate.slice(0, 30 - suffix.length)}${suffix}`;
        const existing = await prisma.community.findUnique({ where: { handle: tryHandle }, select: { community_id: true } });
        if (!existing) return tryHandle;
    }
    return `${candidate.slice(0, 22)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Image upload (banner / icon) — same pattern as vertical-profile-routes.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (/^image\//.test(file.mimetype)) return cb(null, true);
        cb(new Error('ONLY_IMAGE_UPLOADS'));
    },
});
const handleUpload = (field) => (req, res, next) =>
    upload.single(field)(req, res, (err) => {
        if (err) {
            if (err.message === 'ONLY_IMAGE_UPLOADS') return res.status(400).json({ successful: false, message: 'Only image files are allowed.' });
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ successful: false, message: 'Image must be 5MB or smaller.' });
            return res.status(400).json({ successful: false, message: 'Upload failed.' });
        }
        next();
    });

// Default communities seeded once on first GET if table is empty
const SEED = [
    { community_id: 'c1', name: 's/StrugLocal',     handle: 'struglocal',     description: 'Atlanta community — jobs, events, and local news',          category: 'Local',         color: '#2563eb', icon: 'S' },
    { community_id: 'c2', name: 's/FreelanceHub',   handle: 'freelancehub',   description: 'Tips, rates, and war stories from independent workers',       category: 'Finance',       color: '#7c3aed', icon: 'F' },
    { community_id: 'c3', name: 's/FoodScene',      handle: 'foodscene',      description: 'Restaurant reviews, recipes, and pop-up alerts',             category: 'Food',          color: '#f59e0b', icon: 'F' },
    { community_id: 'c4', name: 's/HousingMarket',  handle: 'housingmarket',  description: 'Listings, advice, and market trends in your city',           category: 'Finance',       color: '#059669', icon: 'H' },
    { community_id: 'c5', name: 's/SideHustles',    handle: 'sidehustles',    description: 'Share income ideas, gig reviews, and passive-income tips',   category: 'Finance',       color: '#dc2626', icon: 'S' },
    { community_id: 'c6', name: 's/CreativePros',   handle: 'creativepros',   description: 'Designers, writers, and artists sharing work and feedback',  category: 'Entertainment', color: '#db2777', icon: 'C' },
    { community_id: 'c7', name: 's/GadgetDrops',    handle: 'gadgetdrops',    description: 'Latest tech releases, deals, and teardown threads',          category: 'Tech',          color: '#0891b2', icon: 'G' },
    { community_id: 'c8', name: 's/WellnessCorner', handle: 'wellnesscorner', description: 'Mental health, fitness, and nutrition discussion',           category: 'Health',        color: '#65a30d', icon: 'W' },
];

async function seedIfEmpty() {
    const count = await prisma.community.count();
    if (count === 0) {
        await prisma.community.createMany({ data: SEED, skipDuplicates: true });
    }
}

// Shape a community row for the client: expose member count + membership + creator alias.
function shapeCommunity(c, { isMember } = {}) {
    return {
        ...c,
        creator_id: c.created_by,   // explicit alias so the FE owner-check never depends on field naming
        members: c._count?.members ?? (Array.isArray(c.members) ? c.members.length : c.members ?? 0),
        is_member: isMember ?? (Array.isArray(c.members) ? c.members.length > 0 : undefined),
        _count: undefined,
    };
}

// GET /community  — list all with member count + membership flag
router.get('/', authenticateToken, async (req, res) => {
    try {
        await seedIfEmpty();
        const communities = await prisma.community.findMany({
            include: {
                _count:  { select: { members: true } },
                members: { where: { user_id: req.user.user_id }, select: { user_id: true } },
            },
            orderBy: { created_at: 'asc' },
        });

        const shaped = communities.map(c => ({
            ...c,
            creator_id: c.created_by,
            members:   c._count.members || 0,
            is_member: c.members.length > 0,
            _count:    undefined,
        }));

        res.json({ successful: true, data: shaped });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to fetch communities.' });
    }
});

// GET /community/by-handle/:handle  — resolve a handle to its community (for /c/:handle routing)
router.get('/by-handle/:handle', authenticateToken, async (req, res) => {
    try {
        const handle = String(req.params.handle || '').trim().toLowerCase();
        if (!handle) return res.status(400).json({ successful: false, message: 'handle required' });
        const community = await prisma.community.findUnique({
            where: { handle },
            include: {
                _count:  { select: { members: true } },
                members: { where: { user_id: req.user.user_id }, select: { user_id: true } },
                rules:   { orderBy: { position: 'asc' } },
                flairs:  { orderBy: { created_at: 'asc' } },
            },
        });
        if (!community) return res.status(404).json({ successful: false, message: 'Community not found.' });
        const isMember = community.members.length > 0;
        const viewer = await viewerModContext(community.community_id, req.user.user_id);
        res.json({ successful: true, data: { ...shapeCommunity(community, { isMember }), ...viewer } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ successful: false, message: 'Server error.' });
    }
});

// GET /community/:id
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const community = await prisma.community.findUnique({
            where: { community_id: req.params.id },
            include: {
                _count:  { select: { members: true } },
                members: { where: { user_id: req.user.user_id }, select: { user_id: true } },
                rules:   { orderBy: { position: 'asc' } },
                flairs:  { orderBy: { created_at: 'asc' } },
            },
        });
        if (!community) return res.status(404).json({ message: 'Community not found.' });

        const isMember = community.members.length > 0;
        const isOwner  = String(community.created_by) === String(req.user.user_id);
        const viewer = await viewerModContext(community.community_id, req.user.user_id);
        // Private communities are members-only for reading. Non-members get metadata + a locked flag
        // so the FE can render a join gate rather than the feed.
        if (community.type === 'private' && !isMember && !isOwner) {
            return res.json({
                successful: true,
                locked: true,
                data: {
                    community_id: community.community_id, name: community.name, handle: community.handle,
                    description: community.description, category: community.category, color: community.color,
                    icon: community.icon, icon_url: community.icon_url, banner_url: community.banner_url,
                    type: community.type, nsfw: community.nsfw, creator_id: community.created_by,
                    members: community._count.members, is_member: false,
                },
            });
        }
        res.json({ successful: true, data: { ...shapeCommunity(community, { isMember }), ...viewer } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error.' });
    }
});

// Compute the viewer's mod standing + open-report count for a community response.
async function viewerModContext(communityId, userId) {
    const ctx = await getModContext(communityId, userId);
    let open_report_count = 0;
    if (ctx.isMod && ctx.can('manage_posts')) {
        open_report_count = await prisma.community_report.count({ where: { community_id: communityId, status: 'open' } });
    }
    return { viewer_is_owner: ctx.isOwner, viewer_is_mod: ctx.isMod, viewer_perms: ctx.perms, open_report_count };
}

// POST /community  — create
router.post('/', authenticateToken, async (req, res) => {
    const { name, description, category, color, handle, type, nsfw } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Community name is required.' });

    const communityType = COMMUNITY_TYPES.includes(type) ? type : 'public';

    // Prefer an explicit handle (validated), else slugify the name; guarantee uniqueness.
    let base;
    if (handle != null && String(handle).trim() !== '') {
        base = normalizeHandle(handle);
        if (!base) return res.status(400).json({ message: 'Handle must be 3–30 characters: letters, numbers, or underscores.' });
    } else {
        base = slugify(name);
    }

    try {
        const finalHandle = await uniqueHandle(base);
        const community = await prisma.community.create({
            data: {
                name: name.trim(),
                handle: finalHandle,
                description: description?.trim() || '',
                category: category || 'General',
                color: color || '#2563eb',
                icon: name.trim()[0].toUpperCase(),
                type: communityType,
                nsfw: !!nsfw,
                created_by: req.user.user_id,
            },
        });
        // Auto-join creator
        await prisma.community_member.create({
            data: { community_id: community.community_id, user_id: req.user.user_id },
        });
        res.status(201).json({ successful: true, data: { ...community, creator_id: community.created_by, members: 1, is_member: true } });
    } catch (err) {
        if (err.code === 'P2002') {
            const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : String(err.meta?.target || '');
            if (target.includes('handle')) return res.status(409).json({ message: 'That handle is already taken.' });
            return res.status(409).json({ message: 'A community with that name already exists.' });
        }
        console.error(err);
        res.status(500).json({ message: 'Failed to create community.' });
    }
});

// POST /community/:id/join
router.post('/:id/join', authenticateToken, async (req, res) => {
    try {
        const community = await prisma.community.findUnique({
            where: { community_id: req.params.id },
            select: { type: true, created_by: true },
        });
        if (!community) return res.status(404).json({ message: 'Community not found.' });
        // Banned users can't (re)join.
        if (await isBanned(req.params.id, req.user.user_id)) {
            return res.status(403).json({ successful: false, message: 'You are banned from this community.' });
        }
        // Private communities are invite-only — approval flow lands with moderation (#264).
        if (community.type === 'private' && String(community.created_by) !== String(req.user.user_id)) {
            return res.status(403).json({ successful: false, message: 'This community is private — you need an invite to join.' });
        }
        await prisma.community_member.create({
            data: { community_id: req.params.id, user_id: req.user.user_id },
        });
        res.json({ successful: true, joined: true });
    } catch (err) {
        if (err.code === 'P2002') {
            return res.json({ successful: true, joined: true });
        }
        console.error("CRITICAL JOIN ERROR:", err);
        res.status(500).json({ message: 'Failed to join community.' });
    }
});

// POST /community/:id/leave
router.post('/:id/leave', authenticateToken, async (req, res) => {
    try {
        await prisma.community_member.delete({
            where: {
                community_id_user_id: {
                    community_id: req.params.id,
                    user_id: req.user.user_id,
                },
            },
        });
        res.json({ successful: true, joined: false });
    } catch {
        res.json({ successful: true, joined: false }); // not a member — idempotent
    }
});

router.get('/:id/is-member', authenticateToken, async (req, res) => {
    const isMember = await prisma.community_member.findUnique({
        where: { community_id_user_id: { community_id: req.params.id, user_id: req.user.user_id } }
    });
    res.json({ joined: !!isMember });
});

// Shared owner-guard: returns the community if the caller owns it, else sends the error response.
async function requireOwner(req, res) {
    const community = await prisma.community.findUnique({ where: { community_id: req.params.id } });
    if (!community) { res.status(404).json({ message: 'Not found.' }); return null; }
    if (String(community.created_by) !== String(req.user.user_id)) { res.status(403).json({ message: 'Not authorized.' }); return null; }
    return community;
}

// PUT /community/:id  — legacy name/description edit (kept for existing FE callers)
router.put('/:id', authenticateToken, async (req, res) => {
    const { name, description } = req.body;
    try {
        const community = await requireOwner(req, res);
        if (!community) return;
        const updated = await prisma.community.update({
            where: { community_id: req.params.id },
            data: {
                name:        name?.trim()        || community.name,
                description: description?.trim() ?? community.description,
            },
        });
        res.json({ successful: true, data: { ...updated, creator_id: updated.created_by } });
    } catch (err) {
        if (err.code === 'P2002')
            return res.status(409).json({ message: 'A community with that name already exists.' });
        console.error(err);
        res.status(500).json({ message: 'Failed to update community.' });
    }
});

// PATCH /community/:id/customize  — owner customization: type, nsfw, accent color, handle,
// description, and pinned posts (up to 2).
router.patch('/:id/customize', authenticateToken, async (req, res) => {
    try {
        const community = await requireOwner(req, res);
        if (!community) return;

        const data = {};
        const { description, color, type, nsfw, handle, pinned_post_ids, allowed_post_types, require_flair } = req.body;

        if (description !== undefined) data.description = String(description).trim();
        if (color !== undefined && /^#[0-9a-fA-F]{6}$/.test(String(color))) data.color = String(color);
        if (type !== undefined) {
            if (!COMMUNITY_TYPES.includes(type)) return res.status(400).json({ message: 'Invalid community type.' });
            data.type = type;
        }
        if (nsfw !== undefined) data.nsfw = !!nsfw;
        if (handle !== undefined) {
            const norm = normalizeHandle(handle);
            if (!norm) return res.status(400).json({ message: 'Handle must be 3–30 characters: letters, numbers, or underscores.' });
            if (norm !== community.handle) {
                const taken = await prisma.community.findUnique({ where: { handle: norm }, select: { community_id: true } });
                if (taken) return res.status(409).json({ message: 'That handle is already taken.' });
                data.handle = norm;
            }
        }
        if (pinned_post_ids !== undefined) {
            if (!Array.isArray(pinned_post_ids)) return res.status(400).json({ message: 'pinned_post_ids must be an array.' });
            const ids = pinned_post_ids.map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n)).slice(0, 2);
            data.pinned_post_ids = ids;
        }
        if (allowed_post_types !== undefined) {
            if (!Array.isArray(allowed_post_types)) return res.status(400).json({ message: 'allowed_post_types must be an array.' });
            const types = allowed_post_types.filter(t => POST_TYPES.includes(t));
            data.allowed_post_types = types.length ? types : ['text'];
        }
        if (require_flair !== undefined) data.require_flair = !!require_flair;

        const updated = await prisma.community.update({ where: { community_id: req.params.id }, data });
        res.json({ successful: true, data: { ...updated, creator_id: updated.created_by } });
    } catch (err) {
        if (err.code === 'P2002') return res.status(409).json({ message: 'That handle is already taken.' });
        console.error(err);
        res.status(500).json({ message: 'Failed to update community.' });
    }
});

// Shared image-upload handler for banner / icon.
async function uploadCommunityImage(req, res, field) {
    const community = await requireOwner(req, res);
    if (!community) return;
    if (!req.file) return res.status(400).json({ successful: false, message: 'No file uploaded.' });

    const ext = path.extname(req.file.originalname) || '.jpg';
    const blobName = `community-${field}-${community.community_id}-${Date.now()}${ext}`;
    const url = await uploadPublicBlob(
        process.env.AZURE_SOCIAL_POSTS_CONTAINER,
        blobName,
        req.file.buffer,
        req.file.mimetype,
    );
    const column = field === 'banner' ? 'banner_url' : 'icon_url';
    const updated = await prisma.community.update({ where: { community_id: community.community_id }, data: { [column]: url } });
    return res.json({ successful: true, [column]: url, data: { ...updated, creator_id: updated.created_by } });
}

// PATCH /community/:id/banner  and  /community/:id/icon  — owner image uploads
router.patch('/:id/banner', authenticateToken, handleUpload('banner'), (req, res, next) =>
    uploadCommunityImage(req, res, 'banner').catch(next));
router.patch('/:id/icon', authenticateToken, handleUpload('icon'), (req, res, next) =>
    uploadCommunityImage(req, res, 'icon').catch(next));

// DELETE /community/:id  — cascade-safe version
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const community = await requireOwner(req, res);
        if (!community) return;

        await prisma.$transaction(async (tx) => {
            const posts = await tx.community_posts.findMany({
                where:  { community_id: req.params.id },
                select: { community_post_id: true },
            });
            const postIds = posts.map(p => p.community_post_id);

            if (postIds.length > 0) {
                await tx.community_post_comment.deleteMany({ where: { post_id: { in: postIds } } });
                await tx.community_post_vote.deleteMany({ where: { post_id: { in: postIds } } });
                await tx.community_post_save.deleteMany({ where: { post_id: { in: postIds } } });
                await tx.community_posts.deleteMany({ where: { community_post_id: { in: postIds } } });
            }

            await tx.community_member.deleteMany({ where: { community_id: req.params.id } });
            await tx.community.delete({ where: { community_id: req.params.id } });
        });

        res.json({ successful: true });
    } catch (err) {
        console.error('Delete community error:', err);
        res.status(500).json({ message: 'Failed to delete.' });
    }
});

// ── Rules ────────────────────────────────────────────────────────────────────
// GET /community/:id/rules
router.get('/:id/rules', authenticateToken, async (req, res) => {
    try {
        const rules = await prisma.community_rule.findMany({
            where: { community_id: req.params.id },
            orderBy: { position: 'asc' },
        });
        res.json({ successful: true, data: rules });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to fetch rules.' });
    }
});

// PUT /community/:id/rules  — owner replace-all. Body: { rules: [{ title, description }] } (max 15)
router.put('/:id/rules', authenticateToken, async (req, res) => {
    try {
        const community = await requireOwner(req, res);
        if (!community) return;
        const incoming = Array.isArray(req.body.rules) ? req.body.rules : [];
        const clean = incoming
            .map((r, i) => ({ title: String(r.title || '').trim(), description: r.description != null ? String(r.description).trim() : null, position: i }))
            .filter(r => r.title)
            .slice(0, 15);

        await prisma.$transaction([
            prisma.community_rule.deleteMany({ where: { community_id: req.params.id } }),
            ...(clean.length ? [prisma.community_rule.createMany({ data: clean.map(r => ({ ...r, community_id: req.params.id })) })] : []),
        ]);
        const rules = await prisma.community_rule.findMany({ where: { community_id: req.params.id }, orderBy: { position: 'asc' } });
        res.json({ successful: true, data: rules });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to update rules.' });
    }
});

// ── Flair ────────────────────────────────────────────────────────────────────
// GET /community/:id/flair
router.get('/:id/flair', authenticateToken, async (req, res) => {
    try {
        const flairs = await prisma.community_flair.findMany({
            where: { community_id: req.params.id },
            orderBy: { created_at: 'asc' },
        });
        res.json({ successful: true, data: flairs });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to fetch flair.' });
    }
});

// PUT /community/:id/flair  — owner diff-update (preserves flair_id so tagged posts keep their flair).
// Body: { flairs: [{ flair_id?, label, color }] } (max 20)
router.put('/:id/flair', authenticateToken, async (req, res) => {
    try {
        const community = await requireOwner(req, res);
        if (!community) return;
        const incoming = (Array.isArray(req.body.flairs) ? req.body.flairs : [])
            .map(f => ({ flair_id: f.flair_id ? parseInt(f.flair_id, 10) : null, label: String(f.label || '').trim(), color: /^#[0-9a-fA-F]{6}$/.test(String(f.color)) ? f.color : '#2563eb' }))
            .filter(f => f.label)
            .slice(0, 20);

        const existing = await prisma.community_flair.findMany({ where: { community_id: req.params.id }, select: { flair_id: true } });
        const keepIds = incoming.filter(f => f.flair_id).map(f => f.flair_id);
        const toDelete = existing.filter(e => !keepIds.includes(e.flair_id)).map(e => e.flair_id);

        await prisma.$transaction([
            ...(toDelete.length ? [prisma.community_flair.deleteMany({ where: { flair_id: { in: toDelete } } })] : []),
            ...incoming.filter(f => f.flair_id).map(f => prisma.community_flair.update({ where: { flair_id: f.flair_id }, data: { label: f.label, color: f.color } })),
            ...incoming.filter(f => !f.flair_id).map(f => prisma.community_flair.create({ data: { community_id: req.params.id, label: f.label, color: f.color } })),
        ]);
        const flairs = await prisma.community_flair.findMany({ where: { community_id: req.params.id }, orderBy: { created_at: 'asc' } });
        res.json({ successful: true, data: flairs });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to update flair.' });
    }
});

// ── Moderation team, bans, reports (#264/#268) ───────────────────────────────

// Look up users by ids → minimal public display shape keyed by user_id.
async function usersById(ids) {
    const clean = [...new Set(ids.filter(Boolean))];
    if (!clean.length) return {};
    // social_profiles is a to-ONE relation (social_profile?) — no `take`, accessed as an object.
    const users = await prisma.user.findMany({
        where: { user_id: { in: clean } },
        select: { user_id: true, username: true, social_profiles: { select: { handle: true, display_name: true, profile_pic_url: true } } },
    });
    return Object.fromEntries(users.map(u => {
        const sp = u.social_profiles;
        return [u.user_id, {
            user_id: u.user_id,
            username: u.username,
            handle: sp?.handle ?? u.username,
            display_name: sp?.display_name ?? u.username,
            profile_pic_url: sp?.profile_pic_url ?? null,
        }];
    }));
}

// Guard: require the caller to be owner/mod with a given permission.
async function requireMod(req, res, permission) {
    const ctx = await getModContext(req.params.id, req.user.user_id);
    if (!ctx.exists) { res.status(404).json({ message: 'Community not found.' }); return null; }
    if (!ctx.isMod || (permission && !ctx.can(permission))) { res.status(403).json({ message: 'Moderator permission required.' }); return null; }
    return ctx;
}

// GET /community/:id/moderators — the mod team (owner + mods)
router.get('/:id/moderators', authenticateToken, async (req, res) => {
    try {
        const community = await prisma.community.findUnique({ where: { community_id: req.params.id }, select: { created_by: true } });
        if (!community) return res.status(404).json({ message: 'Community not found.' });
        const mods = await prisma.community_moderator.findMany({ where: { community_id: req.params.id }, orderBy: { created_at: 'asc' } });
        const umap = await usersById([community.created_by, ...mods.map(m => m.user_id)]);
        const roster = [];
        if (community.created_by) roster.push({ user: umap[community.created_by] || { user_id: community.created_by }, permissions: ['all'], is_owner: true });
        for (const m of mods) roster.push({ user: umap[m.user_id] || { user_id: m.user_id }, permissions: m.permissions, is_owner: false, added_at: m.created_at });
        res.json({ successful: true, data: roster });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to fetch moderators.' }); }
});

// POST /community/:id/moderators — add a mod by username. Owner/manage_users.
router.post('/:id/moderators', authenticateToken, async (req, res) => {
    try {
        const ctx = await requireMod(req, res, 'manage_users'); if (!ctx) return;
        const { username, permissions } = req.body;
        if (!username?.trim()) return res.status(400).json({ message: 'Username is required.' });
        const target = await prisma.user.findFirst({ where: { username: username.trim() }, select: { user_id: true } });
        if (!target) return res.status(404).json({ message: 'User not found.' });
        if (String(target.user_id) === String(ctx.created_by)) return res.status(400).json({ message: 'The owner is already a moderator.' });
        const perms = Array.isArray(permissions) ? permissions.filter(p => MOD_PERMISSIONS.includes(p)) : ['all'];
        const mod = await prisma.community_moderator.upsert({
            where: { community_id_user_id: { community_id: req.params.id, user_id: target.user_id } },
            create: { community_id: req.params.id, user_id: target.user_id, permissions: perms.length ? perms : ['all'], added_by: req.user.user_id },
            update: { permissions: perms.length ? perms : ['all'] },
        });
        res.status(201).json({ successful: true, data: mod });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to add moderator.' }); }
});

// PATCH /community/:id/moderators/:userId — update permissions. Owner/manage_users.
router.patch('/:id/moderators/:userId', authenticateToken, async (req, res) => {
    try {
        const ctx = await requireMod(req, res, 'manage_users'); if (!ctx) return;
        const userId = parseInt(req.params.userId, 10);
        const perms = Array.isArray(req.body.permissions) ? req.body.permissions.filter(p => MOD_PERMISSIONS.includes(p)) : null;
        if (!perms) return res.status(400).json({ message: 'permissions must be an array.' });
        const mod = await prisma.community_moderator.update({
            where: { community_id_user_id: { community_id: req.params.id, user_id: userId } },
            data: { permissions: perms.length ? perms : ['all'] },
        }).catch(() => null);
        if (!mod) return res.status(404).json({ message: 'Moderator not found.' });
        res.json({ successful: true, data: mod });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to update moderator.' }); }
});

// DELETE /community/:id/moderators/:userId — remove a mod. Owner/manage_users.
router.delete('/:id/moderators/:userId', authenticateToken, async (req, res) => {
    try {
        const ctx = await requireMod(req, res, 'manage_users'); if (!ctx) return;
        await prisma.community_moderator.deleteMany({ where: { community_id: req.params.id, user_id: parseInt(req.params.userId, 10) } });
        res.json({ successful: true });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to remove moderator.' }); }
});

// GET /community/:id/bans — mod list
router.get('/:id/bans', authenticateToken, async (req, res) => {
    try {
        const ctx = await requireMod(req, res, 'manage_users'); if (!ctx) return;
        const bans = await prisma.community_ban.findMany({ where: { community_id: req.params.id }, orderBy: { created_at: 'desc' } });
        const umap = await usersById(bans.map(b => b.user_id));
        res.json({ successful: true, data: bans.map(b => ({ ...b, user: umap[b.user_id] || { user_id: b.user_id } })) });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to fetch bans.' }); }
});

// POST /community/:id/ban — ban a user (by username or user_id). Owner/manage_users.
router.post('/:id/ban', authenticateToken, async (req, res) => {
    try {
        const ctx = await requireMod(req, res, 'manage_users'); if (!ctx) return;
        const { username, user_id, reason, expires_at } = req.body;
        let targetId = user_id ? parseInt(user_id, 10) : null;
        if (!targetId && username?.trim()) {
            const u = await prisma.user.findFirst({ where: { username: username.trim() }, select: { user_id: true } });
            if (!u) return res.status(404).json({ message: 'User not found.' });
            targetId = u.user_id;
        }
        if (!targetId) return res.status(400).json({ message: 'A username or user_id is required.' });
        if (String(targetId) === String(ctx.created_by)) return res.status(400).json({ message: 'You cannot ban the owner.' });
        if (String(targetId) === String(req.user.user_id)) return res.status(400).json({ message: 'You cannot ban yourself.' });

        const ban = await prisma.community_ban.upsert({
            where: { community_id_user_id: { community_id: req.params.id, user_id: targetId } },
            create: { community_id: req.params.id, user_id: targetId, banned_by: req.user.user_id, reason: reason?.trim() || null, expires_at: expires_at ? new Date(expires_at) : null },
            update: { reason: reason?.trim() || null, expires_at: expires_at ? new Date(expires_at) : null, banned_by: req.user.user_id },
        });
        // Remove from members + strip any mod role.
        await prisma.community_member.deleteMany({ where: { community_id: req.params.id, user_id: targetId } });
        await prisma.community_moderator.deleteMany({ where: { community_id: req.params.id, user_id: targetId } });
        res.status(201).json({ successful: true, data: ban });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to ban user.' }); }
});

// DELETE /community/:id/bans/:userId — unban. Owner/manage_users.
router.delete('/:id/bans/:userId', authenticateToken, async (req, res) => {
    try {
        const ctx = await requireMod(req, res, 'manage_users'); if (!ctx) return;
        await prisma.community_ban.deleteMany({ where: { community_id: req.params.id, user_id: parseInt(req.params.userId, 10) } });
        res.json({ successful: true });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to unban.' }); }
});

// POST /community/:id/report — any authenticated user reports a post/comment/user.
router.post('/:id/report', authenticateToken, async (req, res) => {
    try {
        const community = await prisma.community.findUnique({ where: { community_id: req.params.id }, select: { community_id: true } });
        if (!community) return res.status(404).json({ message: 'Community not found.' });
        const { target_type, post_id, comment_id, target_user_id, reason } = req.body;
        if (!['post', 'comment', 'user'].includes(target_type)) return res.status(400).json({ message: 'Invalid target type.' });
        if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) return res.status(400).json({ message: 'A reason (1-1000 chars) is required.' });
        const report = await prisma.community_report.create({
            data: {
                community_id: req.params.id, reporter_id: req.user.user_id, target_type, reason: reason.trim(),
                post_id: post_id ? parseInt(post_id, 10) : null,
                comment_id: comment_id ? parseInt(comment_id, 10) : null,
                target_user_id: target_user_id ? parseInt(target_user_id, 10) : null,
            },
        });
        res.status(201).json({ successful: true, data: { id: report.id } });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to submit report.' }); }
});

// GET /community/:id/reports — mod queue. Owner/manage_posts.
router.get('/:id/reports', authenticateToken, async (req, res) => {
    try {
        const ctx = await requireMod(req, res, 'manage_posts'); if (!ctx) return;
        const status = req.query.status || 'open';
        const reports = await prisma.community_report.findMany({
            where: { community_id: req.params.id, ...(status === 'all' ? {} : { status }) },
            orderBy: { created_at: 'desc' }, take: 100,
        });
        const postIds = reports.filter(r => r.post_id).map(r => r.post_id);
        const commentIds = reports.filter(r => r.comment_id).map(r => r.comment_id);
        const userIds = reports.flatMap(r => [r.reporter_id, r.target_user_id]);
        const [posts, comments, umap] = await Promise.all([
            postIds.length ? prisma.community_posts.findMany({ where: { community_post_id: { in: postIds } }, select: { community_post_id: true, title: true, content: true, is_removed: true, user_id: true } }) : [],
            commentIds.length ? prisma.community_post_comment.findMany({ where: { comment_id: { in: commentIds } }, select: { comment_id: true, content: true, user_id: true } }) : [],
            usersById(userIds),
        ]);
        const pmap = Object.fromEntries(posts.map(p => [p.community_post_id, p]));
        const cmap = Object.fromEntries(comments.map(c => [c.comment_id, c]));
        res.json({ successful: true, data: reports.map(r => ({
            ...r,
            reporter: umap[r.reporter_id] || { user_id: r.reporter_id },
            target_user: r.target_user_id ? (umap[r.target_user_id] || { user_id: r.target_user_id }) : null,
            post: r.post_id ? pmap[r.post_id] || null : null,
            comment: r.comment_id ? cmap[r.comment_id] || null : null,
        })) });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to fetch reports.' }); }
});

// PATCH /community/:id/reports/:reportId — resolve. Owner/manage_posts.
router.patch('/:id/reports/:reportId', authenticateToken, async (req, res) => {
    try {
        const ctx = await requireMod(req, res, 'manage_posts'); if (!ctx) return;
        const status = req.body.status;
        if (!['actioned', 'dismissed', 'open'].includes(status)) return res.status(400).json({ message: 'Invalid status.' });
        const updated = await prisma.community_report.updateMany({
            where: { id: parseInt(req.params.reportId, 10), community_id: req.params.id },
            data: { status, resolved_by: req.user.user_id },
        });
        if (!updated.count) return res.status(404).json({ message: 'Report not found.' });
        res.json({ successful: true });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to resolve report.' }); }
});

// ── Awards & karma (#267) ────────────────────────────────────────────────────

// GET /community/:id/awards — platform-wide awards + this community's custom awards
router.get('/:id/awards', authenticateToken, async (req, res) => {
    try {
        const awards = await prisma.community_award.findMany({
            where: { OR: [{ community_id: null }, { community_id: req.params.id }] },
            orderBy: { award_id: 'asc' },
        });
        res.json({ successful: true, data: awards });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to fetch awards.' }); }
});

// Karma = aggregate upvotes on a user's community posts + comments.
async function karmaFor(userId) {
    const [postAgg, commentAgg] = await Promise.all([
        prisma.community_posts.aggregate({ where: { user_id: userId }, _sum: { upvotes: true }, _count: true }),
        prisma.community_post_comment.aggregate({ where: { user_id: userId }, _sum: { upvotes: true }, _count: true }),
    ]);
    const post_karma = postAgg._sum.upvotes || 0;
    const comment_karma = commentAgg._sum.upvotes || 0;
    return { post_karma, comment_karma, total: post_karma + comment_karma, post_count: postAgg._count, comment_count: commentAgg._count };
}

// GET /community/karma/me  and  /community/karma/:userId
router.get('/karma/me', authenticateToken, async (req, res) => {
    try { res.json({ successful: true, data: await karmaFor(req.user.user_id) }); }
    catch (err) { console.error(err); res.status(500).json({ message: 'Failed to fetch karma.' }); }
});
router.get('/karma/:userId', authenticateToken, async (req, res) => {
    try {
        const uid = parseInt(req.params.userId, 10);
        if (Number.isNaN(uid)) return res.status(400).json({ message: 'Invalid user id.' });
        res.json({ successful: true, data: await karmaFor(uid) });
    } catch (err) { console.error(err); res.status(500).json({ message: 'Failed to fetch karma.' }); }
});

// ── Community admin analytics (#269) ─────────────────────────────────────────
// GET /community/:id/analytics — owner/mod stats dashboard. Aggregates over existing
// tables (members / posts / comments / votes) — no dedicated analytics storage.
const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (d) => {
    const dt = new Date(d);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

router.get('/:id/analytics', authenticateToken, async (req, res) => {
    try {
        const ctx = await requireMod(req, res, 'manage_settings'); if (!ctx) return;
        const communityId = req.params.id;
        const now = Date.now();

        // 30 daily buckets ending today (UTC calendar days). dayKey strings sort lexicographically.
        const days = Array.from({ length: 30 }, (_, i) => dayKey(new Date(now - (29 - i) * DAY_MS)));
        const firstDayKey = days[0];
        const inWindow = (d) => dayKey(d) >= firstDayKey;

        const [posts, members] = await Promise.all([
            prisma.community_posts.findMany({
                where: { community_id: communityId },
                select: {
                    community_post_id: true, title: true, content: true, upvotes: true,
                    created_at: true, is_removed: true, user_id: true,
                    _count: { select: { comments: true } },
                },
            }),
            prisma.community_member.findMany({
                where: { community_id: communityId },
                select: { user_id: true, joined_at: true },
            }),
        ]);
        const livePosts = posts.filter(p => !p.is_removed);
        const postIds = posts.map(p => p.community_post_id);

        // Comments + votes key on post_id, so scope them by this community's post ids.
        const [comments, upVotes, downVotes] = postIds.length
            ? await Promise.all([
                prisma.community_post_comment.findMany({
                    where: { post_id: { in: postIds } },
                    select: { user_id: true, created_at: true },
                }),
                prisma.community_post_vote.count({ where: { post_id: { in: postIds }, vote_type: 1 } }),
                prisma.community_post_vote.count({ where: { post_id: { in: postIds }, vote_type: -1 } }),
            ])
            : [[], 0, 0];

        // Daily series — posts, comments, new members, cumulative members (growth).
        const postByDay = {}, commentByDay = {}, memberByDay = {};
        livePosts.forEach(p => { const k = dayKey(p.created_at); if (k >= firstDayKey) postByDay[k] = (postByDay[k] || 0) + 1; });
        comments.forEach(c => { const k = dayKey(c.created_at); if (k >= firstDayKey) commentByDay[k] = (commentByDay[k] || 0) + 1; });
        members.forEach(m => { const k = dayKey(m.joined_at); if (k >= firstDayKey) memberByDay[k] = (memberByDay[k] || 0) + 1; });

        let cumulative = members.filter(m => dayKey(m.joined_at) < firstDayKey).length; // members before the window
        const series = days.map(k => {
            const joined = memberByDay[k] || 0;
            cumulative += joined;
            return { date: k, posts: postByDay[k] || 0, comments: commentByDay[k] || 0, new_members: joined, total_members: cumulative };
        });

        // Overview headline stats (window = last 30 calendar days).
        const activeIds = new Set();
        livePosts.forEach(p => { if (inWindow(p.created_at)) activeIds.add(p.user_id); });
        comments.forEach(c => { if (inWindow(c.created_at)) activeIds.add(c.user_id); });

        const totalPosts = livePosts.length;
        const totalComments = comments.length;
        const totalUpvotes = livePosts.reduce((s, p) => s + (p.upvotes || 0), 0);
        const totalVotes = upVotes + downVotes;
        const round1 = (n) => Math.round(n * 10) / 10;

        const overview = {
            members: members.length,
            new_members_30d: members.filter(m => inWindow(m.joined_at)).length,
            active_users_30d: activeIds.size,
            total_posts: totalPosts,
            posts_30d: livePosts.filter(p => inWindow(p.created_at)).length,
            total_comments: totalComments,
            comments_30d: comments.filter(c => inWindow(c.created_at)).length,
            total_upvotes: totalUpvotes,
            upvote_rate: totalVotes ? Math.round((upVotes / totalVotes) * 100) : null, // % of cast votes that are upvotes
            avg_upvotes_per_post: totalPosts ? round1(totalUpvotes / totalPosts) : 0,
            avg_comments_per_post: totalPosts ? round1(totalComments / totalPosts) : 0,
        };

        // Top posts by score (upvotes, tie-break comments).
        const top_posts = [...livePosts]
            .sort((a, b) => (b.upvotes - a.upvotes) || (b._count.comments - a._count.comments))
            .slice(0, 5)
            .map(p => ({
                id: p.community_post_id,
                title: p.title || (p.content || '').slice(0, 80) || 'Untitled',
                upvotes: p.upvotes,
                comments: p._count.comments,
                created_at: p.created_at,
            }));

        res.json({ successful: true, data: { overview, series, top_posts } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Failed to fetch analytics.' });
    }
});

export default router;
