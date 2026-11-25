import express from 'express';
import multer from 'multer';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { uploadPublicBlob, isTrustedBlobUrl } from '../utils/azure-storage.js';
import { validateMime, ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES } from '../utils/validate-mime.js';
import { areUsersBlockedOnPlatform } from '../utils/platform-blocks.js';

const router = express.Router();
const STORIES_CONTAINER = process.env.AZURE_SOCIAL_STORIES_CONTAINER || 'social-stories';
const ALLOWED_STORY_MEDIA = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES];
const ALLOWED_STORY_AUDIO = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg'];

function isAllowedHighlightCoverUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  if (!trimmed) return true; // clear cover
  return isTrustedBlobUrl(trimmed, STORIES_CONTAINER);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB cap — prevents unbounded in-memory buffering
  fileFilter: (req, file, cb) => {
    if (/^(image|video|audio)\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type'));
  },
});

/**
 * @route   POST /social-story/upload
 * @desc    Upload a new ephemeral story (24h)
 */
router.post('/upload', authenticateToken, upload.fields([{ name: 'media', maxCount: 1 }, { name: 'music', maxCount: 1 }]), async (req, res, next) => {
    try {
        const profile_id = req.user.profile_id;
        if (!profile_id) return res.status(400).json({ successful: false, message: "Social profile not found." });

        const mediaFile = req.files?.media?.[0];
        const musicFile = req.files?.music?.[0];
        if (!mediaFile) return res.status(400).json({ successful: false, message: "Media is required." });

        let mediaMeta;
        try {
            mediaMeta = await validateMime(mediaFile.buffer, ALLOWED_STORY_MEDIA);
        } catch (mimeErr) {
            return res.status(400).json({ successful: false, message: mimeErr.message || 'Invalid media type.' });
        }

        const isVideo = mediaMeta.mime.startsWith('video');
        const ext = mediaMeta.ext || mediaFile.originalname?.split('.').pop() || (isVideo ? 'mp4' : 'jpg');
        const blobName = `stories/${profile_id}/${Date.now()}.${ext}`;
        const azureUrl = await uploadPublicBlob(
            STORIES_CONTAINER,
            blobName,
            mediaFile.buffer,
            mediaMeta.mime
        );

        // Optional background music (uploaded audio attached to the story).
        let musicUrl = null;
        if (musicFile) {
            let musicMeta;
            try {
                musicMeta = await validateMime(musicFile.buffer, ALLOWED_STORY_AUDIO);
            } catch (mimeErr) {
                return res.status(400).json({ successful: false, message: mimeErr.message || 'Invalid audio type.' });
            }
            const mExt = musicMeta.ext || musicFile.originalname?.split('.').pop() || 'mp3';
            const musicBlob = `stories/${profile_id}/music_${Date.now()}.${mExt}`;
            musicUrl = await uploadPublicBlob(
                STORIES_CONTAINER,
                musicBlob,
                musicFile.buffer,
                musicMeta.mime
            );
        }

        const expiryDate = new Date();
        expiryDate.setHours(expiryDate.getHours() + 24);

        const newStory = await prisma.social_story.create({
            data: {
                profile_id,
                media_url: azureUrl,
                media_type: isVideo ? 'video' : 'image',
                music_url: musicUrl,
                music_title: musicUrl ? (req.body.music_title?.slice(0, 255) || null) : null,
                expires_at: expiryDate
            }
        });

        res.status(201).json({ successful: true, data: newStory });
    } catch (err) { next(err); }
});

/**
 * @route   GET /social-story/feed
 * @desc    Get stories from following users (Grouped by Profile)
 */
router.get('/feed', authenticateToken, async (req, res) => {
    try {
        const my_profile_id = req.user.profile_id;
        if (!my_profile_id) return res.status(400).json({ message: "Profile setup required." });

        const following = await prisma.follower.findMany({
            where: { follower_id: my_profile_id, status: 'accepted' },
            select: { following_id: true }
        });

        const allowedIds = [my_profile_id, ...following.map(f => f.following_id)];

        const stories = await prisma.social_story.findMany({
            where: { profile_id: { in: allowedIds }, 
                    expires_at: { gt: new Date() }
        },
            include: {
                social_profile: { select: { profile_id: true, handle: true, display_name: true, profile_pic_url: true, is_verified: true } },
                views: { where: { profile_id: my_profile_id } }
            },
            orderBy: { created_at: 'desc' }
        });

        // FIX: Yahan groupedStories logic define karo
        const groupedStories = stories.reduce((acc, story) => {
            if (!acc[story.profile_id]) {
                acc[story.profile_id] = {
                    profile: story.social_profile,
                    hasUnseen: false, // Default
                    stories: []
                };
            }
            
            // Agar view nahi kiya toh hasUnseen true ho jayega
            if (story.views.length === 0) acc[story.profile_id].hasUnseen = true;
            
            acc[story.profile_id].stories.push({
                story_id: story.story_id,
                media_url: story.media_url,
                media_type: story.media_type,
                music_url: story.music_url,
                music_title: story.music_title,
                created_at: story.created_at
            });
            return acc;
        }, {});

        res.json({ successful: true, data: Object.values(groupedStories) });
    } catch (err) { 
        console.error("❌ Story Feed Error:", err); // Log add kiya taaki error dikhe
        res.status(500).json({ successful: false, message: 'Internal server error' }); 
    }
});
/**
 * @route   POST /social-story/:id/view
 */
router.post('/:id/view', authenticateToken, async (req, res) => {
    try {
        const story_id = parseInt(req.params.id);
        const viewer_profile_id = req.user.profile_id;

        await prisma.story_view.upsert({
            where: { story_id_profile_id: { story_id, profile_id: viewer_profile_id } },
            update: {},
            create: { story_id, profile_id: viewer_profile_id }
        });

        res.json({ successful: true });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});


/**
 * 4. GET STORY VIEWERS (Owner Only)
 * GET /social-story/:id/viewers
 */
router.get('/:id/viewers', authenticateToken, async (req, res) => {
    try {
        const story_id = parseInt(req.params.id);
        const my_profile_id = req.user.profile_id;

       
        const story = await prisma.social_story.findUnique({
            where: { story_id },
            select: { profile_id: true }
        });

        if (!story || story.profile_id !== my_profile_id) {
            return res.status(403).json({ successful: false, message: "Unauthorized to view these analytics." });
        }

        const viewers = await prisma.story_view.findMany({
            where: { story_id },
            include: {
                viewer: {
                    select: { profile_id: true, handle: true, display_name: true, profile_pic_url: true, is_verified: true }
                }
            },
            orderBy: { viewed_at: 'desc' }
        });

        res.json({ successful: true, data: viewers.map(v => ({ ...v.viewer, viewed_at: v.viewed_at })) });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * GET /social-story/archive
 * The requester's OWN stories — INCLUDING expired ones — so the highlight editor can offer both
 * the live story ring and the permanent archive to pick from. Each row carries which highlight it
 * currently sits in (highlight_id) so the picker can show what's already curated.
 */
router.get('/archive', authenticateToken, async (req, res) => {
    try {
        const profile_id = req.user.profile_id;
        if (!profile_id) return res.status(400).json({ successful: false, message: "Social profile not found." });

        const stories = await prisma.social_story.findMany({
            where: { profile_id },
            select: {
                story_id: true, media_url: true, media_type: true,
                music_url: true, music_title: true, created_at: true,
                expires_at: true, highlight_id: true
            },
            orderBy: { created_at: 'desc' }
        });

        const now = new Date();
        res.json({
            successful: true,
            data: stories.map(s => ({ ...s, is_active: s.expires_at > now }))
        });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

// --- HIGHLIGHTS LOGIC ---

/**
 * Upload a cover image for a highlight into the social-stories container and return its URL.
 * Mirrors the story-media upload path. Returns null when no file was attached.
 */
async function uploadCover(profile_id, coverFile) {
    if (!coverFile) return null;
    let meta;
    try {
        meta = await validateMime(coverFile.buffer, ALLOWED_IMAGE_TYPES);
    } catch (mimeErr) {
        throw Object.assign(new Error(mimeErr.message || 'Invalid cover image type.'), { status: 400 });
    }
    const ext = meta.ext || coverFile.originalname?.split('.').pop() || 'jpg';
    const blobName = `highlights/${profile_id}/${Date.now()}.${ext}`;
    return uploadPublicBlob(
        STORIES_CONTAINER,
        blobName,
        coverFile.buffer,
        meta.mime
    );
}

/**
 * Accepts story_ids from either JSON (array) or multipart (a JSON-encoded string / repeated field)
 * and returns a clean array of positive integers.
 */
function parseStoryIds(raw) {
    if (raw == null) return [];
    let arr = raw;
    if (typeof raw === 'string') {
        try { arr = JSON.parse(raw); } catch { arr = raw.split(','); }
    }
    if (!Array.isArray(arr)) arr = [arr];
    return arr.map(id => parseInt(id)).filter(id => Number.isInteger(id) && id > 0);
}

/**
 * 5. CREATE NEW HIGHLIGHT
 * POST /social-story/highlight/create
 * Accepts a multipart cover file ('cover') OR a cover_url string. New highlights are appended
 * after the profile's current max sort_order.
 */
router.post('/highlight/create', authenticateToken, upload.single('cover'), async (req, res) => {
    try {
        const profile_id = req.user.profile_id;
        if (!profile_id) return res.status(400).json({ successful: false, message: "Social profile not found." });

        const title = (req.body.title || '').trim();
        const story_ids = parseStoryIds(req.body.story_ids);

        if (!title) return res.status(400).json({ successful: false, message: "Title is required." });
        if (title.length > 50) return res.status(400).json({ successful: false, message: "Title must be 50 characters or fewer." });

        const uploadedCover = await uploadCover(profile_id, req.file);
        let coverUrl = uploadedCover || null;
        if (!uploadedCover && typeof req.body.cover_url === 'string' && req.body.cover_url.trim()) {
            if (!isAllowedHighlightCoverUrl(req.body.cover_url)) {
                return res.status(400).json({ successful: false, message: "cover_url must be a trusted stories blob URL." });
            }
            coverUrl = req.body.cover_url.trim();
        }

        const result = await prisma.$transaction(async (tx) => {
            const last = await tx.social_highlight.findFirst({
                where: { profile_id },
                orderBy: { sort_order: 'desc' },
                select: { sort_order: true }
            });

            const highlight = await tx.social_highlight.create({
                data: {
                    profile_id,
                    title,
                    cover_url: coverUrl,
                    sort_order: (last?.sort_order ?? -1) + 1
                }
            });

            if (story_ids.length) {
                // profile_id filter guarantees a user can only pull their OWN stories into a highlight.
                await tx.social_story.updateMany({
                    where: { story_id: { in: story_ids }, profile_id },
                    data: { highlight_id: highlight.highlight_id }
                });
            }

            return highlight;
        });

        res.status(201).json({ successful: true, data: result });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 6. GET ALL HIGHLIGHTS OF A PROFILE
 * GET /social-story/highlight/profile/:profile_id
 * Public (mirrors the other read routes). Ordered by the manual sort_order, then recency.
 * Falls back to the first story's media as a cover when no custom cover was set.
 */
router.get('/highlight/profile/:profile_id', optionalAuth, async (req, res) => {
    try {
        const profile_id = parseInt(req.params.profile_id);
        if (!Number.isInteger(profile_id)) return res.status(400).json({ successful: false, message: "Invalid profile." });

        const owner = await prisma.social_profile.findUnique({
            where: { profile_id },
            select: { user_id: true },
        });
        if (owner?.user_id && req.user?.user_id && await areUsersBlockedOnPlatform(req.user.user_id, owner.user_id)) {
            return res.status(404).json({ successful: false, message: "Profile not found." });
        }

        const highlights = await prisma.social_highlight.findMany({
            where: { profile_id },
            include: {
                _count: { select: { stories: true } },
                stories: { orderBy: { created_at: 'asc' }, take: 1, select: { media_url: true, media_type: true } }
            },
            orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }]
        });

        // Hide empty highlights from viewers (a highlight whose last story was removed) but keep the
        // shape stable: derive a display cover from the custom cover or the first story's media.
        const data = highlights
            .filter(h => h._count.stories > 0)
            .map(h => ({
                highlight_id: h.highlight_id,
                title: h.title,
                sort_order: h.sort_order,
                story_count: h._count.stories,
                cover_url: h.cover_url || h.stories[0]?.media_url || null,
                cover_is_video: !h.cover_url && h.stories[0]?.media_type === 'video',
                created_at: h.created_at
            }));

        res.json({ successful: true, data });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 7. REORDER HIGHLIGHTS
 * PATCH /social-story/highlight/reorder   body: { order: [highlight_id, ...] }
 * Registered BEFORE '/highlight/:id' so the literal path is not captured as an :id.
 */
router.patch('/highlight/reorder', authenticateToken, async (req, res) => {
    try {
        const profile_id = req.user.profile_id;
        if (!profile_id) return res.status(400).json({ successful: false, message: "Social profile not found." });

        const order = Array.isArray(req.body.order) ? req.body.order.map(id => parseInt(id)) : null;
        if (!order || order.some(id => !Number.isInteger(id))) {
            return res.status(400).json({ successful: false, message: "order must be an array of highlight ids." });
        }

        await prisma.$transaction(
            // Each update is scoped to the owner's profile, so a user can only reorder their own.
            order.map((highlight_id, idx) => prisma.social_highlight.updateMany({
                where: { highlight_id, profile_id },
                data: { sort_order: idx }
            }))
        );

        res.json({ successful: true });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 8. EDIT A HIGHLIGHT (title / cover)
 * PATCH /social-story/highlight/:id   multipart 'cover' file OR cover_url string, and/or title.
 */
router.patch('/highlight/:id', authenticateToken, upload.single('cover'), async (req, res) => {
    try {
        const highlight_id = parseInt(req.params.id);
        const profile_id = req.user.profile_id;
        if (!Number.isInteger(highlight_id)) return res.status(400).json({ successful: false, message: "Invalid highlight." });

        const existing = await prisma.social_highlight.findUnique({ where: { highlight_id }, select: { profile_id: true } });
        if (!existing) return res.status(404).json({ successful: false, message: "Highlight not found." });
        if (existing.profile_id !== profile_id) return res.status(403).json({ successful: false, message: "Not your highlight." });

        const data = {};
        if (typeof req.body.title === 'string') {
            const title = req.body.title.trim();
            if (!title) return res.status(400).json({ successful: false, message: "Title cannot be empty." });
            if (title.length > 50) return res.status(400).json({ successful: false, message: "Title must be 50 characters or fewer." });
            data.title = title;
        }
        const uploaded = await uploadCover(profile_id, req.file);
        if (uploaded) data.cover_url = uploaded;
        else if (typeof req.body.cover_url === 'string') {
            const raw = req.body.cover_url.trim();
            if (raw && !isAllowedHighlightCoverUrl(raw)) {
                return res.status(400).json({ successful: false, message: "cover_url must be a trusted stories blob URL." });
            }
            data.cover_url = raw || null;
        }

        if (!Object.keys(data).length) return res.status(400).json({ successful: false, message: "Nothing to update." });

        const updated = await prisma.social_highlight.update({ where: { highlight_id }, data });
        res.json({ successful: true, data: updated });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 9. DELETE A HIGHLIGHT
 * DELETE /social-story/highlight/:id
 * The highlight_id FK on social_story is optional, so deleting the highlight SetNulls each member
 * story's highlight_id (the stories themselves are untouched, still in the owner's archive).
 */
router.delete('/highlight/:id', authenticateToken, async (req, res) => {
    try {
        const highlight_id = parseInt(req.params.id);
        const profile_id = req.user.profile_id;
        if (!Number.isInteger(highlight_id)) return res.status(400).json({ successful: false, message: "Invalid highlight." });

        const existing = await prisma.social_highlight.findUnique({ where: { highlight_id }, select: { profile_id: true } });
        if (!existing) return res.status(404).json({ successful: false, message: "Highlight not found." });
        if (existing.profile_id !== profile_id) return res.status(403).json({ successful: false, message: "Not your highlight." });

        await prisma.$transaction([
            prisma.social_story.updateMany({ where: { highlight_id }, data: { highlight_id: null } }),
            prisma.social_highlight.delete({ where: { highlight_id } })
        ]);

        res.json({ successful: true });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 10. ADD STORIES TO A HIGHLIGHT
 * POST /social-story/highlight/:id/stories   body: { story_ids: [..] }
 */
router.post('/highlight/:id/stories', authenticateToken, async (req, res) => {
    try {
        const highlight_id = parseInt(req.params.id);
        const profile_id = req.user.profile_id;
        if (!Number.isInteger(highlight_id)) return res.status(400).json({ successful: false, message: "Invalid highlight." });

        const story_ids = parseStoryIds(req.body.story_ids);
        if (!story_ids.length) return res.status(400).json({ successful: false, message: "story_ids required." });

        const existing = await prisma.social_highlight.findUnique({ where: { highlight_id }, select: { profile_id: true } });
        if (!existing) return res.status(404).json({ successful: false, message: "Highlight not found." });
        if (existing.profile_id !== profile_id) return res.status(403).json({ successful: false, message: "Not your highlight." });

        // profile_id filter = a user can only add their OWN stories.
        const { count } = await prisma.social_story.updateMany({
            where: { story_id: { in: story_ids }, profile_id },
            data: { highlight_id }
        });

        res.json({ successful: true, added: count });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 11. REMOVE A STORY FROM A HIGHLIGHT
 * DELETE /social-story/highlight/:id/stories/:story_id
 * Detaches the story (SetNull) — it stays in the owner's archive, just no longer in the highlight.
 */
router.delete('/highlight/:id/stories/:story_id', authenticateToken, async (req, res) => {
    try {
        const highlight_id = parseInt(req.params.id);
        const story_id = parseInt(req.params.story_id);
        const profile_id = req.user.profile_id;
        if (!Number.isInteger(highlight_id) || !Number.isInteger(story_id)) {
            return res.status(400).json({ successful: false, message: "Invalid ids." });
        }

        const existing = await prisma.social_highlight.findUnique({ where: { highlight_id }, select: { profile_id: true } });
        if (!existing) return res.status(404).json({ successful: false, message: "Highlight not found." });
        if (existing.profile_id !== profile_id) return res.status(403).json({ successful: false, message: "Not your highlight." });

        const { count } = await prisma.social_story.updateMany({
            where: { story_id, highlight_id, profile_id },
            data: { highlight_id: null }
        });
        if (!count) return res.status(404).json({ successful: false, message: "Story not in this highlight." });

        res.json({ successful: true });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/**
 * 12. GET STORIES WITHIN A HIGHLIGHT (playback)
 * GET /social-story/highlight/:id
 */
router.get('/highlight/:id', optionalAuth, async (req, res) => {
    try {
        const highlight_id = parseInt(req.params.id);
        if (!Number.isInteger(highlight_id)) return res.status(400).json({ successful: false, message: "Invalid highlight." });

        const highlight = await prisma.social_highlight.findUnique({
            where: { highlight_id },
            include: {
                stories: { orderBy: { created_at: 'asc' } },
                social_profile: { select: { profile_id: true, user_id: true, handle: true, display_name: true, profile_pic_url: true, is_verified: true } }
            }
        });

        if (!highlight) return res.status(404).json({ successful: false, message: "Highlight not found." });
        if (highlight.social_profile?.user_id && req.user?.user_id && await areUsersBlockedOnPlatform(req.user.user_id, highlight.social_profile.user_id)) {
            return res.status(404).json({ successful: false, message: "Highlight not found." });
        }
        res.json({ successful: true, data: highlight });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

export default router;
