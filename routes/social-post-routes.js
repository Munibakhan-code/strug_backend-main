import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { clientErrorMessage } from '../utils/client-error.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { deleteAzureBlob } from '../utils/azure-cleanup.js';
import { profanityFilter } from '../middleware/profanity-filter.js';
import { socialPostRateLimiter } from '../middleware/social-rate-limiter.js';
import { uploadPublicBlob } from '../utils/azure-storage.js';
import { blockedGraphForUser } from '../utils/platform-blocks.js';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import sharp from 'sharp';

import { pushToSocialVideoQueue } from '../utils/azure-queue.js';
import { canViewerSeeAuthorPosts } from '../utils/social-visibility.js';


const router = express.Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit for high-quality content
    fileFilter: (req, file, cb) => {
        if (/^(image|video)\//.test(file.mimetype)) cb(null, true);
        else cb(new Error('Unsupported file type'));
    }
});

const createPostSchema = z.object({
    caption_text: z.string().max(2200).optional(),
    location_name: z.string().max(255).optional(),
    location_lat: z.coerce.number().optional().nullable(),
    location_long: z.coerce.number().optional().nullable(),
    status: z.enum(['published', 'draft', 'archived', 'under_review']).default('published'),
});

const optimizeAndConvertImage = async (buffer) => {
    return await sharp(buffer)
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
};



router.post('/create', authenticateToken, upload.array('media', 10), profanityFilter, socialPostRateLimiter, async (req, res) => {
    try {
        const validated = createPostSchema.safeParse(req.body);
        if (!validated.success) return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });

        const { caption_text, location_name, location_lat, location_long, status } = validated.data;
        const profile_id = req.user?.profile_id; 
        if (!profile_id) return res.status(400).json({ successful: false, message: "Social profile required." });

        const hashtags = caption_text?.match(/#\w+/g) || [];
        const uniqueHashtags = [...new Set(hashtags)];

        let queueJobs = [];
        const hasVideo = Array.isArray(req.files) && req.files.some((f) => f.mimetype?.startsWith('video'));
        // Videos cannot skip review via client `archived`/`published` (#1191).
        let resolvedStatus = status;
        if (hasVideo) {
            resolvedStatus = status === 'draft' ? 'draft' : 'under_review';
        }

        // Transaction for Atomic Post Creation
        const result = await prisma.$transaction(async (tx) => {
            const newPost = await tx.social_feed.create({
                data: { profile_id, caption_text, location_name, location_lat, location_long, status: resolvedStatus }
            });

            for (const tagName of uniqueHashtags) {
                await tx.social_tag.upsert({
                    where: { name: tagName },
                    update: { post_count: { increment: 1 } },
                    create: { name: tagName, post_count: 1 }
                });
            }

            let finalAttachments = [];

            // ✅ PRODUCTION CORRECTED FILE PROCESSING BLOCK:
            
            if (req.files && Array.isArray(req.files) && req.files.length > 0) {
                for (const [i, file] of req.files.entries()) {
                    const isVideo = file.mimetype.startsWith('video');
                    let uploadBuffer = file.buffer;
                    let mimeType = file.mimetype;
                    let blobName = '';
            
                    if (!isVideo) {
                        // 📸 PHOTOS / IMAGES: Sharp
                        uploadBuffer = await optimizeAndConvertImage(file.buffer);
                        mimeType = 'image/webp';
                        blobName = `${Date.now()}-${i}.webp`;
                    } else {
                        // 🎥 VIDEOS: Worker  HLS 
                        const ext = path.extname(file.originalname) || '.mp4';
                        blobName = `raw-${Date.now()}-${i}${ext}`;
                    }
            
                    let azureUrl = '';
                    try {
                        azureUrl = await uploadPublicBlob(
                            process.env.AZURE_SOCIAL_POSTS_CONTAINER || 'social-posts',
                            blobName,
                            uploadBuffer,
                            mimeType
                        );
                    } catch (uploadErr) {
                        console.error('[uploadPublicBlob] Azure upload failed:', uploadErr.message);
                        throw uploadErr;
                    }
            
                    const createdAtt = await tx.social_media_attachments.create({
                        data: {
                            social_post_id: newPost.social_post_id,
                            media_url: azureUrl,
                            media_type: isVideo ? 'video' : 'image',
                            sequence_order: i + 1
                        }
                    });
            
                    //  Dedicated ACA Worker Queue  Handoff 
                    if (isVideo) {
                        queueJobs.push({
                            attachmentId: createdAtt.attachment_id,
                            postId: newPost.social_post_id,
                            blobName: blobName,
                            container: process.env.AZURE_SOCIAL_POSTS_CONTAINER || 'social-posts'
                        });
                    }
            
                    finalAttachments.push(createdAtt);
                }
            }

            return {
                ...newPost,
                social_media_attachments: finalAttachments
            };
        });

        // ✅ FAIL-SAFE QUEUE HANDOFF: Queue failure will not throw 500 or break test environments
        if (queueJobs && queueJobs.length > 0) {
            for (const job of queueJobs) {
                try {
                    await pushToSocialVideoQueue(
                        job.attachmentId,
                        job.postId,
                        job.blobName,
                        job.container
                    );
                } catch (queueErr) {
                    console.warn(`⚠️ [Queue Handoff Warning] Attachment #${job.attachmentId}:`, queueErr.message);
                }
            }
        }

        res.status(201).json({ successful: true, data: result });
    } catch (err) {
        console.error("Post Creation Error:", err);
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

router.get('/', optionalAuth, async (req, res) => {
    try {
        const userId = parseInt(req.query.user_id);
        if (!userId || isNaN(userId)) {
            return res.status(400).json({ successful: false, message: "user_id query param required" });
        }

        const profile = await prisma.social_profile.findFirst({
            where: { user_id: userId },
            select: { profile_id: true, is_private: true }
        });

        if (!profile) return res.json({ successful: true, data: [] });

        const viewerProfileId = req.user?.profile_id ?? null;
        if (req.user?.user_id) {
            const blockedGraph = await blockedGraphForUser(req.user.user_id);
            if (blockedGraph.profileIds.map(Number).includes(Number(profile.profile_id))) {
                return res.json({ successful: true, data: [] });
            }
        }

        const canSee = await canViewerSeeAuthorPosts(viewerProfileId, profile.profile_id);
        if (!canSee) {
            return res.json({ successful: true, data: [], private: !!profile.is_private });
        }

        const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
        const posts = await prisma.social_feed.findMany({
            where: { profile_id: profile.profile_id, status: 'published' },
            include: {
                social_media_attachments: { orderBy: { sequence_order: 'asc' } },
                social_profile: { select: { handle: true, display_name: true, profile_pic_url: true, is_verified: true } },
                _count: { select: { social_comments: true, social_interactions: true } },
                ...(viewerProfileId ? {
                    social_interactions: { where: { profile_id: viewerProfileId, reaction_type: 'like' }, select: { interaction_id: true } },
                    bookmarks:           { where: { profile_id: viewerProfileId }, select: { bookmark_id: true } },
                } : {}),
            },
            orderBy: { created_at: 'desc' },
            take,
        });

        const data = posts.map(p => ({
            ...p,
            liked: viewerProfileId ? (p.social_interactions?.length > 0) : false,
            saved: viewerProfileId ? (p.bookmarks?.length > 0) : false,
        }));

        res.json({ successful: true, data });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

router.get('/me/drafts', authenticateToken, async (req, res) => {
    try {
        const drafts = await prisma.social_feed.findMany({
            where: { profile_id: req.user.profile_id, status: 'draft' },
            include: { social_media_attachments: true },
            orderBy: { created_at: 'desc' }
        });
        res.json({ successful: true, data: drafts });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

router.get('/:id', optionalAuth, async (req, res) => {
    try {
        // This is the catch-all GET, so any unmatched path lands here as ":id" — GET /social-post/mine
        // (a route that does not exist) parsed to NaN, Prisma threw on the NaN lookup, and the client
        // got a 500 that read like the post pipeline was broken. A non-numeric id is a bad request,
        // not a server fault: say so.
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({ successful: false, message: 'Invalid post id' });
        }

        let viewerProfileId = null;
        const token = req.headers['authorization']?.split(' ')[1];
        if (token) {
            try {
                const jwt = (await import('jsonwebtoken')).default;
                const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_KEY);
                const viewer = await prisma.social_profile.findFirst({
                    where: { user_id: decoded.user_id },
                    select: { profile_id: true }
                });
                viewerProfileId = viewer?.profile_id ?? null;
            } catch { /* ignore */ }
        }

        const post = await prisma.social_feed.findUnique({
            where: { social_post_id: id },
            include: {
                social_media_attachments: { orderBy: { sequence_order: 'asc' } },
                social_profile: { select: { handle: true, display_name: true, profile_pic_url: true, is_verified: true, user_id: true } },
                _count: { select: { social_comments: true, social_interactions: true } },
                ...(viewerProfileId ? {
                    social_interactions: { where: { profile_id: viewerProfileId, reaction_type: 'like' }, select: { interaction_id: true } },
                    bookmarks: { where: { profile_id: viewerProfileId }, select: { bookmark_id: true } },
                } : {}),
            }
        });

        if (!post) return res.status(404).json({ successful: false, message: "Post not found" });

        if (req.user?.user_id && post.profile_id !== req.user.profile_id) {
            const blockedGraph = await blockedGraphForUser(req.user.user_id);
            if (blockedGraph.profileIds.map(Number).includes(Number(post.profile_id))) {
                return res.status(404).json({ successful: false, message: "Post not found" });
            }
        }

        if (post.status !== 'published') {
            if (!viewerProfileId || viewerProfileId !== post.profile_id) {
                return res.status(404).json({ successful: false, message: "Post not found" });
            }
        } else {
            const canSee = await canViewerSeeAuthorPosts(viewerProfileId, post.profile_id);
            if (!canSee) {
                return res.status(404).json({ successful: false, message: "Post not found" });
            }
        }

        res.json({
            successful: true,
            data: {
                ...post,
                liked: viewerProfileId ? (post.social_interactions?.length > 0) : false,
                saved: viewerProfileId ? (post.bookmarks?.length > 0) : false,
            },
        });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

router.patch('/:id/archive', authenticateToken, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id);
        const post = await prisma.social_feed.findFirst({
            where: { social_post_id: post_id, profile_id: req.user.profile_id }
        });

        if (!post) return res.status(404).json({ message: "Post not found or unauthorized" });
        if (post.status === 'under_review') {
            return res.status(400).json({ successful: false, message: "Post is awaiting review." });
        }

        const videoAtt = await prisma.social_media_attachments.findFirst({
            where: { social_post_id: post_id, media_type: 'video' },
            select: { attachment_id: true },
        });
        let newStatus;
        if (post.status === 'archived') {
            newStatus = videoAtt ? 'under_review' : 'published';
        } else {
            newStatus = 'archived';
        }
        await prisma.social_feed.update({
            where: { social_post_id: post_id },
            data: { status: newStatus }
        });

        res.json({ successful: true, message: `Post ${newStatus} successfully` });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

router.get('/system/fix-sequence', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await prisma.$executeRawUnsafe(`SELECT setval('social_media_attachments_attachment_id_seq', (SELECT MAX(attachment_id) FROM social_media_attachments));`);
        await prisma.$executeRawUnsafe(`SELECT setval('social_feed_social_post_id_seq', (SELECT MAX(social_post_id) FROM social_feed));`);
        res.json({ successful: true, message: "Database sequences synchronized!" });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

router.put('/:id', authenticateToken, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id);
        const profile_id = req.user.profile_id;
        const { caption_text } = req.body;

        const post = await prisma.social_feed.findFirst({
            where: { social_post_id: post_id, profile_id }
        });

        if (!post) return res.status(404).json({ successful: false, message: "Post not found or unauthorized" });

        const updated = await prisma.social_feed.update({
            where: { social_post_id: post_id },
            data: { caption_text }
        });

        res.json({ successful: true, post: updated });
    } catch (err) {
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id);
        const profile_id = req.user.profile_id;

        const post = await prisma.social_feed.findFirst({
            where: { social_post_id: post_id, profile_id },
            include: { social_media_attachments: true }
        });

        if (!post) return res.status(404).json({ message: "Post not found or unauthorized" });

        for (const attachment of post.social_media_attachments) {
            await deleteAzureBlob(process.env.AZURE_SOCIAL_POSTS_CONTAINER, attachment.media_url);
        }

        await prisma.$transaction([
            prisma.social_interactions.deleteMany({ where: { social_post_id: post_id } }),
            prisma.social_comments.deleteMany({ where: { social_post_id: post_id } }),
            prisma.social_bookmark.deleteMany({ where: { social_post_id: post_id } }),
            prisma.social_media_attachments.deleteMany({ where: { social_post_id: post_id } }),
            prisma.social_feed.delete({ where: { social_post_id: post_id } })
        ]);

        res.json({ successful: true, message: "Post and cloud assets deleted permanently." });
    } catch (err) {
        res.status(500).json({ error: clientErrorMessage(err) });
    }
});

router.patch('/:id/sensitive', authenticateToken, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id);
        const profile_id = req.user.profile_id;

        const post = await prisma.social_feed.findFirst({
            where: { social_post_id: post_id, profile_id }
        });

        if (!post) return res.status(404).json({ message: "Post not found or unauthorized" });

        const updated = await prisma.social_feed.update({
            where: { social_post_id: post_id },
            data: { is_sensitive: !post.is_sensitive }
        });

        res.json({ successful: true, is_sensitive: updated.is_sensitive });
    } catch (err) { res.status(500).json({ successful: false, message: 'Internal server error' }); }
});

router.post('/:id/bookmark', authenticateToken, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id);
        const profile_id = req.user.profile_id;

        if (isNaN(post_id) || !profile_id) {
            return res.status(400).json({ successful: false, message: "Invalid Post ID or Profile ID" });
        }

        const post = await prisma.social_feed.findUnique({
            where: { social_post_id: post_id },
            select: { profile_id: true, status: true },
        });
        if (!post) return res.status(404).json({ successful: false, message: "Post not found" });
        if (post.status !== 'published' && post.profile_id !== profile_id) {
            return res.status(404).json({ successful: false, message: "Post not found" });
        }
        const canSee = await canViewerSeeAuthorPosts(profile_id, post.profile_id);
        if (!canSee) return res.status(404).json({ successful: false, message: "Post not found" });

        const existingBookmark = await prisma.social_bookmark.findFirst({
            where: { 
                social_post_id: post_id,
                profile_id: profile_id 
            }
        });

        if (existingBookmark) {
            await prisma.social_bookmark.deleteMany({
                where: { 
                    social_post_id: post_id,
                    profile_id: profile_id 
                }
            });
            
            return res.json({ successful: true, saved: false, message: "Removed from bookmarks" });
        } else {
            await prisma.social_bookmark.create({
                data: { 
                    social_post_id: post_id,
                    profile_id: profile_id 
                }
            });
            
            return res.json({ successful: true, saved: true, message: "Added to bookmarks" });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

export default router;
